import { many, one } from '../../../platform/db/tx.js';
import type { AssetInput } from '../../assets/service.js';
import { createAsset, ensureLocationPath, recordState, updateAsset } from '../../assets/service.js';
import { facilityLookup, findExternalRef, flagDuplicates, resolveFacility, saveExternalRef } from './common.js';
import type { PlannedRow, TargetDefinition } from './types.js';

const FIELD_TO_INPUT: Record<string, keyof AssetInput> = {
  asset_tag: 'assetTag', name: 'name', asset_class: 'assetClass', category: 'category', manufacturer: 'manufacturer',
  model: 'model', serial_number: 'serialNumber', commissioned_on: 'commissionedOn', warranty_expires_on: 'warrantyExpiresOn',
  criticality: 'criticality', lifecycle_status: 'lifecycleStatus', responsible_team: 'responsibleTeam', vendor_name: 'vendorName',
  rated_capacity: 'ratedCapacity', rated_capacity_unit: 'ratedCapacityUnit', replacement_cost: 'replacementCost',
};

export const assetsTarget: TargetDefinition = {
  key: 'assets',
  label: 'Assets / equipment register',
  entityType: 'asset',
  description: 'Equipment, components, tools and facility systems. Locations are created from paths like "Bldg 2 > Line 3"; components reference their parent by tag.',
  naturalKey: 'asset_tag',
  commitPermission: 'assets.manage',
  supportsCustomFields: true,
  fields: [
    { key: 'external_id', label: 'Legacy record ID', type: 'string', synonyms: ['legacy id', 'record id', 'source id', 'system id', 'internal id', 'cmms id', 'uid'] },
    { key: 'asset_tag', label: 'Asset tag / number', type: 'string', required: true, maxLength: 64,
      synonyms: ['asset number', 'asset no', 'asset tag', 'tag', 'tag number', 'equipment number', 'equipment id', 'equipment no', 'machine number', 'machine id', 'unit number', 'asset id', 'asset code', 'equipment code', 'equipment'] },
    { key: 'name', label: 'Name / description', type: 'string', required: true, maxLength: 200,
      synonyms: ['description', 'asset name', 'equipment name', 'equipment description', 'asset description', 'machine name', 'machine', 'name'] },
    { key: 'facility_code', label: 'Facility / site', type: 'string', synonyms: ['site', 'plant', 'facility', 'site code', 'plant code', 'facility code', 'branch',
      'property', 'property code', 'property id', 'building code', 'store', 'store number', 'store no', 'store #', 'location code'] },
    { key: 'location_path', label: 'Location path', type: 'string',
      description: 'Hierarchy separated by ">" or "/", e.g. "Building 2 > Line 3". Missing locations are created.',
      synonyms: ['location', 'area', 'line', 'building', 'functional location', 'department location', 'cell', 'work center', 'location path', 'position'] },
    { key: 'parent_asset_tag', label: 'Parent asset tag', type: 'string',
      synonyms: ['parent', 'parent asset', 'parent equipment', 'parent tag', 'parent asset number', 'component of', 'belongs to', 'assembly', 'parent id'] },
    { key: 'asset_class', label: 'Asset class', type: 'enum', values: ['equipment', 'component', 'tool', 'vehicle', 'facility_system', 'it', 'space'],
      synonyms: ['class', 'asset class', 'equipment class', 'record type'],
      valueSynonyms: { equipment: ['machine', 'equip', 'production equipment', 'asset'], component: ['comp', 'subassembly', 'sub assembly', 'sub-assembly', 'child', 'module'],
        tool: ['tooling', 'fixture', 'gauge', 'jig'], vehicle: ['forklift', 'truck', 'mobile equipment', 'lift truck'],
        facility_system: ['utility', 'building system', 'hvac', 'facility', 'building'], it: ['computer', 'network', 'it equipment'],
        space: ['unit', 'apartment', 'apt', 'suite', 'room', 'space', 'common area', 'premises', 'sales floor', 'back room', 'restroom', 'office space'] } },
    { key: 'category', label: 'Category / type', type: 'string', synonyms: ['type', 'asset type', 'equipment type', 'category', 'group', 'asset group', 'equipment category'] },
    { key: 'manufacturer', label: 'Manufacturer', type: 'string', synonyms: ['make', 'manufacturer', 'brand', 'oem', 'maker', 'builder'] },
    { key: 'model', label: 'Model', type: 'string', synonyms: ['model', 'model number', 'model no', 'model name'] },
    { key: 'serial_number', label: 'Serial number', type: 'string', synonyms: ['serial', 'serial number', 'serial no', 'sn'] },
    { key: 'commissioned_on', label: 'In-service date', type: 'date',
      synonyms: ['install date', 'installed', 'installation date', 'in service date', 'in service', 'commissioned', 'commission date', 'startup date', 'date installed', 'service start'] },
    { key: 'warranty_expires_on', label: 'Warranty expiration', type: 'date', synonyms: ['warranty', 'warranty expiration', 'warranty end', 'warranty expires', 'warranty date', 'warranty exp'] },
    { key: 'criticality', label: 'Criticality', type: 'enum', values: ['high', 'medium', 'low'],
      synonyms: ['criticality', 'critical', 'importance', 'risk', 'priority class', 'abc', 'abc class', 'criticality rating'],
      valueSynonyms: { high: ['a', '1', 'critical', 'h', 'very high', 'vital', 'crit'], medium: ['b', '2', 'med', 'm', 'moderate', 'normal', 'essential'], low: ['c', '3', 'l', 'minor', 'non critical', 'noncritical', 'd', '4'] } },
    { key: 'lifecycle_status', label: 'Lifecycle status', type: 'enum', values: ['planned', 'active', 'inactive', 'disposed'],
      synonyms: ['status', 'asset status', 'lifecycle', 'lifecycle status', 'equipment status'],
      valueSynonyms: { active: ['in service', 'operational', 'in use', 'active', 'a', 'running', 'ok'], inactive: ['inactive', 'spare', 'stored', 'standby', 'mothballed', 'idle', 'not in use'],
        disposed: ['retired', 'scrapped', 'sold', 'disposed', 'decommissioned', 'removed'], planned: ['planned', 'on order', 'pending install', 'pending', 'new'] } },
    { key: 'operational_state', label: 'Current operating state', type: 'enum',
      values: ['available', 'running', 'idle', 'planned_downtime', 'unplanned_downtime', 'out_of_service'],
      synonyms: ['state', 'current state', 'condition', 'operating status', 'machine status', 'up down'],
      valueSynonyms: { available: ['up', 'ok', 'available', 'good', 'ready'], running: ['running', 'producing', 'in production', 'run'], idle: ['idle', 'waiting'],
        planned_downtime: ['pm', 'planned down', 'scheduled maintenance', 'planned maintenance'], unplanned_downtime: ['down', 'broken', 'failed', 'breakdown', 'not working'],
        out_of_service: ['out of service', 'oos', 'locked out', 'tagged out', 'loto', 'red tagged'] } },
    { key: 'responsible_team', label: 'Responsible team', type: 'string', synonyms: ['team', 'crew', 'responsible', 'maintenance group', 'shop', 'trade', 'owner', 'responsible team'] },
    { key: 'vendor_name', label: 'Vendor / service provider', type: 'string', synonyms: ['vendor', 'supplier', 'purchased from', 'dealer', 'service vendor', 'distributor'] },
    { key: 'rated_capacity', label: 'Rated capacity', type: 'number', min: 0, synonyms: ['capacity', 'rated capacity', 'max capacity', 'nameplate capacity', 'rating'] },
    { key: 'rated_capacity_unit', label: 'Capacity unit', type: 'string', synonyms: ['capacity unit', 'capacity uom', 'rating unit', 'units'] },
    { key: 'replacement_cost', label: 'Replacement cost', type: 'number', min: 0, synonyms: ['replacement cost', 'replacement value', 'asset value', 'value', 'cost'] },
  ],

  order(rows) {
    // Parents before components (within the file); cycles/unknowns keep file order and fail validation.
    const byTag = new Map(rows.map((r) => [String(r.values.asset_tag ?? '').toLowerCase(), r]));
    const out: PlannedRow[] = [];
    const state = new Map<PlannedRow, 'visiting' | 'done'>();
    const visit = (r: PlannedRow) => {
      if (state.get(r) === 'done' || state.get(r) === 'visiting') return;
      state.set(r, 'visiting');
      const parent = r.values.parent_asset_tag ? byTag.get(String(r.values.parent_asset_tag).toLowerCase()) : undefined;
      if (parent && parent !== r) visit(parent);
      state.set(r, 'done');
      out.push(r);
    };
    rows.forEach(visit);
    return out;
  },

  async validate(ctx, rows) {
    flagDuplicates(rows, 'asset_tag', 'asset tag');
    flagDuplicates(rows, 'external_id', 'legacy ID');
    const facilities = await facilityLookup(ctx);
    const tagsInFile = new Map(rows.map((r) => [String(r.values.asset_tag ?? '').toLowerCase(), r]));
    const existing = new Map(
      (await many(ctx.tx, 'SELECT id, asset_tag, facility_id FROM asset')).map((a) => [String(a.asset_tag).toLowerCase(), a]),
    );
    for (const row of rows) {
      const f = resolveFacility(ctx, row, facilities);
      if (f) row.values._facility_id = f.id;
      const tag = String(row.values.asset_tag ?? '').toLowerCase();
      const byRef = await findExternalRef(ctx, 'asset', row.values.external_id);
      const match = byRef ? { id: byRef } : existing.get(tag);
      row.action = match ? 'update' : 'create';
      if (match) row.values._existing_id = match.id;
      if (ctx.mode === 'create_only' && match) row.messages.push({ level: 'error', field: 'asset_tag', message: 'asset already exists (mode is create only)' });
      if (ctx.mode === 'update_only' && !match) row.messages.push({ level: 'error', field: 'asset_tag', message: 'asset not found (mode is update only)' });
      const existingRow = existing.get(tag);
      if (existingRow && f && existingRow.facility_id !== f.id) {
        row.messages.push({ level: 'error', field: 'facility_code', message: 'asset exists at a different facility; moving assets is not supported' });
      }
      const parentTag = row.values.parent_asset_tag ? String(row.values.parent_asset_tag).toLowerCase() : null;
      if (parentTag) {
        if (parentTag === tag) row.messages.push({ level: 'error', field: 'parent_asset_tag', message: 'asset cannot be its own parent' });
        else if (!tagsInFile.has(parentTag) && !existing.has(parentTag)) {
          row.messages.push({ level: 'error', field: 'parent_asset_tag', message: `parent asset "${row.values.parent_asset_tag}" not found in this file or the register` });
        } else if (!row.values.asset_class) row.values.asset_class = 'component';
      }
      if (row.values.operational_state && row.action === 'update') {
        row.messages.push({ level: 'warning', field: 'operational_state', message: 'state is only applied to new assets; use a downtime/state import to change history' });
      }
    }
  },

  async commitRow(ctx, row) {
    const v = row.values;
    const facilityId = v._facility_id as string;
    const input: Partial<AssetInput> = {};
    for (const [field, key] of Object.entries(FIELD_TO_INPUT)) {
      // null (blank cell) never overwrites existing data on update
      if (v[field] !== undefined && (v[field] !== null || row.action === 'create')) (input as any)[key] = v[field];
    }
    if (v.location_path) {
      input.locationId = await ensureLocationPath(ctx.tx, ctx.actor, facilityId, String(v.location_path).split(/\s*(?:>|\/|\\|\|)\s*/));
    }
    if (v.parent_asset_tag) {
      const p = await one(ctx.tx, 'SELECT id FROM asset WHERE lower(asset_tag) = lower($1)', [v.parent_asset_tag]);
      input.parentAssetId = p.id;
    }
    if (v.custom_fields && Object.keys(v.custom_fields).length) input.customFields = v.custom_fields;

    const existingId = (await findExternalRef(ctx, 'asset', v.external_id))
      ?? (await one(ctx.tx, 'SELECT id FROM asset WHERE lower(asset_tag) = lower($1)', [v.asset_tag]))?.id;
    let entityId: string;
    let action: 'create' | 'update' | 'unchanged';
    if (existingId) {
      const r = await updateAsset(ctx.tx, ctx.actor, existingId, input);
      entityId = existingId;
      action = r.changed ? 'update' : 'unchanged';
    } else {
      const asset = await createAsset(ctx.tx, ctx.actor, { ...(input as AssetInput), facilityId });
      entityId = asset.id;
      action = 'create';
      if (v.operational_state && v.operational_state !== 'available') {
        await recordState(ctx.tx, ctx.actor, entityId, { state: v.operational_state as any, source: 'import', note: 'initial state from import' });
      }
    }
    await saveExternalRef(ctx, 'asset', v.external_id, entityId);
    return { entityId, action };
  },
};
