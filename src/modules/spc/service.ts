import type { Actor } from '../../platform/auth/actor.js';
import { can, requirePermission } from '../../platform/auth/actor.js';
import { audit } from '../../platform/audit/audit.js';
import type { Tx } from '../../platform/db/tx.js';
import { many, one } from '../../platform/db/tx.js';
import { conflict, invalid, notFound } from '../../platform/errors.js';
import { notify, usersWithPermission } from '../../platform/notify/notify.js';
import { createNcr } from '../quality/service.js';
import type { AttributeChart, Limits } from './engine.js';
import { DEFAULT_RULES, MIN_SUBGROUPS_FOR_CAPABILITY, MIN_SUBGROUPS_FOR_LIMITS, RULES, attributeCenter, attributePoint, capability, computeLimits, evaluate, evaluateAttribute, points } from './engine.js';

const SUBJECT = 'spc_characteristic';
const num = (v: any) => (v == null ? null : Number(v));
const iso = (d: any) => (d instanceof Date ? d.toISOString() : String(d));
export const RULE_LABEL: Record<string, string> = Object.fromEntries(RULES.map((r) => [r.key, r.label]));

// ---------------------------------------------------------------------------
// Rules in force (D-156): the company's set, or the characteristic's own
// ---------------------------------------------------------------------------

export async function spcSettings(tx: Tx) {
  const r = await one(tx, 'SELECT s.*, u.display_name AS updated_by_name FROM spc_settings s JOIN app_user u ON u.id = s.updated_by');
  return { rules: (r?.rules as string[] | undefined) ?? [...DEFAULT_RULES], notifyEachAlarm: r?.notify_each_alarm ?? true, updatedAt: r?.updated_at ?? null, updatedBy: r?.updated_by_name ?? null };
}
const rulesOf = async (tx: Tx, c: { rules?: string[] | null }) => new Set<string>(c.rules ?? (await spcSettings(tx)).rules);
const checkRules = (rules: string[]) => {
  const known = new Set(RULES.map((r) => r.key as string));
  const bad = rules.filter((r) => !known.has(r));
  if (bad.length) throw invalid(`unknown rule ${bad.join(', ')}`);
  if (!rules.length) throw invalid('keep at least one rule on');
  return [...new Set(rules)];
};

export async function getSpcSettings(tx: Tx, actor: Actor) {
  requirePermission(actor, 'quality.view');
  return { ...(await spcSettings(tx)), catalogue: RULES, defaults: DEFAULT_RULES, canEdit: can(actor, 'quality.manage') };
}

export async function saveSpcSettings(tx: Tx, actor: Actor, input: { rules: string[]; notifyEachAlarm: boolean }) {
  requirePermission(actor, 'quality.manage');
  const rules = checkRules(input.rules);
  const prior = await spcSettings(tx);
  await tx.query(`INSERT INTO spc_settings (tenant_id, rules, notify_each_alarm, updated_by) VALUES ($1, $2, $3, $4)
    ON CONFLICT (tenant_id) DO UPDATE SET rules = EXCLUDED.rules, notify_each_alarm = EXCLUDED.notify_each_alarm, updated_by = EXCLUDED.updated_by, updated_at = now()`,
  [actor.tenantId, rules, input.notifyEachAlarm, actor.userId]);
  await audit(tx, actor, { action: 'spc.rules_set', entityType: 'spc_settings', entityId: actor.tenantId, data: { from: { rules: prior.rules, notifyEachAlarm: prior.notifyEachAlarm }, to: { rules, notifyEachAlarm: input.notifyEachAlarm } } });
}

/** A characteristic's own rules (null: the company's). */
export async function setCharacteristicRules(tx: Tx, actor: Actor, id: string, rules: string[] | null) {
  const c = await one(tx, 'SELECT id, code, facility_id, rules FROM spc_characteristic WHERE id = $1', [id]);
  if (!c) throw notFound('characteristic');
  requirePermission(actor, 'quality.manage', c.facility_id);
  const next = rules ? checkRules(rules) : null;
  await tx.query('UPDATE spc_characteristic SET rules = $2 WHERE id = $1', [id, next]);
  await audit(tx, actor, { action: 'spc.characteristic_rules_set', entityType: SUBJECT, entityId: id, facilityId: c.facility_id, data: { from: c.rules, to: next } });
}

/** Alarms over the last `days` per site: new by rule and characteristic, still open with the oldest, and characteristics not measured for `silentDays`. */
export async function alarmSummary(tx: Tx, q: { days: number; silentDays: number; facilityId?: string | null }) {
  const fresh = await many(tx, `SELECT s.facility_id, f.code AS facility_code, s.rule, c.code, c.name, count(*)::int AS n FROM spc_signal s JOIN spc_characteristic c ON c.id = s.characteristic_id
    JOIN facility f ON f.id = s.facility_id WHERE s.created_at > now() - make_interval(days => $1) AND ($2::uuid IS NULL OR s.facility_id = $2)
    GROUP BY s.facility_id, f.code, s.rule, c.code, c.name ORDER BY f.code, n DESC, c.code`, [q.days, q.facilityId ?? null]);
  const open = await many(tx, `SELECT s.facility_id, count(*)::int AS n, count(DISTINCT s.characteristic_id)::int AS chars, min(s.created_at) AS oldest FROM spc_signal s
    WHERE s.status = 'open' AND ($1::uuid IS NULL OR s.facility_id = $1) GROUP BY s.facility_id`, [q.facilityId ?? null]);
  const silent = await many(tx, `SELECT c.facility_id, c.code, c.name, (SELECT max(measured_at) FROM spc_subgroup g WHERE g.characteristic_id = c.id) AS last FROM spc_characteristic c
    WHERE c.active AND c.created_at < now() - make_interval(days => $1) AND ($2::uuid IS NULL OR c.facility_id = $2)
      AND NOT EXISTS (SELECT 1 FROM spc_subgroup g WHERE g.characteristic_id = c.id AND g.measured_at > now() - make_interval(days => $1)) ORDER BY c.code`, [q.silentDays, q.facilityId ?? null]);
  const sites = await many(tx, `SELECT DISTINCT c.facility_id, f.code FROM spc_characteristic c JOIN facility f ON f.id = c.facility_id WHERE c.active AND ($1::uuid IS NULL OR c.facility_id = $1) ORDER BY f.code`, [q.facilityId ?? null]);
  return sites.map((site) => {
    const mine = fresh.filter((x) => x.facility_id === site.facility_id);
    const o = open.find((x) => x.facility_id === site.facility_id);
    const byRule = new Map<string, number>();
    for (const x of mine) byRule.set(x.rule, (byRule.get(x.rule) ?? 0) + x.n);
    return {
      facilityId: site.facility_id as string, facilityCode: site.code as string,
      newAlarms: mine.reduce((t, x) => t + x.n, 0), newCharacteristics: new Set(mine.map((x) => x.code)).size,
      byRule: [...byRule].map(([rule, n]) => ({ rule, label: RULE_LABEL[rule] ?? rule, n })).sort((a, b) => b.n - a.n),
      byCharacteristic: mine.map((x) => ({ code: x.code, name: x.name, rule: RULE_LABEL[x.rule] ?? x.rule, n: x.n })),
      open: o?.n ?? 0, openCharacteristics: o?.chars ?? 0, oldestOpenDays: o ? Math.floor((Date.now() - new Date(o.oldest).getTime()) / 86_400_000) : null,
      silent: silent.filter((x) => x.facility_id === site.facility_id).map((x) => ({ code: x.code, name: x.name, last: x.last })),
    };
  });
}

/** The summary in one sentence, answer first (used by the daily reminder and the SPC page). */
export function summarySentence(s: { newAlarms: number; newCharacteristics: number; open: number; oldestOpenDays: number | null; silent: unknown[] }, period: string) {
  const parts = [s.newAlarms ? `${s.newAlarms} new alarm${s.newAlarms === 1 ? '' : 's'} ${period} on ${s.newCharacteristics} characteristic${s.newCharacteristics === 1 ? '' : 's'}` : `no new alarms ${period}`];
  parts.push(s.open ? `${s.open} still open, oldest ${s.oldestOpenDays} day${s.oldestOpenDays === 1 ? '' : 's'}` : 'none open');
  if (s.silent.length) parts.push(`${s.silent.length} not measured recently`);
  return parts.join('; ');
}

// ---------------------------------------------------------------------------
// Characteristics
// ---------------------------------------------------------------------------

export interface CharacteristicInput {
  id?: string; facilityId: string; code: string; name: string; partId?: string | null; opNo?: number | null; workCenterId?: string | null; assetId?: string | null;
  gaugeAssetId?: string | null; unit?: string; nominal?: number | null; lsl?: number | null; usl?: number | null; subgroupSize: number; frequency?: string | null; active?: boolean;
  /** variables (measurements, default) or an attribute chart: p, np, c, u. */
  chartType?: 'variables' | AttributeChart; sampleSize?: number | null;
}
export const ATTRIBUTE_LABEL: Record<string, { what: string; unit: string }> = {
  p: { what: 'fraction defective', unit: 'defective' }, np: { what: 'number defective', unit: 'defective' }, c: { what: 'defects per inspection unit', unit: 'defects' }, u: { what: 'defects per unit', unit: 'defects' },
};
const isAttr = (c: { chart_type?: string }) => !!c.chart_type && c.chart_type !== 'variables';

export async function saveCharacteristic(tx: Tx, actor: Actor, input: CharacteristicInput) {
  requirePermission(actor, 'quality.manage', input.facilityId);
  if (!input.code?.trim() || !input.name?.trim()) throw invalid('give the characteristic a code and a name');
  const chartType = input.chartType ?? 'variables';
  if (chartType !== 'variables') {
    input = { ...input, subgroupSize: 1, nominal: null, lsl: null, usl: null };
    if (chartType === 'np' && !(input.sampleSize && input.sampleSize > 0)) throw invalid('an np chart needs the fixed number of parts inspected in each sample');
  }
  if (!(Number.isInteger(input.subgroupSize) && input.subgroupSize >= 1 && input.subgroupSize <= 10)) throw invalid('subgroup size must be 1 (single readings) to 10');
  if (input.lsl != null && input.usl != null && !(input.lsl < input.usl)) throw invalid('the lower tolerance must be below the upper');
  if (input.nominal != null && ((input.lsl != null && input.nominal < input.lsl) || (input.usl != null && input.nominal > input.usl))) throw invalid('the nominal must be inside the tolerance');
  for (const [id, what] of [[input.assetId, 'machine'], [input.gaugeAssetId, 'gauge']] as const) {
    if (id && !(await one(tx, 'SELECT 1 FROM asset WHERE id = $1 AND facility_id = $2', [id, input.facilityId]))) throw invalid(`the ${what} is not at this site`);
  }
  if (input.workCenterId && !(await one(tx, 'SELECT 1 FROM work_center WHERE id = $1 AND facility_id = $2', [input.workCenterId, input.facilityId]))) throw invalid('the work center is not at this site');
  const vals = [input.code.trim(), input.name.trim(), input.partId ?? null, input.opNo ?? null, input.workCenterId ?? null, input.assetId ?? null, input.gaugeAssetId ?? null,
    input.unit?.trim() || (chartType === 'variables' ? 'mm' : ATTRIBUTE_LABEL[chartType]!.unit), input.nominal ?? null, input.lsl ?? null, input.usl ?? null, input.subgroupSize, input.frequency ?? null,
    input.active ?? true, chartType, input.sampleSize ?? null];
  let c;
  if (input.id) {
    const old = await one(tx, 'SELECT * FROM spc_characteristic WHERE id = $1 FOR UPDATE', [input.id]);
    if (!old || old.facility_id !== input.facilityId) throw notFound('characteristic');
    if ((old.subgroup_size !== input.subgroupSize || old.chart_type !== chartType || (chartType === 'np' && Number(old.sample_size) !== input.sampleSize))
      && (await one(tx, 'SELECT 1 FROM spc_subgroup WHERE characteristic_id = $1', [input.id]))) {
      throw conflict('the chart type, subgroup size and sample size cannot change once measurements are recorded; set up a new characteristic');
    }
    c = await one(tx, `UPDATE spc_characteristic SET code = $2, name = $3, part_id = $4, op_no = $5, work_center_id = $6, asset_id = $7, gauge_asset_id = $8, unit = $9,
      nominal = $10, lsl = $11, usl = $12, subgroup_size = $13, frequency = $14, active = $15, chart_type = $16, sample_size = $17 WHERE id = $1 RETURNING *`, [input.id, ...vals]);
  } else {
    if (await one(tx, 'SELECT 1 FROM spc_characteristic WHERE code = $1', [input.code.trim()])) throw conflict(`characteristic ${input.code} already exists`);
    c = await one(tx, `INSERT INTO spc_characteristic (tenant_id, facility_id, code, name, part_id, op_no, work_center_id, asset_id, gauge_asset_id, unit, nominal, lsl, usl, subgroup_size,
      frequency, active, chart_type, sample_size, created_by) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19) RETURNING *`,
    [actor.tenantId, input.facilityId, ...vals, actor.userId]);
  }
  await audit(tx, actor, { action: input.id ? 'spc.characteristic_updated' : 'spc.characteristic_created', entityType: SUBJECT, entityId: c.id, facilityId: c.facility_id,
    data: { code: c.code, chartType, lsl: input.lsl ?? null, usl: input.usl ?? null, subgroupSize: input.subgroupSize, sampleSize: input.sampleSize ?? null } });
  return c;
}

/**
 * The gauge must have been in calibration when the measurement was taken: the calibration in force at that time (the
 * latest record on or before it, else the plan) was not failed and not past its due date.
 */
async function assertGaugeAt(tx: Tx, gaugeId: string, at: Date) {
  const day = at.toISOString().slice(0, 10);
  const plan = await one(tx, `SELECT p.next_due, a.asset_tag FROM calibration_plan p JOIN asset a ON a.id = p.asset_id WHERE p.asset_id = $1 AND p.active`, [gaugeId]);
  if (!plan) return;
  const rec = await one(tx, `SELECT next_due, as_left FROM calibration_record WHERE asset_id = $1 AND performed_on <= $2 ORDER BY performed_on DESC, created_at DESC LIMIT 1`, [gaugeId, day]);
  const due = rec ? rec.next_due : plan.next_due;
  if (rec?.as_left === 'failed' || due == null) throw conflict(`${plan.asset_tag} failed calibration; measure with a calibrated gauge`);
  const dueStr = due instanceof Date ? due.toISOString().slice(0, 10) : String(due).slice(0, 10);
  if (dueStr < day) throw conflict(`${plan.asset_tag} was overdue for calibration on ${day} (due ${dueStr}); calibrate it before measuring with it`);
}

// ---------------------------------------------------------------------------
// Measurements and signals
// ---------------------------------------------------------------------------

async function limitsInForce(tx: Tx, characteristicId: string) {
  const l = await one(tx, `SELECT l.*, u.display_name AS set_by_name FROM spc_limit l JOIN app_user u ON u.id = l.set_by WHERE characteristic_id = $1 ORDER BY set_at DESC LIMIT 1`, [characteristicId]);
  if (!l) return null;
  return { id: l.id as string, center: num(l.center)!, ucl: num(l.ucl)!, lcl: num(l.lcl)!, rangeCenter: num(l.range_center)!, rangeUcl: num(l.range_ucl)!, rangeLcl: num(l.range_lcl)!,
    sigma: num(l.sigma)!, subgroups: l.subgroups as number, fromAt: iso(l.from_at), toAt: iso(l.to_at), reason: l.reason as string, setBy: l.set_by_name as string, setAt: iso(l.set_at) };
}

export async function recordSubgroup(tx: Tx, actor: Actor, characteristicId: string,
  input: { values: number[]; sampleSize?: number | null; measuredAt?: Date; productionOrderId?: string | null; lot?: string | null; note?: string | null; source?: 'manual' | 'import' }) {
  const c = await one(tx, 'SELECT * FROM spc_characteristic WHERE id = $1', [characteristicId]);
  if (!c) throw notFound('characteristic');
  requirePermission(actor, 'quality.report', c.facility_id);
  if (!c.active) throw conflict(`${c.code} is no longer measured`);
  let n: number | null = null;
  if (isAttr(c)) {
    const count = input.values[0];
    if (input.values.length !== 1 || count == null || !Number.isInteger(count) || count < 0) throw invalid('record the count found in the sample (a whole number, 0 or more)');
    const fixed = num(c.sample_size);
    if (c.chart_type === 'np' || c.chart_type === 'c') {
      if (input.sampleSize != null && fixed != null && input.sampleSize !== fixed) throw invalid(`${c.code} uses a fixed sample of ${fixed}; for samples that vary use a ${c.chart_type === 'np' ? 'p' : 'u'} chart`);
      n = fixed ?? 1;
    } else {
      if (!(input.sampleSize && input.sampleSize > 0)) throw invalid(`say how many ${c.chart_type === 'p' ? 'parts were inspected' : 'units were inspected'} in the sample`);
      n = input.sampleSize;
    }
    if ((c.chart_type === 'p' || c.chart_type === 'np') && count > n) throw invalid(`${count} defective is more than the ${n} inspected`);
  } else if (input.values.length !== c.subgroup_size) throw invalid(`${c.code} is measured ${c.subgroup_size === 1 ? 'one reading at a time' : `in subgroups of ${c.subgroup_size}`}; got ${input.values.length} value${input.values.length === 1 ? '' : 's'}`);
  if (input.values.some((v) => !Number.isFinite(v))) throw invalid('every value must be a number');
  const at = input.measuredAt ?? new Date();
  if (at.getTime() > Date.now() + 5 * 60_000) throw invalid('the measurement time is in the future');
  if (c.gauge_asset_id) await assertGaugeAt(tx, c.gauge_asset_id, at);
  if (input.productionOrderId && !(await one(tx, 'SELECT 1 FROM production_order WHERE id = $1 AND facility_id = $2', [input.productionOrderId, c.facility_id]))) {
    throw invalid('production order not found at this site');
  }
  const s = await one(tx, `INSERT INTO spc_subgroup (tenant_id, facility_id, characteristic_id, measured_at, vals, sample_size, production_order_id, lot, note, source, recorded_by)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING id, measured_at`,
  [actor.tenantId, c.facility_id, c.id, at, input.values, n, input.productionOrderId ?? null, input.lot?.trim() || null, input.note?.trim() || null, input.source ?? 'manual', actor.userId]);

  // Signals: tolerance always; control-chart rules only against limits set from a baseline, for points after it.
  const found: { rule: string; chart: string; detail: string }[] = [];
  const lsl = num(c.lsl); const usl = num(c.usl);
  const outside = input.values.filter((v) => (usl != null && v > usl) || (lsl != null && v < lsl));
  const rules = await rulesOf(tx, c);
  if (outside.length && rules.has('out_of_spec')) found.push({ rule: 'out_of_spec', chart: 'spec', detail: `${outside.length} of ${input.values.length} outside the tolerance ${lsl ?? '−∞'} to ${usl ?? '+∞'} ${c.unit} (${outside.join(', ')})` });
  const L = await limitsInForce(tx, c.id);
  if (L && at > new Date(L.toAt) && isAttr(c)) {
    const series = await many(tx, `SELECT id, vals, sample_size::float AS n FROM (SELECT id, vals, sample_size, measured_at, created_at FROM spc_subgroup WHERE characteristic_id = $1 AND NOT excluded
      AND measured_at <= $2 ORDER BY measured_at DESC, created_at DESC LIMIT 30) x ORDER BY measured_at, created_at`, [c.id, at]);
    const pts = series.map((r) => attributePoint(c.chart_type, L.center, { count: Number(r.vals[0]), n: r.n }, num(c.sample_size) ?? undefined));
    const idx = series.findIndex((x) => x.id === s.id);
    for (const sig of evaluateAttribute(pts, idx, rules)) if (sig.index === idx) found.push(sig);
  } else if (L && at > new Date(L.toAt)) {
    const series = (await many(tx, `SELECT id, vals FROM (SELECT id, vals, measured_at, created_at FROM spc_subgroup WHERE characteristic_id = $1 AND NOT excluded AND measured_at <= $2
      ORDER BY measured_at DESC, created_at DESC LIMIT 30) x ORDER BY measured_at, created_at`, [c.id, at])).map((r) => ({ id: r.id as string, vals: (r.vals as any[]).map(Number) }));
    const p = points(series.map((x) => x.vals));
    const idx = series.findIndex((x) => x.id === s.id);
    for (const sig of evaluate(p.x, p.r, L, idx, rules)) if (sig.index === idx) found.push(sig);
  }
  for (const f of found) {
    await tx.query(`INSERT INTO spc_signal (tenant_id, facility_id, characteristic_id, subgroup_id, rule, chart, detail) VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT DO NOTHING`,
      [actor.tenantId, c.facility_id, c.id, s.id, f.rule, f.chart, f.detail]);
  }
  // Instant notice per alarm unless the company relies on the daily summary instead (D-156).
  if (found.length && (await spcSettings(tx)).notifyEachAlarm) {
    await notify(tx, actor.tenantId, await usersWithPermission(tx, 'quality.manage', c.facility_id), { kind: 'spc.signal',
      title: `${c.code} ${c.name}: ${found.map((f) => RULE_LABEL[f.rule]).join(', ')}`, body: found.map((f) => f.detail).join('; '), link: `/quality/spc/${c.id}`,
      subjectType: SUBJECT, subjectId: c.id, dedupeKey: `spc:${s.id}` }, actor.userId);
  }
  await audit(tx, actor, { action: 'spc.measured', entityType: SUBJECT, entityId: c.id, facilityId: c.facility_id, data: { subgroup: s.id, values: input.values, signals: found.map((f) => f.rule) } });
  return { id: s.id as string, signals: found };
}

/** An assignable cause was found: the subgroup stays on the chart but leaves limit and capability calculations. */
export async function excludeSubgroup(tx: Tx, actor: Actor, subgroupId: string, reason: string) {
  const s = await one(tx, 'SELECT * FROM spc_subgroup WHERE id = $1 FOR UPDATE', [subgroupId]);
  if (!s) throw notFound('subgroup');
  requirePermission(actor, 'quality.manage', s.facility_id);
  if (!reason?.trim() || reason.trim().length < 5) throw invalid('say why the subgroup is excluded (the assignable cause or the error)');
  if (s.excluded) throw conflict('already excluded');
  await tx.query('UPDATE spc_subgroup SET excluded = true, exclude_reason = $2 WHERE id = $1', [subgroupId, reason.trim()]);
  await audit(tx, actor, { action: 'spc.subgroup_excluded', entityType: SUBJECT, entityId: s.characteristic_id, facilityId: s.facility_id, data: { subgroup: subgroupId, reason: reason.trim() } });
}

/** Attribute limits in the shape stored for every chart: center, limits at the average sample size, no range chart. */
function attributeLimits(c: any, samples: { count: number; n: number }[]): Limits {
  const center = attributeCenter(c.chart_type, samples);
  const avgN = samples.reduce((t, x) => t + x.n, 0) / samples.length;
  const p = attributePoint(c.chart_type, center, { count: 0, n: avgN }, num(c.sample_size) ?? undefined);
  return { center: Math.round(center * 1e6) / 1e6, ucl: p.ucl, lcl: p.lcl, rangeCenter: 0, rangeUcl: 0, rangeLcl: 0, sigma: Math.round(p.sigma * 1e8) / 1e8, subgroups: samples.length };
}

/** Sets control limits from a baseline of included subgroups (default: all of them). Earlier limits are kept as history. */
export async function setLimits(tx: Tx, actor: Actor, characteristicId: string, input: { from?: Date | null; to?: Date | null; reason: string }) {
  const c = await one(tx, 'SELECT * FROM spc_characteristic WHERE id = $1 FOR UPDATE', [characteristicId]);
  if (!c) throw notFound('characteristic');
  requirePermission(actor, 'quality.manage', c.facility_id);
  if (!input.reason?.trim()) throw invalid('say why the limits are set (initial study, process change, new tooling…)');
  const rows = await many(tx, `SELECT vals, sample_size::float AS n, measured_at FROM spc_subgroup WHERE characteristic_id = $1 AND NOT excluded AND ($2::timestamptz IS NULL OR measured_at >= $2)
    AND ($3::timestamptz IS NULL OR measured_at <= $3) ORDER BY measured_at, created_at`, [c.id, input.from ?? null, input.to ?? null]);
  if (rows.length < MIN_SUBGROUPS_FOR_LIMITS) throw invalid(`limits need at least ${MIN_SUBGROUPS_FOR_LIMITS} included subgroups in the baseline; there are ${rows.length}`);
  const L = isAttr(c) ? attributeLimits(c, rows.map((r) => ({ count: Number(r.vals[0]), n: r.n }))) : computeLimits(rows.map((r) => (r.vals as any[]).map(Number)), c.subgroup_size);
  const fromAt = rows[0].measured_at; const toAt = rows[rows.length - 1].measured_at;
  const l = await one(tx, `INSERT INTO spc_limit (tenant_id, characteristic_id, center, ucl, lcl, range_center, range_ucl, range_lcl, sigma, subgroups, from_at, to_at, reason, set_by)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14) RETURNING id`,
  [actor.tenantId, c.id, L.center, L.ucl, L.lcl, L.rangeCenter, L.rangeUcl, L.rangeLcl, L.sigma, L.subgroups, fromAt, toAt, input.reason.trim(), actor.userId]);
  await audit(tx, actor, { action: 'spc.limits_set', entityType: SUBJECT, entityId: c.id, facilityId: c.facility_id, data: { ...L, reason: input.reason.trim() } });
  return { id: l.id as string, ...L };
}

/**
 * Closes a signal with its investigation: the cause found (or "none found") and what was done. Optionally raises a
 * nonconformance for the parts made since (linked to the signal) and excludes the subgroup from calculations.
 */
export async function respondToSignal(tx: Tx, actor: Actor, signalId: string,
  input: { cause: string; response: string; raiseNcr?: { severity?: 'minor' | 'major' | 'critical'; qty?: number | null } | null; excludeSubgroup?: boolean }) {
  const s = await one(tx, `SELECT s.*, c.code, c.name, c.part_id, c.asset_id, c.unit, g.production_order_id, g.excluded FROM spc_signal s JOIN spc_characteristic c ON c.id = s.characteristic_id
    JOIN spc_subgroup g ON g.id = s.subgroup_id WHERE s.id = $1 FOR UPDATE OF s`, [signalId]);
  if (!s) throw notFound('signal');
  requirePermission(actor, 'quality.manage', s.facility_id);
  if (s.status !== 'open') throw conflict('this signal is already answered');
  if (!input.cause?.trim() || !input.response?.trim()) throw invalid('record the cause found (or "none found") and what was done');
  let ncrId: string | null = null;
  if (input.raiseNcr) {
    const n = await createNcr(tx, actor, { facilityId: s.facility_id, source: 'production', severity: input.raiseNcr.severity ?? 'minor', partId: s.part_id, assetId: s.asset_id,
      productionOrderId: s.production_order_id, qty: input.raiseNcr.qty ?? null, title: `${s.code} ${s.name}: ${RULE_LABEL[s.rule]}`,
      description: `SPC signal on ${s.code} (${s.name}): ${s.detail}. Cause: ${input.cause.trim()}. Response: ${input.response.trim()}` });
    ncrId = n.id;
  }
  if (input.excludeSubgroup && !s.excluded) await excludeSubgroup(tx, actor, s.subgroup_id, `Signal: ${input.cause.trim()}`);
  await tx.query(`UPDATE spc_signal SET status = 'closed', cause = $2, response = $3, ncr_id = $4, responded_by = $5, responded_at = now() WHERE id = $1`,
    [signalId, input.cause.trim(), input.response.trim(), ncrId, actor.userId]);
  await audit(tx, actor, { action: 'spc.signal_answered', entityType: SUBJECT, entityId: s.characteristic_id, facilityId: s.facility_id,
    data: { signal: signalId, rule: s.rule, cause: input.cause.trim(), ncr: ncrId, excluded: !!input.excludeSubgroup } });
  return { ncrId };
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/**
 * Subgroups measured with a gauge that was later found out of tolerance, since its previous calibration: their values
 * are suspect (ISO 9001 7.1.5.2 asks for this assessment).
 */
async function suspectWindows(tx: Tx, gaugeId: string | null) {
  if (!gaugeId) return [];
  // Since the last calibration that found it in tolerance (as the calibration module assesses production runs).
  const recs = await many(tx, `SELECT r.performed_on, (SELECT max(p.performed_on) FROM calibration_record p WHERE p.asset_id = r.asset_id AND p.as_found = 'in_tolerance' AND p.performed_on < r.performed_on) AS prev
    FROM calibration_record r WHERE r.asset_id = $1 AND r.as_found = 'out_of_tolerance' ORDER BY r.performed_on`, [gaugeId]);
  return recs.map((r) => ({ from: r.prev ? new Date(r.prev) : null, to: new Date(new Date(r.performed_on).getTime() + 86_400_000), foundOn: iso(r.performed_on).slice(0, 10) }));
}

async function chartOf(tx: Tx, c: any, window: number) {
  if (isAttr(c)) return attributeChartOf(tx, c, window);
  const rows = (await many(tx, `SELECT * FROM (SELECT s.id, s.measured_at, s.vals, s.lot, s.note, s.excluded, s.exclude_reason, s.source, o.number AS order_number, s.created_at
      FROM spc_subgroup s LEFT JOIN production_order o ON o.id = s.production_order_id WHERE s.characteristic_id = $1 ORDER BY s.measured_at DESC, s.created_at DESC LIMIT $2) x
    ORDER BY measured_at, created_at`, [c.id, window]));
  const frozen = await limitsInForce(tx, c.id);
  const included = rows.filter((r) => !r.excluded).map((r) => (r.vals as any[]).map(Number));
  let limits: (Limits & { trial: boolean }) | null = frozen ? { ...frozen, trial: false } : null;
  if (!limits && included.length >= 2) limits = { ...computeLimits(included, c.subgroup_size), trial: true };
  const susp = await suspectWindows(tx, c.gauge_asset_id);
  const signals = await many(tx, `SELECT s.id, s.facility_id, s.subgroup_id, s.rule, s.chart, s.detail, s.status, s.cause, s.response, s.ncr_id, n.number AS ncr_number, s.created_at, s.responded_at,
      u.display_name AS responded_by, g.measured_at FROM spc_signal s JOIN spc_subgroup g ON g.id = s.subgroup_id LEFT JOIN nonconformance n ON n.id = s.ncr_id LEFT JOIN app_user u ON u.id = s.responded_by
    WHERE s.characteristic_id = $1 ORDER BY s.created_at DESC LIMIT 200`, [c.id]);
  // Rule markers for display on every plotted point (stored signals are only those raised against set limits).
  const inc = rows.filter((r) => !r.excluded);
  const p = points(inc.map((r) => (r.vals as any[]).map(Number)));
  const marks = new Map<string, string[]>();
  const on = await rulesOf(tx, c);
  if (limits) for (const sg of evaluate(p.x, p.r, limits, 0, on)) { const id = inc[sg.index]!.id; marks.set(id, [...(marks.get(id) ?? []), sg.rule]); }
  const pi = new Map(inc.map((r, i) => [r.id, i]));
  const subgroups = rows.map((r) => {
    const vals = (r.vals as any[]).map(Number);
    const at = new Date(r.measured_at);
    const sw = susp.find((w) => (!w.from || at > w.from) && at < w.to);
    const k = pi.get(r.id);
    const x = c.subgroup_size === 1 ? vals[0]! : vals.reduce((s, v) => s + v, 0) / vals.length;
    return { id: r.id, measuredAt: iso(r.measured_at), values: vals, x: Math.round(x * 1e6) / 1e6, r: k == null ? null : p.r[k] == null ? null : Math.round(p.r[k]! * 1e6) / 1e6,
      lot: r.lot, orderNumber: r.order_number, note: r.note, excluded: r.excluded, excludeReason: r.exclude_reason, source: r.source,
      suspect: sw ? `gauge found out of tolerance on ${sw.foundOn}` : null, rules: marks.get(r.id) ?? [], signals: signals.filter((s) => s.subgroup_id === r.id).map((s) => s.rule) };
  });
  const cap = capability(included.flat(), limits?.sigma ?? null, { lsl: num(c.lsl), usl: num(c.usl) });
  const openSignals = signals.filter((s) => s.status === 'open');
  const warnings: string[] = [];
  if (!frozen) warnings.push(included.length >= MIN_SUBGROUPS_FOR_LIMITS ? 'Limits are trial limits from the data shown; set them from a baseline to start alerting'
    : `Trial limits until at least ${MIN_SUBGROUPS_FOR_LIMITS} subgroups are recorded and limits are set; no alerts until then`);
  if (included.length < MIN_SUBGROUPS_FOR_CAPABILITY) warnings.push(`Capability from ${included.length} subgroups; at least ${MIN_SUBGROUPS_FOR_CAPABILITY} are needed for a stable estimate`);
  if (subgroups.some((s) => s.rules.length)) warnings.push('The process shows control-chart signals in this window: capability describes what it did, not what it will do');
  if (c.lsl == null && c.usl == null) warnings.push('No tolerance: capability cannot be calculated');
  if (subgroups.some((s) => s.suspect)) warnings.push('Some measurements were taken with a gauge later found out of tolerance; review them');
  warnings.push('Capability assumes the measurements are normally distributed; this is not tested');
  return { limits, subgroups, capability: cap, signals, openSignals: openSignals.length, warnings };
}

/** Attribute charts: per-point limits from the center (set or trial) and each sample's size; the average rate in place of capability. */
async function attributeChartOf(tx: Tx, c: any, window: number) {
  const rows = await many(tx, `SELECT * FROM (SELECT s.id, s.measured_at, s.vals, s.sample_size::float AS n, s.lot, s.note, s.excluded, s.exclude_reason, s.source, o.number AS order_number, s.created_at
      FROM spc_subgroup s LEFT JOIN production_order o ON o.id = s.production_order_id WHERE s.characteristic_id = $1 ORDER BY s.measured_at DESC, s.created_at DESC LIMIT $2) x
    ORDER BY measured_at, created_at`, [c.id, window]);
  const frozen = await limitsInForce(tx, c.id);
  const inc = rows.filter((r) => !r.excluded);
  const samples = inc.map((r) => ({ count: Number(r.vals[0]), n: r.n as number }));
  let limits: (Limits & { trial: boolean }) | null = frozen ? { ...frozen, trial: false } : null;
  if (!limits && samples.length >= 2) limits = { ...attributeLimits(c, samples), trial: true };
  const fixed = num(c.sample_size) ?? undefined;
  const signals = await many(tx, `SELECT s.id, s.facility_id, s.subgroup_id, s.rule, s.chart, s.detail, s.status, s.cause, s.response, s.ncr_id, n.number AS ncr_number, s.created_at, s.responded_at,
      u.display_name AS responded_by, g.measured_at FROM spc_signal s JOIN spc_subgroup g ON g.id = s.subgroup_id LEFT JOIN nonconformance n ON n.id = s.ncr_id LEFT JOIN app_user u ON u.id = s.responded_by
    WHERE s.characteristic_id = $1 ORDER BY s.created_at DESC LIMIT 200`, [c.id]);
  const pts = limits ? inc.map((r, i) => attributePoint(c.chart_type, limits!.center, samples[i]!, fixed)) : [];
  const marks = new Map<string, string[]>();
  const onA = await rulesOf(tx, c);
  for (const sg of evaluateAttribute(pts, 0, onA)) { const id = inc[sg.index]!.id; marks.set(id, [...(marks.get(id) ?? []), sg.rule]); }
  const pi = new Map(inc.map((r, i) => [r.id, i]));
  const subgroups = rows.map((r) => {
    const count = Number(r.vals[0]);
    const pt = limits ? attributePoint(c.chart_type, limits.center, { count, n: r.n }, fixed) : null;
    const k = pi.get(r.id);
    return { id: r.id, measuredAt: iso(r.measured_at), values: [count], count, n: r.n, x: pt?.x ?? (c.chart_type === 'p' || c.chart_type === 'u' ? count / r.n : count), r: null,
      ucl: pt?.ucl ?? null, lcl: pt?.lcl ?? null, lot: r.lot, orderNumber: r.order_number, note: r.note, excluded: r.excluded, excludeReason: r.exclude_reason, source: r.source,
      suspect: null, rules: k == null ? [] : marks.get(r.id) ?? [], signals: signals.filter((s) => s.subgroup_id === r.id).map((s) => s.rule) };
  });
  const d = samples.reduce((t, x) => t + x.count, 0); const n = samples.reduce((t, x) => t + x.n, 0);
  const rate = samples.length ? (c.chart_type === 'c' ? d / samples.length : d / n) : null;
  const capabilityOut = { cp: null, cpk: null, pp: null, ppk: null, mean: null, outOfSpec: 0, values: samples.length, sigmaWithin: null, sigmaOverall: null,
    rate: rate == null ? null : Math.round(rate * 1e6) / 1e6, ppm: rate != null && (c.chart_type === 'p' || c.chart_type === 'np') ? Math.round(rate * 1e6) : null, defects: d, inspected: n };
  const warnings: string[] = [];
  if (!frozen) warnings.push(samples.length >= MIN_SUBGROUPS_FOR_LIMITS ? 'Limits are trial limits from the data shown; set them from a baseline to start alerting'
    : `Trial limits until at least ${MIN_SUBGROUPS_FOR_LIMITS} samples are recorded and limits are set; no alerts until then`);
  if ((c.chart_type === 'p' || c.chart_type === 'u') && samples.some((x) => x.n !== samples[0]!.n)) warnings.push('Sample sizes vary, so the limits step with each sample');
  if (rate != null && (c.chart_type === 'p' || c.chart_type === 'np') && rate * (n / Math.max(1, samples.length)) < 1) warnings.push('Fewer than one defective per sample on average: limits are approximate (consider larger samples)');
  warnings.push(c.chart_type === 'p' || c.chart_type === 'np' ? 'Limits assume each part is defective independently (binomial)' : 'Limits assume defects occur independently (Poisson)');
  return { limits, subgroups, capability: capabilityOut, signals, openSignals: signals.filter((s) => s.status === 'open').length, warnings };
}

export async function getCharacteristic(tx: Tx, actor: Actor, id: string, q: { window?: number } = {}) {
  const c = await one(tx, `SELECT c.*, p.part_number, w.code AS work_center_code, a.asset_tag, g.asset_tag AS gauge_tag, f.code AS facility_code
    FROM spc_characteristic c LEFT JOIN part p ON p.id = c.part_id LEFT JOIN work_center w ON w.id = c.work_center_id LEFT JOIN asset a ON a.id = c.asset_id
    LEFT JOIN asset g ON g.id = c.gauge_asset_id JOIN facility f ON f.id = c.facility_id WHERE c.id = $1`, [id]);
  if (!c) throw notFound('characteristic');
  requirePermission(actor, 'quality.view', c.facility_id);
  const chart = await chartOf(tx, c, Math.min(Math.max(q.window ?? 50, 10), 500));
  const history = await many(tx, `SELECT l.center::float, l.ucl::float, l.lcl::float, l.range_ucl::float, l.subgroups, l.reason, l.set_at, u.display_name AS set_by
    FROM spc_limit l JOIN app_user u ON u.id = l.set_by WHERE l.characteristic_id = $1 ORDER BY l.set_at DESC`, [id]);
  const total = await one(tx, `SELECT count(*)::int AS n, count(*) FILTER (WHERE NOT excluded)::int AS included FROM spc_subgroup WHERE characteristic_id = $1`, [id]);
  return { ...c, nominal: num(c.nominal), lsl: num(c.lsl), usl: num(c.usl), ...chart, limitHistory: history, totalSubgroups: total.n, includedSubgroups: total.included,
    ownRules: c.rules ?? null, rulesInForce: [...(await rulesOf(tx, c))] };
}

export async function listCharacteristics(tx: Tx, actor: Actor, q: { facilityId?: string } = {}) {
  requirePermission(actor, 'quality.view', q.facilityId);
  const rows = await many(tx, `SELECT c.*, p.part_number, a.asset_tag, g.asset_tag AS gauge_tag, f.code AS facility_code,
      (SELECT max(measured_at) FROM spc_subgroup s WHERE s.characteristic_id = c.id) AS last_measured
    FROM spc_characteristic c LEFT JOIN part p ON p.id = c.part_id LEFT JOIN asset a ON a.id = c.asset_id LEFT JOIN asset g ON g.id = c.gauge_asset_id JOIN facility f ON f.id = c.facility_id
    WHERE ($1::uuid IS NULL OR c.facility_id = $1) ORDER BY c.active DESC, c.code`, [q.facilityId ?? null]);
  const out = [];
  for (const c of rows) {
    if (!can(actor, 'quality.view', c.facility_id)) continue;
    const ch = await chartOf(tx, c, 50);
    const last = ch.subgroups[ch.subgroups.length - 1];
    out.push({ id: c.id, code: c.code, name: c.name, facilityCode: c.facility_code, partNumber: c.part_number, opNo: c.op_no, assetTag: c.asset_tag, gaugeTag: c.gauge_tag,
      unit: c.unit, lsl: num(c.lsl), usl: num(c.usl), subgroupSize: c.subgroup_size, active: c.active, lastMeasured: c.last_measured, subgroups: ch.subgroups.length,
      limitsSet: !!ch.limits && !ch.limits.trial, openSignals: ch.openSignals, cpk: ch.capability.cpk, ppk: ch.capability.ppk, chartType: c.chart_type,
      rate: (ch.capability as any).rate ?? null, ppm: (ch.capability as any).ppm ?? null,
      status: !c.active ? 'inactive' : ch.openSignals ? 'signal' : !ch.limits || ch.limits.trial ? 'study' : last?.rules.length ? 'watch' : 'in_control' });
  }
  return out;
}
