import { many, one } from '../../../platform/db/tx.js';
import { activateLease, createLease, giveNotice, saveRentalUnit } from '../../leasing/service.js';
import { findExternalRef, flagDuplicates, saveExternalRef } from './common.js';
import type { TargetDefinition } from './types.js';

const UNIT_TYPE_SYNONYMS = {
  residential: ['residential', 'apartment', 'apt', 'townhome', 'townhouse', 'single family', 'condo', 'flat', 'studio', 'duplex'],
  commercial: ['commercial', 'retail', 'retail suite', 'office', 'office suite', 'suite', 'industrial', 'restaurant'],
  storage: ['storage', 'storage unit', 'locker'], parking: ['parking', 'garage', 'parking space', 'carport'],
};

/** Leasing details of units that already exist as spaces (load the unit directory as assets first). */
export const rentalUnitsTarget: TargetDefinition = {
  key: 'rental_units',
  label: 'Rental units (beds, size, market rent)',
  entityType: 'rental_unit',
  description: 'Makes existing spaces rentable with their type, bedrooms, bathrooms, size and market rent. Load units as assets (class space) first.',
  naturalKey: 'unit_tag',
  commitPermission: 'leasing.manage',
  supportsCustomFields: false,
  fields: [
    { key: 'unit_tag', label: 'Unit (asset tag)', type: 'string', required: true, synonyms: ['unit tag', 'unit id', 'space', 'asset tag', 'unit code'] },
    { key: 'unit_type', label: 'Unit type', type: 'enum', values: ['residential', 'commercial', 'storage', 'parking', 'other'], valueSynonyms: UNIT_TYPE_SYNONYMS, allowOther: false,
      synonyms: ['unit type', 'type', 'use', 'space type'] },
    { key: 'bedrooms', label: 'Bedrooms', type: 'number', min: 0, max: 50, synonyms: ['beds', 'bedrooms', 'bd', 'br'] },
    { key: 'bathrooms', label: 'Bathrooms', type: 'number', min: 0, max: 50, synonyms: ['baths', 'bathrooms', 'ba'] },
    { key: 'area_sqft', label: 'Area (sq ft)', type: 'integer', min: 1, synonyms: ['sq ft', 'sqft', 'square feet', 'area', 'size', 'rentable sf', 'rsf'] },
    { key: 'market_rent', label: 'Market rent (monthly)', type: 'number', min: 0, synonyms: ['market rent', 'asking rent', 'list rent', 'scheduled rent', 'rent'] },
    { key: 'offline', label: 'Offline (not rentable)', type: 'boolean', synonyms: ['offline', 'down unit', 'not rentable', 'model', 'admin unit'],
      valueSynonyms: { true: ['y', 'yes', 'offline', 'down', 'model', 'admin'], false: ['n', 'no', ''] } },
  ],
  async validate(ctx, rows) {
    flagDuplicates(rows, 'unit_tag', 'unit');
    const spaces = new Map((await many(ctx.tx, `SELECT lower(asset_tag) AS tag, asset_class, (SELECT 1 FROM rental_unit r WHERE r.asset_id = a.id) AS has FROM asset a`)).map((a) => [a.tag, a]));
    for (const row of rows) {
      const s = spaces.get(String(row.values.unit_tag ?? '').toLowerCase());
      if (!s) row.messages.push({ level: 'error', field: 'unit_tag', message: `no unit ${row.values.unit_tag}; load the unit directory as assets first` });
      else if (s.asset_class !== 'space') row.messages.push({ level: 'error', field: 'unit_tag', message: `${row.values.unit_tag} is equipment, not a space` });
      row.action = s?.has ? 'update' : 'create';
    }
  },
  async commitRow(ctx, row) {
    const v = row.values;
    const a = await one(ctx.tx, 'SELECT id, (SELECT id FROM rental_unit r WHERE r.asset_id = asset.id) AS unit_id FROM asset WHERE lower(asset_tag) = lower($1)', [v.unit_tag]);
    const u = await saveRentalUnit(ctx.tx, ctx.actor, { assetId: a.id, unitType: (v.unit_type as any) ?? undefined, bedrooms: v.bedrooms as number ?? null, bathrooms: v.bathrooms as number ?? null,
      areaSqft: v.area_sqft as number ?? null, marketRent: v.market_rent as number ?? null, offline: (v.offline as boolean) ?? false, offlineReason: v.offline ? 'imported as offline' : null });
    return { entityId: u.id, action: a.unit_id ? 'update' : 'create' };
  },
};

/**
 * Current and future leases from another system's rent roll: one row per lease with the unit, renter, dates,
 * rent and deposit. Renters become customers (matched by name and email). Leases already imported (same unit
 * and start date, or the same legacy ID) are left as they are.
 */
export const leasesTarget: TargetDefinition = {
  key: 'leases',
  label: 'Leases (rent roll)',
  entityType: 'lease',
  description: 'Leases in force or signed for the future, from a rent roll export. Units must be rental units first. Balances owed stay in the old system or accounting; this loads the leases, not the ledger.',
  naturalKey: 'unit_tag',
  commitPermission: 'leasing.manage',
  supportsCustomFields: false,
  fields: [
    { key: 'external_id', label: 'Legacy lease ID', type: 'string', synonyms: ['lease id', 'lease number', 'lease #', 'occupancy id', 'tenant id', 'resident id'] },
    { key: 'unit_tag', label: 'Unit (asset tag)', type: 'string', required: true, synonyms: ['unit tag', 'unit id', 'space', 'unit code'] },
    { key: 'renter_name', label: 'Renter', type: 'string', required: true, synonyms: ['tenant', 'tenant name', 'resident', 'resident name', 'renter', 'lessee', 'occupant', 'name'] },
    { key: 'renter_email', label: 'Renter email', type: 'string', synonyms: ['email', 'tenant email', 'resident email', 'e-mail'] },
    { key: 'renter_phone', label: 'Renter phone', type: 'string', synonyms: ['phone', 'tenant phone', 'mobile', 'cell', 'phone number'] },
    { key: 'organization', label: 'Company tenant', type: 'boolean', synonyms: ['company', 'commercial tenant', 'is company'] },
    { key: 'start_date', label: 'Lease start', type: 'date', required: true, synonyms: ['lease from', 'lease start', 'start', 'from', 'move in', 'move-in', 'commencement', 'start date'] },
    { key: 'end_date', label: 'Lease end', type: 'date', synonyms: ['lease to', 'lease end', 'end', 'to', 'expiration', 'lease expiration', 'end date', 'expires'] },
    { key: 'rent', label: 'Monthly rent', type: 'number', required: true, min: 0, synonyms: ['rent', 'monthly rent', 'current rent', 'base rent', 'lease rent', 'contract rent'] },
    { key: 'deposit', label: 'Security deposit', type: 'number', min: 0, synonyms: ['deposit', 'security deposit', 'sec dep', 'deposit held'] },
    { key: 'move_out_on', label: 'Notice: move-out date', type: 'date', synonyms: ['move out', 'move-out', 'notice move out', 'vacate date', 'expected move out'] },
  ],
  async validate(ctx, rows) {
    const units = new Map((await many(ctx.tx, `SELECT lower(a.asset_tag) AS tag, r.id FROM rental_unit r JOIN asset a ON a.id = r.asset_id`)).map((u) => [u.tag, u.id]));
    const existing = new Set((await many(ctx.tx, `SELECT unit_id, start_date::text AS s FROM lease WHERE status <> 'cancelled'`)).map((l) => `${l.unit_id}|${l.s}`));
    const seen = new Set<string>();
    for (const row of rows) {
      const v = row.values;
      const unit = units.get(String(v.unit_tag ?? '').toLowerCase());
      if (!unit) { row.messages.push({ level: 'error', field: 'unit_tag', message: `no rental unit ${v.unit_tag}; import rental units first` }); continue; }
      const key = `${unit}|${v.start_date}`;
      if (seen.has(key)) row.messages.push({ level: 'error', field: 'start_date', message: 'the same unit and start date appear twice in the file' });
      seen.add(key);
      if (v.end_date && v.start_date && String(v.end_date) < String(v.start_date)) row.messages.push({ level: 'error', field: 'end_date', message: 'the lease ends before it starts' });
      if (v.move_out_on && v.start_date && String(v.move_out_on) < String(v.start_date)) row.messages.push({ level: 'error', field: 'move_out_on', message: 'move-out before the lease started' });
      const known = (await findExternalRef(ctx, 'lease', v.external_id)) || existing.has(key);
      row.action = known ? 'unchanged' : 'create';
      if (known) row.messages.push({ level: 'warning', message: 'lease already imported; left as it is' });
    }
  },
  async commitRow(ctx, row) {
    const v = row.values;
    const unit = await one(ctx.tx, `SELECT r.id FROM rental_unit r JOIN asset a ON a.id = r.asset_id WHERE lower(a.asset_tag) = lower($1)`, [v.unit_tag]);
    const known = (await findExternalRef(ctx, 'lease', v.external_id)) ?? (await one(ctx.tx, `SELECT id FROM lease WHERE unit_id = $1 AND start_date = $2 AND status <> 'cancelled'`, [unit.id, v.start_date]))?.id;
    if (known) return { entityId: known, action: 'unchanged' };
    const email = v.renter_email ? String(v.renter_email).trim() : null;
    const renter = await one(ctx.tx, `SELECT id FROM customer WHERE lower(name) = lower($1) AND ($2::text IS NULL OR lower(email) = lower($2)) LIMIT 1`, [String(v.renter_name).trim(), email]);
    const l = await createLease(ctx.tx, ctx.actor, { unitId: unit.id, source: 'import', startDate: String(v.start_date), endDate: (v.end_date as string) ?? null, rentAmount: v.rent as number,
      depositAmount: (v.deposit as number) ?? 0, renter: renter ? { customerId: renter.id } : { name: String(v.renter_name), email, phone: (v.renter_phone as string) ?? null, organization: !!v.organization } });
    await activateLease(ctx.tx, ctx.actor, l.id, { depositReceivedOn: v.deposit ? String(v.start_date) : null });
    if (v.move_out_on) await giveNotice(ctx.tx, ctx.actor, l.id, { noticeOn: new Date().toISOString().slice(0, 10), moveOutOn: String(v.move_out_on) });
    await saveExternalRef(ctx, 'lease', v.external_id, l.id);
    return { entityId: l.id, action: 'create' };
  },
};
