import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Actor } from '../src/platform/auth/actor.js';
import { asActor, loadActor } from '../src/platform/auth/actor.js';
import { closePools, getAdminPool } from '../src/platform/db/pool.js';
import { createUserWithToken } from '../src/platform/tenancy/provision.js';
import type { Limits } from '../src/modules/spc/engine.js';
import { DEFAULT_RULES, RULES, evaluate, evaluateAttribute } from '../src/modules/spc/engine.js';
import { alarmSummary, getCharacteristic, getSpcSettings, recordSubgroup, saveCharacteristic, saveSpcSettings, setCharacteristicRules, setLimits } from '../src/modules/spc/service.js';
import { runReminders } from '../src/modules/notifications/reminders.js';
import type { World } from './fixtures.js';
import { makeWorld } from './fixtures.js';

/** SPC rule selection and the alarm summary (D-156). */
const L: Limits = { center: 0, ucl: 3, lcl: -3, rangeCenter: 1, rangeUcl: 100, rangeLcl: 0, sigma: 1, subgroups: 25 };
const rules = (x: number[], on?: string[]) => evaluate(x, x.map(() => null), L, 0, on ? new Set(on) : undefined).map((s) => `${s.rule}@${s.index}`);
const repeat = (p: number[], n: number) => Array.from({ length: n }, (_, i) => p[i % p.length]!);

describe('the optional rules', () => {
  it('4 of 5 beyond 1σ on one side', () => expect(rules([1.5, 1.5, 0.5, 1.5, 1.5])).toEqual(['four_of_five@4']));
  it('8 in a row beyond 1σ on either side (a mixture)', () => expect(rules(repeat([1.5, 1.5, -1.5, -1.5], 8))).toEqual(['eight_beyond_1@7']));
  it('15 in a row within 1σ (hugging the center line)', () => expect(rules(repeat([0.1, 0.2, -0.1, -0.2], 16))).toEqual(['fifteen_in_c@14']));
  it('14 in a row alternating up and down', () => expect(rules(repeat([0.5, -0.5], 14))).toEqual(['alternating_14@13']));
  it('are off unless chosen; a rule turned off raises nothing', () => {
    expect(DEFAULT_RULES).toEqual(['beyond_limits', 'run_of_9', 'trend_of_6', 'two_of_three', 'range_beyond', 'out_of_spec']);
    expect(rules([1.5, 1.5, 0.5, 1.5, 1.5], DEFAULT_RULES)).toEqual([]);
    expect(rules([4], ['run_of_9'])).toEqual([]);
    expect(rules([4], ['beyond_limits'])).toEqual(['beyond_limits@0']);
    const pts = repeat([0.5, -0.5], 14).map((x) => ({ x: x + 2, center: 2, ucl: 9, lcl: 0 }));
    expect(evaluateAttribute(pts, 0, new Set(['alternating_14'])).map((s) => s.rule)).toEqual(['alternating_14']);
    expect(evaluateAttribute(pts, 0, new Set(DEFAULT_RULES))).toEqual([]);
    expect(RULES.filter((r) => !r.onByDefault).map((r) => r.key)).toEqual(['four_of_five', 'eight_beyond_1', 'fifteen_in_c', 'alternating_14']);
  });
});

describe('rules a company and a characteristic choose', () => {
  let w: World; let qm: Actor; let id: string;
  const db = () => getAdminPool();
  const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000);
  const base = (k: number) => { const m = 25 + [0, 0.001, -0.001, 0.0005, -0.0005][k % 5]!; return [m - 0.002, m - 0.001, m, m + 0.001, m + 0.002].map((v) => Math.round(v * 1e6) / 1e6); };
  const signals = async () => (await db().query(`SELECT rule FROM spc_signal WHERE characteristic_id = $1 ORDER BY created_at, rule`, [id])).rows.map((r) => r.rule);
  const notices = async () => Number((await db().query(`SELECT count(*)::int AS n FROM notification WHERE tenant_id = $1 AND kind = 'spc.signal'`, [w.tenantId])).rows[0].n);

  beforeAll(async () => {
    w = await makeWorld('spcrules');
    const u = await createUserWithToken(db(), w.tenantId, { email: `qm@${w.tenantId}.example`, displayName: 'QM', roles: [{ role: 'quality_manager', facility: w.facilities.A! }] });
    qm = (await loadActor(w.tenantId, u.userId))!;
    id = (await asActor(qm, (tx) => saveCharacteristic(tx, qm, { facilityId: w.facilities.A!, code: 'BORE', name: 'Bore', unit: 'mm', lsl: 24.98, usl: 25.02, subgroupSize: 5 }))).id;
    for (let k = 0; k < 24; k++) await asActor(w.techA, (tx) => recordSubgroup(tx, w.techA, id, { values: base(k), measuredAt: hoursAgo(60 - 2 * k) }));
    await asActor(qm, (tx) => setLimits(tx, qm, id, { reason: 'Baseline' }));
  });
  afterAll(closePools);

  it('only quality managers change the company’s rules; at least one stays on', async () => {
    await expect(asActor(w.techA, (tx) => saveSpcSettings(tx, w.techA, { rules: ['beyond_limits'], notifyEachAlarm: true }))).rejects.toThrow(/quality.manage/);
    await expect(asActor(w.qualityA, (tx) => saveSpcSettings(tx, w.qualityA, { rules: [], notifyEachAlarm: true }))).rejects.toThrow(/at least one/);
    await expect(asActor(w.qualityA, (tx) => saveSpcSettings(tx, w.qualityA, { rules: ['nonsense'], notifyEachAlarm: true }))).rejects.toThrow(/unknown rule/);
    expect((await asActor(qm, (tx) => getSpcSettings(tx, qm))).rules).toEqual(DEFAULT_RULES);
  });

  it('a rule turned off raises no alarm; the instant notice can give way to the summary', async () => {
    await asActor(qm, (tx) => saveSpcSettings(tx, qm, { rules: ['run_of_9', 'trend_of_6'], notifyEachAlarm: false }));
    await asActor(w.techA, (tx) => recordSubgroup(tx, w.techA, id, { values: [25.05, 25.05, 25.05, 25.05, 25.05] })); // beyond limits and out of tolerance
    expect(await signals()).toEqual([]);
    await asActor(qm, (tx) => saveSpcSettings(tx, qm, { rules: [...DEFAULT_RULES], notifyEachAlarm: false }));
    await asActor(w.techA, (tx) => recordSubgroup(tx, w.techA, id, { values: [25.05, 25.05, 25.05, 25.05, 25.05] }));
    // The earlier high point is still on the chart, so this one also completes 2 of 3 beyond 2σ.
    expect(await signals()).toEqual(['beyond_limits', 'out_of_spec', 'two_of_three']);
    expect(await notices()).toBe(0);
  });

  it('a characteristic can use its own rules, shown on its page', async () => {
    await expect(asActor(w.techA, (tx) => setCharacteristicRules(tx, w.techA, id, ['beyond_limits']))).rejects.toThrow(/quality.manage/);
    await asActor(qm, (tx) => setCharacteristicRules(tx, qm, id, ['out_of_spec']));
    await asActor(qm, (tx) => saveSpcSettings(tx, qm, { rules: [...DEFAULT_RULES], notifyEachAlarm: true }));
    await asActor(w.techA, (tx) => recordSubgroup(tx, w.techA, id, { values: [25.05, 25.05, 25.05, 25.05, 25.05] }));
    expect((await signals()).slice(3)).toEqual(['out_of_spec']);
    expect(await notices()).toBeGreaterThan(0);
    expect(await asActor(qm, (tx) => getCharacteristic(tx, qm, id))).toMatchObject({ ownRules: ['out_of_spec'], rulesInForce: ['out_of_spec'] });
  });

  it('the summary counts new alarms by rule and characteristic, open ones with the oldest, and quiet characteristics', async () => {
    const [s] = await asActor(qm, (tx) => alarmSummary(tx, { days: 1, silentDays: 7 }));
    expect(s).toMatchObject({ newAlarms: 4, newCharacteristics: 1, open: 4, openCharacteristics: 1, oldestOpenDays: 0, silent: [] });
    expect(s!.byRule).toEqual(expect.arrayContaining([expect.objectContaining({ rule: 'out_of_spec', n: 2, label: 'Out of tolerance' })]));
  });

  it('the daily reminder sends it to quality staff at the site, once a day', async () => {
    await runReminders(w.tenantId);
    await runReminders(w.tenantId);
    const rows = (await db().query(`SELECT user_id, title FROM notification WHERE tenant_id = $1 AND kind = 'reminder.spc_summary'`, [w.tenantId])).rows;
    expect(rows.map((r) => r.user_id)).toContain(qm.userId);
    expect(new Set(rows.map((r) => r.user_id)).size).toBe(rows.length);
    expect(rows[0]!.title).toMatch(/^A SPC: 4 new alarms in the last day on 1 characteristic; 4 still open, oldest 0 days$/);
  });
});
