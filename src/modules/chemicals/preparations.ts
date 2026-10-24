import type { Actor } from '../../platform/auth/actor.js';
import { can, requirePermission } from '../../platform/auth/actor.js';
import { audit } from '../../platform/audit/audit.js';
import type { Tx } from '../../platform/db/tx.js';
import { many, nextSequence, one } from '../../platform/db/tx.js';
import { invalid, notFound } from '../../platform/errors.js';
import { normalizeUom } from '../inventory/uom.js';
import { renderLabels } from '../inventory/scan.js';
import { assertUsable, drawFromContainer, openContainer } from './service.js';
import { preparationExpiry, todayIso } from './rules.js';

/**
 * Preparations (SC-007 C): reagents and standards made from containers (or from another preparation). Each records what went in,
 * who prepared it and when, and its new expiry: the earliest of the components' use-by dates and the shelf life stated for it.
 * Quantities drawn from containers post the stock ledger like any other use.
 */
const r3 = (n: number) => Math.round(n * 1000) / 1000;

export interface PrepInput {
  facilityId: string; name: string; kind: 'reagent' | 'standard'; concentration?: string | null; qty: number; uom: string;
  preparedOn?: string | null; shelfLifeDays?: number | null; notes?: string | null;
  components: { containerId?: string | null; preparationId?: string | null; qty: number }[];
}

export async function createPreparation(tx: Tx, actor: Actor, input: PrepInput) {
  requirePermission(actor, 'chemicals.manage', input.facilityId);
  if (input.name.trim().length < 2) throw invalid('give the preparation a name');
  if (!(input.qty > 0)) throw invalid('the prepared quantity must be positive');
  if (!input.components.length) throw invalid('say what went into it');
  const on = input.preparedOn ?? todayIso();
  if (on > todayIso()) throw invalid('the preparation date is in the future');
  if (input.shelfLifeDays != null && (!Number.isInteger(input.shelfLifeDays) || input.shelfLifeDays < 1 || input.shelfLifeDays > 36500)) throw invalid('the shelf life is a whole number of days');
  if (!(await one(tx, 'SELECT 1 FROM facility WHERE id = $1', [input.facilityId]))) throw notFound('site');
  const number = `PREP-${String(await nextSequence(tx, actor.tenantId, 'chemical-preparation')).padStart(5, '0')}`;

  // Check every component before anything is drawn.
  const seen = new Set<string>();
  const plan: { container?: any; source?: any; qty: number }[] = [];
  for (const comp of input.components) {
    if (!!comp.containerId === !!comp.preparationId) throw invalid('each component is either a container or another preparation');
    if (!(comp.qty > 0)) throw invalid('each component needs a positive quantity');
    const key = comp.containerId ?? comp.preparationId!;
    if (seen.has(key)) throw invalid('a container or preparation is listed twice; add its quantities together');
    seen.add(key);
    if (comp.containerId) {
      const SEL = `SELECT c.*, p.part_number, lot.status AS lot_status, lot.hold_reason FROM chemical_container c JOIN part p ON p.id = c.part_id JOIN stock_lot lot ON lot.id = c.lot_id WHERE c.id = $1 FOR UPDATE OF c`;
      let c = await one(tx, SEL, [comp.containerId]);
      if (!c) throw notFound('container');
      if (c.facility_id !== input.facilityId) throw invalid(`container ${c.number} is at another site`);
      assertUsable(c, on);
      // An unopened container is opened by using it, which starts its beyond-use clock before the expiry is worked out.
      if (c.status === 'in_storage') { await openContainer(tx, actor, c.id, { openedOn: on }); c = (await one(tx, SEL, [comp.containerId]))!; assertUsable(c, on); }
      if (comp.qty > c.qty + 0.0005) throw invalid(`container ${c.number} holds only ${c.qty} ${c.uom}`);
      plan.push({ container: c, qty: r3(comp.qty) });
    } else {
      const sp = await one(tx, 'SELECT * FROM chemical_preparation WHERE id = $1 FOR UPDATE', [comp.preparationId]);
      if (!sp) throw notFound('preparation');
      if (sp.facility_id !== input.facilityId) throw invalid(`${sp.number} is at another site`);
      if (sp.status !== 'active') throw invalid(`${sp.number} is ${sp.status.replace('_', ' ')}`);
      if (sp.expires_on && sp.expires_on < on) throw invalid(`${sp.number} expired on ${sp.expires_on}`);
      if (comp.qty > sp.qty_remaining + 0.0005) throw invalid(`${sp.number} has only ${sp.qty_remaining} ${sp.uom} left`);
      plan.push({ source: sp, qty: r3(comp.qty) });
    }
  }
  const expires = preparationExpiry(on, input.shelfLifeDays, plan.map((p) => (p.container ? p.container.use_by : p.source.expires_on)));
  if (!expires) throw invalid('no component has an expiry date: give the shelf life for this preparation');

  const prep = (await one(tx, `INSERT INTO chemical_preparation (tenant_id, facility_id, number, name, kind, concentration, qty, qty_remaining, uom, prepared_by, prepared_on, shelf_life_days, expires_on, notes)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $7, $8, $9, $10, $11, $12, $13) RETURNING *`,
  [actor.tenantId, input.facilityId, number, input.name.trim(), input.kind, input.concentration?.trim() || null, input.qty, normalizeUom(input.uom), actor.userId, on, input.shelfLifeDays ?? null, expires, input.notes?.trim() || null]))!;
  for (const p of plan) {
    if (p.container) {
      await tx.query(`INSERT INTO chemical_preparation_component (tenant_id, facility_id, preparation_id, container_id, part_id, lot_number, qty, uom, use_by) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [actor.tenantId, input.facilityId, prep.id, p.container.id, p.container.part_id, p.container.lot_number, p.qty, p.container.uom, p.container.use_by]);
      await drawFromContainer(tx, actor, p.container, p.qty, number, `Used in ${number} ${input.name.trim()}`);
    } else {
      await tx.query(`INSERT INTO chemical_preparation_component (tenant_id, facility_id, preparation_id, source_preparation_id, qty, uom, use_by) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [actor.tenantId, input.facilityId, prep.id, p.source.id, p.qty, p.source.uom, p.source.expires_on]);
      const left = r3(p.source.qty_remaining - p.qty);
      await tx.query(`UPDATE chemical_preparation SET qty_remaining = $2::numeric, status = CASE WHEN $2::numeric = 0 THEN 'used_up' ELSE status END WHERE id = $1`, [p.source.id, left]);
    }
  }
  await audit(tx, actor, { action: 'chemical.preparation_made', entityType: 'chemical_preparation', entityId: prep.id, facilityId: input.facilityId,
    data: { number, name: prep.name, kind: prep.kind, qty: prep.qty, uom: prep.uom, expiresOn: expires, shelfLifeDays: input.shelfLifeDays ?? null, components: plan.map((p) => ({ from: p.container?.number ?? p.source.number, qty: p.qty })) } });
  return getPreparation(tx, actor, prep.id);
}

const PREP_SELECT = `SELECT x.id, x.number, x.facility_id, f.code AS facility_code, x.name, x.kind, x.concentration, x.qty, x.qty_remaining, x.uom, x.prepared_by, u.display_name AS prepared_by_name, x.prepared_on,
    x.shelf_life_days, x.expires_on, (x.expires_on - current_date) AS days_left, x.status, x.discarded_on, x.discard_note, x.notes
  FROM chemical_preparation x JOIN facility f ON f.id = x.facility_id JOIN app_user u ON u.id = x.prepared_by`;

export async function listPreparations(tx: Tx, actor: Actor, q: { facilityId?: string; status?: string; q?: string }) {
  requirePermission(actor, 'chemicals.view', q.facilityId);
  const rows = await many(tx, `${PREP_SELECT} WHERE ($1::uuid IS NULL OR x.facility_id = $1)
    AND (CASE WHEN $2::text = 'all' THEN true WHEN $2::text IS NULL OR $2::text = 'active' THEN x.status = 'active' ELSE x.status = $2::text END)
    AND ($3::text IS NULL OR x.name ILIKE '%' || $3 || '%' OR x.number ILIKE '%' || $3 || '%')
    ORDER BY x.expires_on NULLS LAST, x.number LIMIT 500`, [q.facilityId ?? null, q.status ?? null, q.q ?? null]);
  return rows.filter((r) => can(actor, 'chemicals.view', r.facility_id)).map((r) => ({ ...r, expired: r.status === 'active' && r.days_left != null && r.days_left < 0 }));
}

export async function getPreparation(tx: Tx, actor: Actor, id: string) {
  requirePermission(actor, 'chemicals.view');
  const x = await one(tx, `${PREP_SELECT} WHERE x.id = $1`, [id]);
  if (!x) throw notFound('preparation');
  requirePermission(actor, 'chemicals.view', x.facility_id);
  const components = await many(tx, `SELECT k.id, k.qty, k.uom, k.use_by, k.lot_number, k.container_id, c.number AS container_number, p.part_number, p.description, k.source_preparation_id, sp.number AS source_number, sp.name AS source_name
    FROM chemical_preparation_component k LEFT JOIN chemical_container c ON c.id = k.container_id LEFT JOIN part p ON p.id = k.part_id LEFT JOIN chemical_preparation sp ON sp.id = k.source_preparation_id
    WHERE k.preparation_id = $1 ORDER BY coalesce(c.number, sp.number)`, [id]);
  return { ...x, expired: x.status === 'active' && x.days_left != null && x.days_left < 0, components, canManage: can(actor, 'chemicals.manage', x.facility_id) };
}

/** Draws some of a preparation (a standard poured for a run); the last of it marks it used up. */
export async function usePreparation(tx: Tx, actor: Actor, id: string, input: { qty: number; note?: string | null }) {
  const x = await one(tx, 'SELECT * FROM chemical_preparation WHERE id = $1 FOR UPDATE', [id]);
  if (!x) throw notFound('preparation');
  requirePermission(actor, 'chemicals.manage', x.facility_id);
  if (x.status !== 'active') throw invalid(`${x.number} is ${x.status.replace('_', ' ')}`);
  if (x.expires_on && x.expires_on < todayIso()) throw invalid(`${x.number} expired on ${x.expires_on}`);
  if (!(input.qty > 0) || input.qty > x.qty_remaining + 0.0005) throw invalid(`${x.number} has ${x.qty_remaining} ${x.uom} left`);
  const left = r3(x.qty_remaining - input.qty);
  await tx.query(`UPDATE chemical_preparation SET qty_remaining = $2::numeric, status = CASE WHEN $2::numeric = 0 THEN 'used_up' ELSE status END WHERE id = $1`, [id, left]);
  await audit(tx, actor, { action: 'chemical.preparation_used', entityType: 'chemical_preparation', entityId: id, facilityId: x.facility_id, data: { number: x.number, qty: input.qty, left, note: input.note ?? null } });
}

export async function discardPreparation(tx: Tx, actor: Actor, id: string, input: { note: string }) {
  const x = await one(tx, 'SELECT * FROM chemical_preparation WHERE id = $1 FOR UPDATE', [id]);
  if (!x) throw notFound('preparation');
  requirePermission(actor, 'chemicals.manage', x.facility_id);
  if (x.status === 'discarded') throw invalid(`${x.number} is already discarded`);
  if (!input.note || input.note.trim().length < 3) throw invalid('say how it was discarded');
  await tx.query(`UPDATE chemical_preparation SET status = 'discarded', discarded_on = current_date, discard_note = $2, qty_remaining = 0 WHERE id = $1`, [id, input.note.trim()]);
  await audit(tx, actor, { action: 'chemical.preparation_discarded', entityType: 'chemical_preparation', entityId: id, facilityId: x.facility_id, data: { number: x.number, note: input.note.trim() } });
}

// ---------------------------------------------------------------------------
// Labels (the scan station's Code 128 sheet)
// ---------------------------------------------------------------------------
const SIGNAL: Record<string, string> = { danger: 'DANGER', warning: 'WARNING' };

/**
 * Container and preparation labels on the scan station's label sheet. They carry the number as a Code 128 barcode, the lot and the
 * date to use by; this is an internal inventory label, not the supplier's GHS label (no pictograms are printed).
 */
export async function chemicalLabelsPdf(tx: Tx, actor: Actor, input: { kind: 'container' | 'preparation'; ids: string[] }): Promise<Buffer> {
  requirePermission(actor, 'chemicals.view');
  if (!input.ids.length) throw invalid('choose what to label');
  if (input.kind === 'container') {
    const rows = (await many(tx, `SELECT c.number, c.lot_number, c.use_by, c.facility_id, p.part_number, p.description, cp.signal_word, cp.hazard_classes
      FROM chemical_container c JOIN part p ON p.id = c.part_id LEFT JOIN chemical_part cp ON cp.part_id = c.part_id WHERE c.id = ANY ($1) ORDER BY c.number`, [input.ids])).filter((r) => can(actor, 'chemicals.view', r.facility_id));
    return renderLabels(rows.map((r) => ({ text: `CHM:${r.number}`, title: `${r.number}  ${r.part_number}`,
      sub: `${[SIGNAL[r.signal_word], (r.hazard_classes ?? []).map((h: string) => h.replace('_', ' ')).join('/')].filter(Boolean).join(' ')} lot ${r.lot_number}${r.use_by ? ` use by ${r.use_by}` : ''}`.trim() })));
  }
  const rows = (await many(tx, `SELECT x.number, x.name, x.concentration, x.expires_on, x.prepared_on, x.facility_id, u.display_name AS by FROM chemical_preparation x JOIN app_user u ON u.id = x.prepared_by WHERE x.id = ANY ($1) ORDER BY x.number`, [input.ids]))
    .filter((r) => can(actor, 'chemicals.view', r.facility_id));
  return renderLabels(rows.map((r) => ({ text: `PREP:${r.number}`, title: `${r.number}  ${r.name}`,
    sub: `${r.concentration ? `${r.concentration} ` : ''}made ${r.prepared_on} by ${r.by}${r.expires_on ? ` use by ${r.expires_on}` : ''}` })));
}
