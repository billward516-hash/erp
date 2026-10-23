import { many, one } from '../../../platform/db/tx.js';
import { saveGroup, saveSite, SITE_KINDS } from '../../sites/service.js';
import { flagDuplicates } from './common.js';
import type { TargetDefinition } from './types.js';

/**
 * Sites from a property list, store list or plant list: one row per property, store or plant, with its address
 * and the portfolio, region or district it belongs to (groups are created on the fly and their membership is
 * added to, never replaced). Matched by site code.
 */
export const sitesTarget: TargetDefinition = {
  key: 'sites',
  label: 'Sites (properties, stores, plants)',
  entityType: 'facility',
  description: 'One row per property, store, plant or warehouse with its address and optional group (portfolio, region, district). Administrators only.',
  naturalKey: 'code',
  commitPermission: 'tenant.admin',
  supportsCustomFields: false,
  fields: [
    { key: 'code', label: 'Site code', type: 'string', required: true, maxLength: 30,
      synonyms: ['code', 'site code', 'property code', 'property id', 'property', 'store number', 'store no', 'store #', 'store', 'location code', 'location id', 'building code', 'plant code', 'site id', 'site'] },
    { key: 'name', label: 'Name', type: 'string', required: true, maxLength: 200,
      synonyms: ['name', 'site name', 'property name', 'store name', 'building name', 'location name', 'plant name', 'description'] },
    { key: 'kind', label: 'Kind', type: 'enum', values: [...SITE_KINDS],
      valueSynonyms: { property: ['property', 'residential', 'multifamily', 'multi-family', 'apartment', 'commercial', 'office building', 'retail center', 'mixed use', 'building', 'single family'],
        store: ['store', 'shop', 'retail', 'outlet', 'branch', 'restaurant', 'location'], plant: ['plant', 'factory', 'manufacturing', 'mill', 'shop floor'],
        warehouse: ['warehouse', 'dc', 'distribution center', 'depot'], office: ['office', 'hq', 'headquarters'] },
      synonyms: ['kind', 'type', 'site type', 'property type', 'store format', 'format', 'use'] },
    { key: 'line1', label: 'Street address', type: 'string', synonyms: ['address', 'street', 'address 1', 'address line 1', 'street address', 'addr1'] },
    { key: 'line2', label: 'Address line 2', type: 'string', synonyms: ['address 2', 'address line 2', 'addr2', 'suite'] },
    { key: 'city', label: 'City', type: 'string', synonyms: ['city', 'town', 'municipality'] },
    { key: 'region', label: 'State / region', type: 'string', synonyms: ['state', 'st', 'province', 'region code', 'county'] },
    { key: 'postal', label: 'Postal code', type: 'string', synonyms: ['zip', 'zip code', 'postal code', 'postcode'] },
    { key: 'country', label: 'Country', type: 'string', synonyms: ['country', 'country code'] },
    { key: 'timezone', label: 'Time zone', type: 'string', synonyms: ['time zone', 'timezone', 'tz'] },
    { key: 'group_code', label: 'Group (portfolio / region / district)', type: 'string',
      synonyms: ['portfolio', 'region', 'district', 'market', 'area', 'group', 'owner entity', 'fund'] },
    { key: 'group_kind', label: 'Group kind', type: 'enum', values: ['portfolio', 'region', 'district', 'other'],
      valueSynonyms: { portfolio: ['portfolio', 'fund', 'owner'], region: ['region', 'market', 'area'], district: ['district'] }, synonyms: ['group type', 'group kind'] },
    { key: 'active', label: 'Active', type: 'boolean', synonyms: ['active', 'status'],
      valueSynonyms: { true: ['active', 'open', 'a', 'owned', 'managed'], false: ['inactive', 'closed', 'sold', 'disposed', 'i'] } },
  ],

  async validate(ctx, rows) {
    flagDuplicates(rows, 'code', 'site code');
    const existing = new Map((await many(ctx.tx, 'SELECT id, lower(code) AS code FROM facility')).map((f) => [f.code, f.id]));
    for (const row of rows) {
      const v = row.values;
      if (v.code && !/^[A-Za-z0-9][A-Za-z0-9._-]{0,29}$/.test(String(v.code).trim())) {
        row.messages.push({ level: 'error', field: 'code', message: 'site codes are up to 30 letters, digits, dots, dashes or underscores' });
      }
      if (v.timezone) {
        try { new Intl.DateTimeFormat('en-US', { timeZone: String(v.timezone) }); } catch { row.messages.push({ level: 'error', field: 'timezone', message: `unknown time zone "${v.timezone}" (use names like America/Chicago)` }); }
      }
      if (!v.kind) { v.kind = 'property'; row.messages.push({ level: 'warning', field: 'kind', message: 'no kind given; imported as a property' }); }
      const match = existing.get(String(v.code ?? '').toLowerCase());
      row.action = match ? 'update' : 'create';
      if (ctx.mode === 'create_only' && match) row.messages.push({ level: 'error', field: 'code', message: 'site already exists (mode is create only)' });
      if (ctx.mode === 'update_only' && !match) row.messages.push({ level: 'error', field: 'code', message: 'site not found (mode is update only)' });
    }
  },

  async commitRow(ctx, row) {
    const v = row.values;
    const cur = await one(ctx.tx, 'SELECT id, timezone, address, kind FROM facility WHERE lower(code) = lower($1)', [v.code]);
    const address = { ...(cur?.address ?? {}), ...Object.fromEntries(['line1', 'line2', 'city', 'region', 'postal', 'country'].filter((k) => v[k] != null).map((k) => [k, v[k]])) };
    const f = await saveSite(ctx.tx, ctx.actor, { id: cur?.id, code: String(v.code).trim(), name: String(v.name), kind: (v.kind as any) ?? cur?.kind ?? 'property',
      timezone: (v.timezone as string) ?? cur?.timezone ?? 'America/New_York', address, active: (v.active as boolean | null) ?? undefined });
    if (v.group_code) {
      const g = await one(ctx.tx, `SELECT g.id, g.code, g.name, g.kind, coalesce(array_agg(m.facility_id) FILTER (WHERE m.facility_id IS NOT NULL), '{}') AS ids
        FROM facility_group g LEFT JOIN facility_group_member m ON m.group_id = g.id WHERE lower(g.code) = lower($1) GROUP BY g.id`, [String(v.group_code).trim()]);
      if (!g) await saveGroup(ctx.tx, ctx.actor, { code: String(v.group_code).trim().slice(0, 30), name: String(v.group_code).trim(), kind: (v.group_kind as any) ?? 'portfolio', facilityIds: [f.id] });
      else if (!g.ids.includes(f.id)) await saveGroup(ctx.tx, ctx.actor, { id: g.id, code: g.code, name: g.name, kind: g.kind, facilityIds: [...g.ids, f.id] });
    }
    return { entityId: f.id, action: cur ? 'update' : 'create' };
  },
};
