import type { Actor } from '../../platform/auth/actor.js';
import { can, requirePermission } from '../../platform/auth/actor.js';
import { audit } from '../../platform/audit/audit.js';
import type { Tx } from '../../platform/db/tx.js';
import { many, nextSequence, one } from '../../platform/db/tx.js';
import { AppError, conflict, forbidden, invalid, notFound } from '../../platform/errors.js';
import { postTxn } from '../inventory/service.js';
import type { LotMove } from '../inventory/lots.js';
import { normalizeUom } from '../inventory/uom.js';
import { beyondUse, casValid, olderThanYears, STARTER_HAZARD_CLASSES, STARTER_INCOMPATIBLE, STARTER_NOTE, STARTER_STORAGE_GROUPS, todayIso } from './rules.js';

/**
 * Chemicals and reagents (SC-007 C, D-184C). Chemical attributes sit on the part; each physical container is a record of its own
 * (lot, quantity, location, opened and beyond-use dates); receipts, moves, use and disposal post the stock ledger so stock stays
 * true. The storage-group rule refuses a container beside an incompatible group unless a holder of chemicals.override gives a reason.
 */
const r3 = (n: number) => Math.round(n * 1000) / 1000;
const ACTIVE = ['in_storage', 'in_use'];

// ---------------------------------------------------------------------------
// Settings and starter lists
// ---------------------------------------------------------------------------
/** The company's settings row, created with the starter lists the first time the module is used. */
async function ensureStarter(tx: Tx, tenantId: string) {
  const made = await one(tx, 'INSERT INTO chemical_setting (tenant_id) VALUES ($1) ON CONFLICT DO NOTHING RETURNING tenant_id', [tenantId]);
  if (!made) return;
  for (const [i, h] of STARTER_HAZARD_CLASSES.entries()) {
    await tx.query('INSERT INTO chemical_hazard_class (tenant_id, code, label, pictogram, sort_order) VALUES ($1, $2, $3, $4, $5)', [tenantId, h.code, h.label, h.pictogram, i + 1]);
  }
  const ids = new Map<string, string>();
  for (const g of STARTER_STORAGE_GROUPS) {
    ids.set(g.code, (await one(tx, 'INSERT INTO chemical_storage_group (tenant_id, code, name, description, starter) VALUES ($1, $2, $3, $4, true) RETURNING id', [tenantId, g.code, g.name, g.description]))!.id);
  }
  for (const [a, b, reason] of STARTER_INCOMPATIBLE) {
    const [x, y] = [ids.get(a)!, ids.get(b)!].sort();
    await tx.query('INSERT INTO chemical_incompatibility (tenant_id, group_a, group_b, reason, starter) VALUES ($1, $2, $3, $4, true)', [tenantId, x, y, reason]);
  }
  await tx.query('UPDATE chemical_setting SET starter_loaded = true WHERE tenant_id = $1', [tenantId]);
}

async function loadSettings(tx: Tx, tenantId: string) {
  await ensureStarter(tx, tenantId);
  const s = await one(tx, 'SELECT sds_max_age_years, receipt_containers FROM chemical_setting');
  const hazardClasses = await many(tx, 'SELECT code, label, pictogram FROM chemical_hazard_class ORDER BY sort_order');
  return { sdsMaxAgeYears: s!.sds_max_age_years as number, receiptContainers: s!.receipt_containers as boolean, hazardClasses, starterNote: STARTER_NOTE };
}

export async function getSettings(tx: Tx, actor: Actor) {
  requirePermission(actor, 'chemicals.view');
  return loadSettings(tx, actor.tenantId);
}

export async function setSettings(tx: Tx, actor: Actor, input: { sdsMaxAgeYears?: number; receiptContainers?: boolean }) {
  requirePermission(actor, 'chemicals.manage');
  await ensureStarter(tx, actor.tenantId);
  const cur = await one(tx, 'SELECT * FROM chemical_setting');
  const years = input.sdsMaxAgeYears ?? cur!.sds_max_age_years;
  if (!Number.isInteger(years) || years < 1 || years > 20) throw invalid('the safety data sheet age limit is 1 to 20 years');
  const rc = input.receiptContainers ?? cur!.receipt_containers;
  await tx.query('UPDATE chemical_setting SET sds_max_age_years = $1, receipt_containers = $2, updated_by = $3, updated_at = now()', [years, rc, actor.userId]);
  await audit(tx, actor, { action: 'chemical.settings_set', entityType: 'chemical_setting', entityId: actor.tenantId, data: { sdsMaxAgeYears: years, receiptContainers: rc, was: { sdsMaxAgeYears: cur!.sds_max_age_years, receiptContainers: cur!.receipt_containers } } });
}

// ---------------------------------------------------------------------------
// Storage groups and incompatible pairs
// ---------------------------------------------------------------------------
export async function listStorageGroups(tx: Tx, actor: Actor) {
  requirePermission(actor, 'chemicals.view');
  await ensureStarter(tx, actor.tenantId);
  const groups = await many(tx, `SELECT g.id, g.code, g.name, g.description, g.starter, g.active, (SELECT count(*)::int FROM chemical_part p WHERE p.storage_group_id = g.id AND p.is_chemical) AS parts FROM chemical_storage_group g ORDER BY g.code`);
  const pairs = await many(tx, `SELECT i.id, i.group_a, i.group_b, a.code AS code_a, a.name AS name_a, b.code AS code_b, b.name AS name_b, i.reason, i.starter
    FROM chemical_incompatibility i JOIN chemical_storage_group a ON a.id = i.group_a JOIN chemical_storage_group b ON b.id = i.group_b ORDER BY a.code, b.code`);
  return { groups, pairs, starterNote: STARTER_NOTE };
}

export async function saveStorageGroup(tx: Tx, actor: Actor, input: { id?: string | null; code: string; name: string; description?: string | null; active?: boolean }) {
  requirePermission(actor, 'chemicals.manage');
  await ensureStarter(tx, actor.tenantId);
  const code = input.code.trim().toUpperCase();
  if (!/^[A-Z0-9_-]{1,20}$/.test(code)) throw invalid('a storage group code is up to 20 letters, digits, dashes or underscores');
  if (input.name.trim().length < 2) throw invalid('give the storage group a name');
  if (input.id) {
    const cur = await one(tx, 'SELECT * FROM chemical_storage_group WHERE id = $1', [input.id]);
    if (!cur) throw notFound('storage group');
    if (code !== cur.code && (await one(tx, 'SELECT 1 FROM chemical_storage_group WHERE code = $1', [code]))) throw conflict(`storage group ${code} already exists`);
    if (input.active === false && cur.active) {
      const used = await one(tx, `SELECT p.part_number FROM chemical_part cp JOIN part p ON p.id = cp.part_id WHERE cp.storage_group_id = $1 AND cp.is_chemical LIMIT 1`, [input.id]);
      if (used) throw conflict(`${used.part_number} is in storage group ${cur.code}; move it to another group first`);
    }
    await tx.query('UPDATE chemical_storage_group SET code = $2, name = $3, description = $4, active = $5 WHERE id = $1', [input.id, code, input.name.trim(), input.description ?? null, input.active ?? cur.active]);
    await audit(tx, actor, { action: 'chemical.group_saved', entityType: 'chemical_storage_group', entityId: input.id, data: { code, name: input.name.trim(), active: input.active ?? cur.active } });
    return { id: input.id };
  }
  if (await one(tx, 'SELECT 1 FROM chemical_storage_group WHERE code = $1', [code])) throw conflict(`storage group ${code} already exists`);
  const g = await one(tx, 'INSERT INTO chemical_storage_group (tenant_id, code, name, description) VALUES ($1, $2, $3, $4) RETURNING id', [actor.tenantId, code, input.name.trim(), input.description ?? null]);
  await audit(tx, actor, { action: 'chemical.group_saved', entityType: 'chemical_storage_group', entityId: g!.id, data: { code, name: input.name.trim() } });
  return { id: g!.id as string };
}

export async function addIncompatiblePair(tx: Tx, actor: Actor, input: { groupA: string; groupB: string; reason?: string | null }) {
  requirePermission(actor, 'chemicals.manage');
  await ensureStarter(tx, actor.tenantId);
  if (input.groupA === input.groupB) throw invalid('choose two different storage groups');
  const gs = await many(tx, 'SELECT id, code FROM chemical_storage_group WHERE id = ANY ($1)', [[input.groupA, input.groupB]]);
  if (gs.length !== 2) throw notFound('storage group');
  const [a, b] = [input.groupA, input.groupB].sort();
  if (await one(tx, 'SELECT 1 FROM chemical_incompatibility WHERE group_a = $1 AND group_b = $2', [a, b])) throw conflict('that pair is already on the list');
  const p = await one(tx, 'INSERT INTO chemical_incompatibility (tenant_id, group_a, group_b, reason) VALUES ($1, $2, $3, $4) RETURNING id', [actor.tenantId, a, b, input.reason?.trim() || null]);
  await audit(tx, actor, { action: 'chemical.pair_added', entityType: 'chemical_incompatibility', entityId: p!.id, data: { groups: gs.map((g) => g.code), reason: input.reason ?? null } });
  return { id: p!.id as string };
}

export async function removeIncompatiblePair(tx: Tx, actor: Actor, id: string) {
  requirePermission(actor, 'chemicals.manage');
  const p = await one(tx, `DELETE FROM chemical_incompatibility WHERE id = $1 RETURNING group_a, group_b`, [id]);
  if (!p) throw notFound('pair');
  await audit(tx, actor, { action: 'chemical.pair_removed', entityType: 'chemical_incompatibility', entityId: id, data: { groupA: p.group_a, groupB: p.group_b } });
}

// ---------------------------------------------------------------------------
// Chemical attributes of a part
// ---------------------------------------------------------------------------
export interface ChemicalPartInput {
  isChemical: boolean; hazardClasses?: string[]; signalWord?: 'none' | 'warning' | 'danger'; casNumber?: string | null;
  sdsDocumentId?: string | null; sdsRevisionOn?: string | null; storageGroupId?: string | null; inUseDays?: number | null; storageConditions?: string | null;
}

const PART_SELECT = `SELECT cp.part_id, p.part_number, p.description, p.uom, p.tracking, cp.is_chemical, cp.hazard_classes, cp.signal_word, cp.cas_number, cp.sds_document_id, cp.sds_revision_on,
    cp.storage_group_id, cp.in_use_days, cp.storage_conditions, cp.updated_at, g.code AS group_code, g.name AS group_name, d.doc_number AS sds_doc_number, d.title AS sds_title,
    (SELECT count(*)::int FROM chemical_container c WHERE c.part_id = cp.part_id AND c.status IN ('in_storage', 'in_use')) AS containers
  FROM chemical_part cp JOIN part p ON p.id = cp.part_id LEFT JOIN chemical_storage_group g ON g.id = cp.storage_group_id LEFT JOIN document d ON d.id = cp.sds_document_id`;

function withSdsFlags(r: any, maxYears: number) {
  return { ...r, sdsMissing: r.is_chemical && !r.sds_document_id, sdsOld: !!(r.is_chemical && r.sds_document_id && r.sds_revision_on && olderThanYears(r.sds_revision_on, maxYears)) };
}

export async function getChemicalPart(tx: Tx, actor: Actor, partId: string) {
  requirePermission(actor, 'chemicals.view');
  const s = await getSettings(tx, actor);
  const r = await one(tx, `${PART_SELECT} WHERE cp.part_id = $1`, [partId]);
  return r ? withSdsFlags(r, s.sdsMaxAgeYears) : null;
}

export async function listChemicalParts(tx: Tx, actor: Actor, q: { q?: string; problem?: 'no_sds' | 'old_sds' | 'no_group' }) {
  requirePermission(actor, 'chemicals.view');
  const s = await getSettings(tx, actor);
  const rows = (await many(tx, `${PART_SELECT} WHERE cp.is_chemical AND ($1::text IS NULL OR p.part_number ILIKE '%' || $1 || '%' OR p.description ILIKE '%' || $1 || '%' OR cp.cas_number ILIKE '%' || $1 || '%')
    ORDER BY p.part_number`, [q.q ?? null])).map((r) => withSdsFlags(r, s.sdsMaxAgeYears));
  return rows.filter((r) => (q.problem === 'no_sds' ? r.sdsMissing : q.problem === 'old_sds' ? r.sdsOld : q.problem === 'no_group' ? !r.storage_group_id : true));
}

export async function setChemicalPart(tx: Tx, actor: Actor, partId: string, input: ChemicalPartInput) {
  requirePermission(actor, 'chemicals.manage');
  const s = await loadSettings(tx, actor.tenantId);
  const part = await one(tx, 'SELECT id, part_number, tracking FROM part WHERE id = $1', [partId]);
  if (!part) throw notFound('part');
  const prior = await one(tx, 'SELECT * FROM chemical_part WHERE part_id = $1', [partId]);
  if (!input.isChemical) {
    if (!prior) return null;
    const open = await one(tx, `SELECT count(*)::int AS n FROM chemical_container WHERE part_id = $1 AND status IN ('in_storage', 'in_use')`, [partId]);
    if (open!.n) throw conflict(`${part.part_number} has ${open!.n} container${open!.n === 1 ? '' : 's'} in storage; empty or dispose of them first`);
    await tx.query('UPDATE chemical_part SET is_chemical = false, updated_by = $2, updated_at = now() WHERE part_id = $1', [partId, actor.userId]);
    await audit(tx, actor, { action: 'chemical.part_unmarked', entityType: 'part', entityId: partId, data: { partNumber: part.part_number } });
    return null;
  }
  if (part.tracking !== 'lot') throw invalid(`${part.part_number} must be tracked by lot before it is a chemical (the lot carries the expiry): switch lot tracking on in Storerooms first`);
  const classes = [...new Set(input.hazardClasses ?? [])];
  const known = new Set(s.hazardClasses.map((h) => h.code));
  const bad = classes.filter((c) => !known.has(c));
  if (bad.length) throw invalid(`unknown hazard class ${bad.join(', ')}`);
  const cas = input.casNumber?.trim() || null;
  if (cas && !casValid(cas)) throw invalid(`${cas} is not a valid CAS number (for example 67-64-1; the last digit is a check digit)`);
  if (input.inUseDays != null && (!Number.isInteger(input.inUseDays) || input.inUseDays < 1 || input.inUseDays > 3650)) throw invalid('in-use days after opening is a whole number of days, 1 to 3650');
  if (input.sdsDocumentId) {
    if (!(await one(tx, 'SELECT 1 FROM document WHERE id = $1', [input.sdsDocumentId]))) throw notFound('safety data sheet document');
    if (!input.sdsRevisionOn) throw invalid('give the revision date printed on the safety data sheet');
  }
  if (input.sdsRevisionOn && input.sdsRevisionOn > todayIso()) throw invalid('the safety data sheet revision date is in the future');
  if (input.storageGroupId && !(await one(tx, 'SELECT 1 FROM chemical_storage_group WHERE id = $1 AND active', [input.storageGroupId]))) throw invalid('choose an active storage group');
  const signal = input.signalWord ?? 'none';
  const next = { hazard_classes: classes, signal_word: signal, cas_number: cas, sds_document_id: input.sdsDocumentId ?? null, sds_revision_on: input.sdsDocumentId ? input.sdsRevisionOn! : null,
    storage_group_id: input.storageGroupId ?? null, in_use_days: input.inUseDays ?? null, storage_conditions: input.storageConditions?.trim() || null };
  await tx.query(`INSERT INTO chemical_part (part_id, tenant_id, is_chemical, hazard_classes, signal_word, cas_number, sds_document_id, sds_revision_on, storage_group_id, in_use_days, storage_conditions, updated_by)
    VALUES ($1, $2, true, $3, $4, $5, $6, $7, $8, $9, $10, $11)
    ON CONFLICT (part_id) DO UPDATE SET is_chemical = true, hazard_classes = EXCLUDED.hazard_classes, signal_word = EXCLUDED.signal_word, cas_number = EXCLUDED.cas_number, sds_document_id = EXCLUDED.sds_document_id,
      sds_revision_on = EXCLUDED.sds_revision_on, storage_group_id = EXCLUDED.storage_group_id, in_use_days = EXCLUDED.in_use_days, storage_conditions = EXCLUDED.storage_conditions, updated_by = EXCLUDED.updated_by, updated_at = now()`,
  [partId, actor.tenantId, next.hazard_classes, next.signal_word, next.cas_number, next.sds_document_id, next.sds_revision_on, next.storage_group_id, next.in_use_days, next.storage_conditions, actor.userId]);
  // The controlled document shows where it is used: link it to the part (and drop the link to a sheet this part no longer uses).
  if (prior?.sds_document_id && prior.sds_document_id !== next.sds_document_id) {
    await tx.query(`DELETE FROM document_link WHERE document_id = $1 AND entity_type = 'part' AND entity_id = $2 AND link_role = 'sds'`, [prior.sds_document_id, partId]);
  }
  if (next.sds_document_id) {
    await tx.query(`INSERT INTO document_link (tenant_id, document_id, entity_type, entity_id, link_role) VALUES ($1, $2, 'part', $3, 'sds') ON CONFLICT (document_id, entity_type, entity_id, link_role) DO NOTHING`,
      [actor.tenantId, next.sds_document_id, partId]);
  }
  await audit(tx, actor, { action: prior?.is_chemical ? 'chemical.part_updated' : 'chemical.part_marked', entityType: 'part', entityId: partId,
    data: { partNumber: part.part_number, ...next, was: prior ? { hazard_classes: prior.hazard_classes, storage_group_id: prior.storage_group_id, sds_document_id: prior.sds_document_id, in_use_days: prior.in_use_days } : null } });
  return getChemicalPart(tx, actor, partId);
}

// ---------------------------------------------------------------------------
// The storage-group rule
// ---------------------------------------------------------------------------
interface Pair { containerNumber: string; partNumber: string; groupCode: string; groupName: string; newGroupCode: string; newGroupName: string; reason: string | null }

/** Containers in a location whose storage group is incompatible with the group of the part being placed. */
async function conflictsAt(tx: Tx, partId: string, locationId: string, excludeId?: string | null): Promise<Pair[]> {
  const mine = await one(tx, `SELECT cp.storage_group_id, g.code, g.name FROM chemical_part cp JOIN chemical_storage_group g ON g.id = cp.storage_group_id WHERE cp.part_id = $1 AND cp.is_chemical`, [partId]);
  if (!mine) return [];
  const rows = await many(tx, `SELECT c.number, p.part_number, g.code, g.name, i.reason
    FROM chemical_container c JOIN chemical_part cp ON cp.part_id = c.part_id JOIN part p ON p.id = c.part_id JOIN chemical_storage_group g ON g.id = cp.storage_group_id
    JOIN chemical_incompatibility i ON (i.group_a = $2 AND i.group_b = cp.storage_group_id) OR (i.group_b = $2 AND i.group_a = cp.storage_group_id)
    WHERE c.location_id = $1 AND c.status IN ('in_storage', 'in_use') AND ($3::uuid IS NULL OR c.id <> $3) ORDER BY c.number`, [locationId, mine.storage_group_id, excludeId ?? null]);
  return rows.map((r) => ({ containerNumber: r.number, partNumber: r.part_number, groupCode: r.code, groupName: r.name, newGroupCode: mine.code, newGroupName: mine.name, reason: r.reason }));
}

/** Throws naming the pair when the placement is refused; returns the pairs when a permitted override lets it through (to be recorded), else null. */
async function assertPlacement(tx: Tx, actor: Actor, p: { partId: string; partNumber: string; location: { id: string; code: string; facility_id: string }; excludeId?: string | null; overrideReason?: string | null }) {
  const pairs = await conflictsAt(tx, p.partId, p.location.id, p.excludeId);
  if (!pairs.length) return null;
  const first = pairs[0]!;
  const named = `${p.partNumber} is in storage group ${first.newGroupCode} (${first.newGroupName}), and ${p.location.code} already holds ${first.partNumber} in storage group ${first.groupCode} (${first.groupName}); ${first.newGroupCode} and ${first.groupCode} are on the incompatible list`;
  if (!p.overrideReason) throw new AppError(409, 'incompatible_storage', `${named}. Choose another location.`, { pairs });
  if (!can(actor, 'chemicals.override', p.location.facility_id)) throw forbidden('chemicals.override');
  if (p.overrideReason.trim().length < 5) throw invalid('an override needs a reason of at least a few words');
  return pairs;
}

async function logOverride(tx: Tx, actor: Actor, c: { id: string; number: string; facility_id: string }, location: { id: string; code: string }, pairs: Pair[], reason: string) {
  await event(tx, actor, c, 'override', { location: location.code, pairs: pairs.map((x) => `${x.newGroupCode} with ${x.groupCode} (${x.containerNumber})`), reason: reason.trim() });
  await audit(tx, actor, { action: 'chemical.storage_override', entityType: 'chemical_container', entityId: c.id, facilityId: c.facility_id,
    data: { container: c.number, location: location.code, pairs, reason: reason.trim() } });
}

async function event(tx: Tx, actor: Actor, c: { id: string; facility_id: string }, kind: string, data: Record<string, unknown> = {}) {
  await tx.query('INSERT INTO chemical_container_event (tenant_id, facility_id, container_id, kind, data, created_by) VALUES ($1, $2, $3, $4, $5, $6)', [actor.tenantId, c.facility_id, c.id, kind, data, actor.userId]);
}

// ---------------------------------------------------------------------------
// Containers
// ---------------------------------------------------------------------------
const nextContainerNumber = async (tx: Tx, tenantId: string) => `CHM-${String(await nextSequence(tx, tenantId, 'chemical-container')).padStart(6, '0')}`;

/** Called by the stock ledger when a chemical part is received: one container per received lot, split by container size when given. */
export async function containersOnReceipt(tx: Tx, actor: Actor, r: { partId: string; location: { id: string; code: string; facility_id: string }; txnId: number; lots: LotMove[]; containerSize?: number | null; overrideReason?: string | null }) {
  if (!(await loadSettings(tx, actor.tenantId)).receiptContainers) return [];
  const part = (await one(tx, 'SELECT part_number, uom FROM part WHERE id = $1', [r.partId]))!;
  const override = await assertPlacement(tx, actor, { partId: r.partId, partNumber: part.part_number, location: r.location, overrideReason: r.overrideReason });
  const size = r.containerSize && r.containerSize > 0 ? r.containerSize : null;
  const made: { id: string; number: string }[] = [];
  for (const m of r.lots) {
    if (m.qty <= 0) continue;
    const lot = (await one(tx, 'SELECT id, number, expires_on FROM stock_lot WHERE id = $1', [m.lotId]))!;
    const count = size ? Math.ceil(r3(m.qty / size) - 1e-9) : 1;
    if (count > 200) throw invalid(`${count} containers is too many for one receipt; use a larger container size`);
    let left = m.qty;
    for (let i = 0; i < count; i++) {
      const q = size ? r3(Math.min(size, left)) : m.qty;
      left = r3(left - q);
      const c = (await one(tx, `INSERT INTO chemical_container (tenant_id, facility_id, number, part_id, lot_id, lot_number, initial_qty, qty, uom, location_id, expires_on, created_by)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $7, $8, $9, $10, $11) RETURNING id, number, facility_id`,
      [actor.tenantId, r.location.facility_id, await nextContainerNumber(tx, actor.tenantId), r.partId, lot.id, lot.number, q, part.uom, r.location.id, lot.expires_on, actor.userId]))!;
      await event(tx, actor, c, 'created', { qty: q, uom: part.uom, location: r.location.code, lot: lot.number, source: 'receipt', txnId: r.txnId });
      if (override) await logOverride(tx, actor, c, r.location, override, r.overrideReason!);
      made.push({ id: c.id, number: c.number });
    }
  }
  return made;
}

/**
 * Registers a container. With `receiveIntoStock` the quantity is received into the ledger first (and the container made by the receipt);
 * without it the stock must already be on the ledger at that location, and containers cannot hold more than the lot's balance there.
 */
export async function createContainer(tx: Tx, actor: Actor, input: { partId: string; locationId: string; lot: string; qty: number; expiresOn?: string | null; receiveIntoStock?: boolean; unitCost?: number | null; containerSize?: number | null; overrideReason?: string | null }) {
  const loc = await one(tx, 'SELECT id, code, facility_id, active FROM stock_location WHERE id = $1', [input.locationId]);
  if (!loc || !loc.active) throw notFound('location');
  requirePermission(actor, 'chemicals.manage', loc.facility_id);
  if (!(input.qty > 0)) throw invalid('the container quantity must be positive');
  const part = await one(tx, `SELECT p.id, p.part_number, p.uom FROM part p JOIN chemical_part cp ON cp.part_id = p.id AND cp.is_chemical WHERE p.id = $1`, [input.partId]);
  if (!part) throw invalid('that part is not marked as a chemical');
  if (input.receiveIntoStock) {
    requirePermission(actor, 'inventory.manage', loc.facility_id);
    const r = await postTxn(tx, actor, { locationId: loc.id, partId: part.id, type: 'receipt', qty: input.qty, unitCost: input.unitCost ?? null,
      lots: [{ lot: input.lot, qty: input.qty, expiresOn: input.expiresOn ?? null }], reference: 'Container received', chemical: { containerSize: input.containerSize ?? null, overrideReason: input.overrideReason ?? null } });
    return { containers: (r as any).containers ?? [] };
  }
  const lot = await one(tx, `SELECT id, number, expires_on, status FROM stock_lot WHERE part_id = $1 AND lower(number) = lower($2)`, [part.id, input.lot.trim()]);
  if (!lot) throw invalid(`lot ${input.lot} of ${part.part_number} is not in stock; receive it first (or tick receive into stock)`);
  const bal = await one(tx, 'SELECT qty::float AS qty FROM lot_balance WHERE location_id = $1 AND lot_id = $2', [loc.id, lot.id]);
  const held = await one(tx, `SELECT coalesce(sum(qty), 0) AS q FROM chemical_container WHERE lot_id = $1 AND location_id = $2 AND status IN ('in_storage', 'in_use')`, [lot.id, loc.id]);
  if (r3((held!.q as number) + input.qty) > (bal?.qty ?? 0) + 0.0005) {
    throw invalid(`the stock ledger holds ${bal?.qty ?? 0} ${part.uom} of lot ${lot.number} at ${loc.code}, and containers already account for ${held!.q}; this container needs ${input.qty}`);
  }
  const override = await assertPlacement(tx, actor, { partId: part.id, partNumber: part.part_number, location: loc, overrideReason: input.overrideReason });
  const c = (await one(tx, `INSERT INTO chemical_container (tenant_id, facility_id, number, part_id, lot_id, lot_number, initial_qty, qty, uom, location_id, expires_on, created_by)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $7, $8, $9, $10, $11) RETURNING id, number, facility_id`,
  [actor.tenantId, loc.facility_id, await nextContainerNumber(tx, actor.tenantId), part.id, lot.id, lot.number, input.qty, part.uom, loc.id, lot.expires_on, actor.userId]))!;
  await event(tx, actor, c, 'created', { qty: input.qty, uom: part.uom, location: loc.code, lot: lot.number, source: 'registered' });
  if (override) await logOverride(tx, actor, c, loc, override, input.overrideReason!);
  await audit(tx, actor, { action: 'chemical.container_created', entityType: 'chemical_container', entityId: c.id, facilityId: loc.facility_id, data: { container: c.number, part: part.part_number, lot: lot.number, qty: input.qty } });
  return { containers: [{ id: c.id, number: c.number }] };
}

const CONTAINER_SELECT = `SELECT c.id, c.number, c.facility_id, f.code AS facility_code, c.part_id, p.part_number, p.description, c.lot_id, c.lot_number, c.initial_qty, c.qty, c.uom, c.location_id,
    l.code AS location_code, l.name AS location_name, c.status, c.expires_on, c.opened_on, c.in_use_days, c.beyond_use_on, c.use_by, (c.use_by - current_date) AS days_left, c.emptied_on, c.disposed_on, c.disposal_note,
    lot.status AS lot_status, lot.hold_reason, cp.hazard_classes, cp.signal_word, cp.cas_number, g.code AS group_code, g.name AS group_name, c.created_at
  FROM chemical_container c JOIN part p ON p.id = c.part_id JOIN facility f ON f.id = c.facility_id JOIN stock_location l ON l.id = c.location_id JOIN stock_lot lot ON lot.id = c.lot_id
  LEFT JOIN chemical_part cp ON cp.part_id = c.part_id LEFT JOIN chemical_storage_group g ON g.id = cp.storage_group_id`;

const stateOf = (c: any) => (!ACTIVE.includes(c.status) ? c.status : c.days_left == null || c.days_left >= 0 ? 'ok' : c.beyond_use_on && c.beyond_use_on === c.use_by && c.beyond_use_on !== c.expires_on ? 'beyond_use' : 'expired');

export async function listContainers(tx: Tx, actor: Actor, q: { facilityId?: string; locationId?: string; partId?: string; q?: string; status?: string; withinDays?: number }) {
  requirePermission(actor, 'chemicals.view', q.facilityId);
  const rows = await many(tx, `${CONTAINER_SELECT}
    WHERE ($1::uuid IS NULL OR c.facility_id = $1) AND ($2::uuid IS NULL OR c.location_id = $2) AND ($3::uuid IS NULL OR c.part_id = $3)
      AND ($4::text IS NULL OR p.part_number ILIKE '%' || $4 || '%' OR p.description ILIKE '%' || $4 || '%' OR c.number ILIKE '%' || $4 || '%' OR c.lot_number ILIKE '%' || $4 || '%')
      AND (CASE WHEN $5::text = 'all' THEN true WHEN $5::text IS NULL OR $5::text = 'active' THEN c.status IN ('in_storage', 'in_use') ELSE c.status = $5::text END)
      AND ($6::int IS NULL OR (c.status IN ('in_storage', 'in_use') AND c.use_by IS NOT NULL AND c.use_by <= current_date + $6::int))
    ORDER BY c.use_by NULLS LAST, c.number LIMIT 500`, [q.facilityId ?? null, q.locationId ?? null, q.partId ?? null, q.q ?? null, q.status ?? null, q.withinDays ?? null]);
  return rows.filter((r) => can(actor, 'chemicals.view', r.facility_id)).map((r) => ({ ...r, state: stateOf(r) }));
}

export async function getContainer(tx: Tx, actor: Actor, id: string) {
  requirePermission(actor, 'chemicals.view');
  const c = await one(tx, `${CONTAINER_SELECT} WHERE c.id = $1`, [id]);
  if (!c) throw notFound('container');
  requirePermission(actor, 'chemicals.view', c.facility_id);
  const events = await many(tx, `SELECT e.id, e.kind, e.data, e.created_at, u.display_name AS by FROM chemical_container_event e LEFT JOIN app_user u ON u.id = e.created_by WHERE e.container_id = $1 ORDER BY e.id`, [id]);
  return { ...c, state: stateOf(c), events, canManage: can(actor, 'chemicals.manage', c.facility_id), canOverride: can(actor, 'chemicals.override', c.facility_id) };
}

async function lockContainer(tx: Tx, actor: Actor, id: string) {
  const c = await one(tx, `SELECT c.*, p.part_number, l.code AS location_code, cp.in_use_days AS part_in_use_days, lot.status AS lot_status, lot.hold_reason
    FROM chemical_container c JOIN part p ON p.id = c.part_id JOIN stock_location l ON l.id = c.location_id JOIN stock_lot lot ON lot.id = c.lot_id LEFT JOIN chemical_part cp ON cp.part_id = c.part_id
    WHERE c.id = $1 FOR UPDATE OF c`, [id]);
  if (!c) throw notFound('container');
  requirePermission(actor, 'chemicals.manage', c.facility_id);
  return c;
}

/** A container may be drawn from only while it is live, its lot is not on hold, and it is inside its use-by date. */
export function assertUsable(c: any, on = todayIso()) {
  if (!ACTIVE.includes(c.status)) throw invalid(`container ${c.number} is ${c.status.replace('_', ' ')}`);
  if (c.lot_status !== 'available') throw invalid(`lot ${c.lot_number} of ${c.part_number} is ${c.lot_status === 'hold' ? `on hold${c.hold_reason ? ` (${c.hold_reason})` : ''}` : c.lot_status}`);
  const by = c.use_by ? String(c.use_by).slice(0, 10) : null;
  if (by && by < on) throw invalid(`container ${c.number} passed its use-by date on ${by}${c.beyond_use_on && String(c.beyond_use_on).slice(0, 10) === by ? ' (beyond-use date after opening)' : ' (expiry)'}`);
}

export async function openContainer(tx: Tx, actor: Actor, id: string, input: { openedOn?: string | null } = {}) {
  const c = await lockContainer(tx, actor, id);
  if (c.status !== 'in_storage') throw invalid(`container ${c.number} is ${c.status.replace('_', ' ')}${c.opened_on ? ` (opened ${c.opened_on})` : ''}`);
  const on = input.openedOn ?? todayIso();
  if (on > todayIso()) throw invalid('a container cannot be opened in the future');
  assertUsable(c, on);
  const by = beyondUse(on, c.part_in_use_days, c.expires_on);
  await tx.query(`UPDATE chemical_container SET status = 'in_use', opened_on = $2, in_use_days = $3, beyond_use_on = $4 WHERE id = $1`, [id, on, c.part_in_use_days, by]);
  await event(tx, actor, c, 'opened', { openedOn: on, inUseDays: c.part_in_use_days, beyondUseOn: by, expiresOn: c.expires_on });
  await audit(tx, actor, { action: 'chemical.container_opened', entityType: 'chemical_container', entityId: id, facilityId: c.facility_id, data: { container: c.number, openedOn: on, beyondUseOn: by } });
  return { openedOn: on, beyondUseOn: by };
}

/** Records quantity drawn from a container (opening it if it is still sealed) and posts the issue to the stock ledger. */
export async function recordUse(tx: Tx, actor: Actor, id: string, input: { qty: number; reference: string; reason?: string | null }) {
  const c = await lockContainer(tx, actor, id);
  if (!(input.qty > 0)) throw invalid('the quantity used must be positive');
  if (!input.reference?.trim()) throw invalid('say what it was used for (job, test or preparation)');
  if (c.status === 'in_storage') await openContainer(tx, actor, id);
  const fresh = await one(tx, 'SELECT * FROM chemical_container WHERE id = $1', [id]);
  assertUsable({ ...c, ...fresh });
  if (input.qty > fresh!.qty + 0.0005) throw invalid(`container ${c.number} holds only ${fresh!.qty} ${c.uom}`);
  await drawFromContainer(tx, actor, { ...c, ...fresh }, input.qty, input.reference.trim(), input.reason ?? null);
}

/** Posts the issue and reduces the container; an empty container is marked so. Used by recordUse and preparations. */
export async function drawFromContainer(tx: Tx, actor: Actor, c: any, qty: number, reference: string, reason: string | null) {
  const loc = { id: c.location_id, facility_id: c.facility_id };
  await postTxn(tx, actor, { locationId: loc.id, partId: c.part_id, type: 'issue', qty: -qty, reference, reason, lots: [{ lot: c.lot_number, qty }] });
  const left = r3(c.qty - qty);
  await tx.query(`UPDATE chemical_container SET qty = $2::numeric, status = CASE WHEN $2::numeric = 0 THEN 'empty' ELSE status END, emptied_on = CASE WHEN $2::numeric = 0 THEN current_date ELSE emptied_on END WHERE id = $1`, [c.id, left]);
  await event(tx, actor, c, 'used', { qty, left, uom: c.uom, reference });
  if (left === 0) await event(tx, actor, c, 'emptied', { reference });
  await audit(tx, actor, { action: 'chemical.container_used', entityType: 'chemical_container', entityId: c.id, facilityId: c.facility_id, data: { container: c.number, qty, left, reference } });
}

export async function moveContainer(tx: Tx, actor: Actor, id: string, input: { toLocationId: string; overrideReason?: string | null }) {
  const c = await lockContainer(tx, actor, id);
  if (!ACTIVE.includes(c.status)) throw invalid(`container ${c.number} is ${c.status.replace('_', ' ')}`);
  if (input.toLocationId === c.location_id) throw invalid('the container is already there');
  const to = await one(tx, 'SELECT id, code, facility_id, active FROM stock_location WHERE id = $1', [input.toLocationId]);
  if (!to || !to.active) throw notFound('location');
  requirePermission(actor, 'chemicals.manage', to.facility_id);
  const override = await assertPlacement(tx, actor, { partId: c.part_id, partNumber: c.part_number, location: to, excludeId: id, overrideReason: input.overrideReason });
  const ref = `${c.number} move`;
  const out = await postTxn(tx, actor, { locationId: c.location_id, partId: c.part_id, type: 'transfer_out', qty: -c.qty, reference: ref, lots: [{ lot: c.lot_number, qty: c.qty }] });
  await postTxn(tx, actor, { locationId: to.id, partId: c.part_id, type: 'transfer_in', qty: c.qty, reference: ref, lots: out.lots.map((m) => ({ lot: m.lot, qty: -m.qty })) });
  await tx.query('UPDATE chemical_container SET location_id = $2, facility_id = $3 WHERE id = $1', [id, to.id, to.facility_id]);
  const moved = { id, number: c.number, facility_id: to.facility_id };
  await event(tx, actor, moved, 'moved', { from: c.location_code, to: to.code });
  if (override) await logOverride(tx, actor, moved, to, override, input.overrideReason!);
  await audit(tx, actor, { action: 'chemical.container_moved', entityType: 'chemical_container', entityId: id, facilityId: to.facility_id, data: { container: c.number, from: c.location_code, to: to.code } });
}

async function writeOff(tx: Tx, actor: Actor, c: any, reason: string) {
  if (c.qty > 0) await postTxn(tx, actor, { locationId: c.location_id, partId: c.part_id, type: 'adjustment', qty: -c.qty, reference: c.number, reason, lots: [{ lot: c.lot_number, qty: c.qty }] });
}

export async function markEmpty(tx: Tx, actor: Actor, id: string) {
  const c = await lockContainer(tx, actor, id);
  if (!ACTIVE.includes(c.status)) throw invalid(`container ${c.number} is ${c.status.replace('_', ' ')}`);
  await writeOff(tx, actor, c, `Container ${c.number} marked empty`);
  await tx.query(`UPDATE chemical_container SET qty = 0, status = 'empty', emptied_on = current_date WHERE id = $1`, [id]);
  await event(tx, actor, c, 'emptied', { written_off: c.qty, uom: c.uom });
  await audit(tx, actor, { action: 'chemical.container_emptied', entityType: 'chemical_container', entityId: id, facilityId: c.facility_id, data: { container: c.number, writtenOff: c.qty } });
}

export async function disposeContainer(tx: Tx, actor: Actor, id: string, input: { note: string; disposedOn?: string | null }) {
  const c = await lockContainer(tx, actor, id);
  if (c.status === 'disposed') throw invalid(`container ${c.number} is already disposed`);
  if (!input.note || input.note.trim().length < 3) throw invalid('say how it was disposed of (the note is kept with the record)');
  const on = input.disposedOn ?? todayIso();
  if (on > todayIso()) throw invalid('the disposal date is in the future');
  await writeOff(tx, actor, c, `Disposed: ${input.note.trim()}`);
  await tx.query(`UPDATE chemical_container SET qty = 0, status = 'disposed', disposed_on = $2, disposal_note = $3 WHERE id = $1`, [id, on, input.note.trim()]);
  await event(tx, actor, c, 'disposed', { note: input.note.trim(), disposedOn: on, written_off: c.qty, uom: c.uom });
  await audit(tx, actor, { action: 'chemical.container_disposed', entityType: 'chemical_container', entityId: id, facilityId: c.facility_id, data: { container: c.number, note: input.note.trim(), writtenOff: c.qty } });
}

// ---------------------------------------------------------------------------
// Locations, limits, overview
// ---------------------------------------------------------------------------
export async function listLocations(tx: Tx, actor: Actor) {
  requirePermission(actor, 'chemicals.view');
  const rows = await many(tx, `SELECT l.id, l.code, l.name, l.facility_id, f.code AS facility_code,
      (SELECT count(*)::int FROM chemical_container c WHERE c.location_id = l.id AND c.status IN ('in_storage', 'in_use')) AS containers
    FROM stock_location l JOIN facility f ON f.id = l.facility_id WHERE l.active ORDER BY f.code, l.code`);
  return rows.filter((r) => can(actor, 'chemicals.view', r.facility_id));
}

export async function listLimits(tx: Tx, actor: Actor, facilityId?: string) {
  requirePermission(actor, 'chemicals.view', facilityId);
  const rows = await many(tx, `SELECT x.id, x.facility_id, f.code AS facility_code, x.location_id, l.code AS location_code, x.hazard_class, h.label AS hazard_label, x.limit_qty, x.uom, x.note
    FROM chemical_location_limit x JOIN stock_location l ON l.id = x.location_id JOIN facility f ON f.id = x.facility_id LEFT JOIN chemical_hazard_class h ON h.code = x.hazard_class
    WHERE $1::uuid IS NULL OR x.facility_id = $1 ORDER BY f.code, l.code, x.hazard_class`, [facilityId ?? null]);
  return rows.filter((r) => can(actor, 'chemicals.view', r.facility_id));
}

export async function setLimit(tx: Tx, actor: Actor, input: { locationId: string; hazardClass: string; limitQty: number; uom: string; note?: string | null }) {
  const loc = await one(tx, 'SELECT id, code, facility_id FROM stock_location WHERE id = $1', [input.locationId]);
  if (!loc) throw notFound('location');
  requirePermission(actor, 'chemicals.manage', loc.facility_id);
  const s = await loadSettings(tx, actor.tenantId);
  if (!s.hazardClasses.some((h) => h.code === input.hazardClass)) throw invalid(`unknown hazard class ${input.hazardClass}`);
  if (!(input.limitQty >= 0)) throw invalid('the limit is zero or more');
  const uom = normalizeUom(input.uom);
  const prior = await one(tx, 'SELECT limit_qty, uom FROM chemical_location_limit WHERE location_id = $1 AND hazard_class = $2', [loc.id, input.hazardClass]);
  await tx.query(`INSERT INTO chemical_location_limit (tenant_id, facility_id, location_id, hazard_class, limit_qty, uom, note, updated_by) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
    ON CONFLICT (location_id, hazard_class) DO UPDATE SET limit_qty = EXCLUDED.limit_qty, uom = EXCLUDED.uom, note = EXCLUDED.note, updated_by = EXCLUDED.updated_by, updated_at = now()`,
  [actor.tenantId, loc.facility_id, loc.id, input.hazardClass, input.limitQty, uom, input.note?.trim() || null, actor.userId]);
  await audit(tx, actor, { action: 'chemical.limit_set', entityType: 'stock_location', entityId: loc.id, facilityId: loc.facility_id, data: { location: loc.code, hazardClass: input.hazardClass, limitQty: input.limitQty, uom, was: prior ?? null } });
}

export async function deleteLimit(tx: Tx, actor: Actor, id: string) {
  const x = await one(tx, 'SELECT x.*, l.code FROM chemical_location_limit x JOIN stock_location l ON l.id = x.location_id WHERE x.id = $1', [id]);
  if (!x) throw notFound('limit');
  requirePermission(actor, 'chemicals.manage', x.facility_id);
  await tx.query('DELETE FROM chemical_location_limit WHERE id = $1', [id]);
  await audit(tx, actor, { action: 'chemical.limit_removed', entityType: 'stock_location', entityId: x.location_id, facilityId: x.facility_id, data: { location: x.code, hazardClass: x.hazard_class } });
}

/** Counts for the top of the page. */
export async function overview(tx: Tx, actor: Actor) {
  requirePermission(actor, 'chemicals.view');
  const s = await getSettings(tx, actor);
  const parts = await listChemicalParts(tx, actor, {});
  const cs = (await many(tx, `SELECT facility_id, count(*)::int AS n, count(*) FILTER (WHERE use_by < current_date)::int AS past FROM chemical_container WHERE status IN ('in_storage', 'in_use') GROUP BY facility_id`))
    .filter((r) => can(actor, 'chemicals.view', r.facility_id));
  const preps = await many(tx, `SELECT facility_id, expires_on FROM chemical_preparation WHERE status = 'active'`);
  const today = todayIso();
  return {
    settings: { sdsMaxAgeYears: s.sdsMaxAgeYears, receiptContainers: s.receiptContainers },
    chemicalParts: parts.length, noSds: parts.filter((p) => p.sdsMissing).length, oldSds: parts.filter((p) => p.sdsOld).length, noGroup: parts.filter((p) => !p.storage_group_id).length,
    containers: cs.reduce((s, r) => s + r.n, 0), pastUseBy: cs.reduce((s, r) => s + r.past, 0),
    preparations: preps.filter((p) => can(actor, 'chemicals.view', p.facility_id)).length, preparationsExpired: preps.filter((p) => can(actor, 'chemicals.view', p.facility_id) && p.expires_on && p.expires_on < today).length,
  };
}
