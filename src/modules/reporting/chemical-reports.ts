import { z } from 'zod';
import { many } from '../../platform/db/tx.js';
import { baseUnit, convertQty, olderThanYears, todayIso } from '../chemicals/rules.js';
import { plural, reportScope } from './definitions.js';
import type { ReportDefinition, ReportResult } from './types.js';

/** Chemical reports (SC-007 C). The platform ships no regulatory limits: the only limits here are ones the company set per location. */
const fmt = (n: number) => (Math.round(n * 1000) / 1000).toLocaleString('en-US', { maximumFractionDigits: 3 });

export const hazardousInventoryReport: ReportDefinition = {
  id: 'hazardous-inventory',
  name: 'Hazardous inventory by location',
  description: 'Chemicals in storage by location and hazard class, against the limit the company set for that location and class (none are set by the platform).',
  permission: 'chemicals.view',
  params: z.object({ facilityId: z.string().uuid().optional(), locationId: z.string().uuid().optional() }),
  async run(tx, actor, params): Promise<ReportResult> {
    const scope = await reportScope(tx, actor, 'chemicals.view', params.facilityId);
    const containers = await many(tx, `SELECT c.id, c.qty, c.uom, c.location_id, l.code AS location, f.code AS facility, cp.hazard_classes
      FROM chemical_container c JOIN stock_location l ON l.id = c.location_id JOIN facility f ON f.id = c.facility_id JOIN chemical_part cp ON cp.part_id = c.part_id
      WHERE c.status IN ('in_storage', 'in_use') AND c.facility_id = ANY ($1) AND ($2::uuid IS NULL OR c.location_id = $2) AND c.qty > 0`, [scope.ids, params.locationId ?? null]);
    const limits = await many(tx, `SELECT location_id, hazard_class, limit_qty, uom FROM chemical_location_limit WHERE facility_id = ANY ($1)`, [scope.ids]);
    const labels = new Map((await many(tx, 'SELECT code, label FROM chemical_hazard_class')).map((h) => [h.code as string, h.label as string]));
    const lim = new Map(limits.map((x) => [`${x.location_id}|${x.hazard_class}`, x]));
    const groups = new Map<string, { facility: string; location: string; location_id: string; hazard: string; unit: string; qty: number; n: number }>();
    let plain = 0;
    for (const c of containers) {
      if (!c.hazard_classes?.length) { plain++; continue; }
      const unit = baseUnit(c.uom);
      const q = convertQty(c.qty, c.uom, unit) ?? c.qty;
      for (const h of c.hazard_classes as string[]) {
        const k = `${c.location_id}|${h}|${unit}`;
        const g = groups.get(k) ?? { facility: c.facility, location: c.location, location_id: c.location_id, hazard: h, unit, qty: 0, n: 0 };
        g.qty += q; g.n += 1; groups.set(k, g);
      }
    }
    const rows = [...groups.values()].map((g) => {
      const l = lim.get(`${g.location_id}|${g.hazard}`);
      const limitBase = l ? convertQty(l.limit_qty, l.uom, g.unit) : null;
      const status = !l ? 'No limit set' : limitBase == null ? 'Units differ' : g.qty > limitBase + 1e-9 ? 'Over limit' : 'Within limit';
      return { facility: g.facility, location: g.location, hazard: labels.get(g.hazard) ?? g.hazard, containers: g.n, qty: Math.round(g.qty * 1000) / 1000, unit: g.unit,
        limit: limitBase == null ? null : Math.round(limitBase * 1000) / 1000, used: limitBase ? g.qty / limitBase : null, status };
    }).sort((a, b) => a.facility.localeCompare(b.facility) || a.location.localeCompare(b.location) || a.hazard.localeCompare(b.hazard));
    const over = rows.filter((r) => r.status === 'Over limit');
    const unset = rows.filter((r) => r.status === 'No limit set');
    const mismatch = rows.filter((r) => r.status === 'Units differ');
    const headline = !rows.length ? 'No hazard-classed chemicals in storage in scope'
      : over.length ? `${plural(over.length, 'location and hazard class')} over the limit the company set, of ${rows.length} in use`
        : `${plural(rows.length, 'location and hazard class')} in use; none over a limit the company set${unset.length ? ` (${unset.length} have no limit)` : ''}`;
    const insights: string[] = [];
    for (const r of over.slice(0, 3)) insights.push(`${r.location} ${r.hazard}: ${fmt(r.qty)} ${r.unit} against a limit of ${fmt(r.limit!)} ${r.unit}.`);
    if (unset.length) insights.push(`${plural(unset.length, 'location and hazard class')} have no limit set; the platform ships none. Set the ones your fire plan or permit requires on the Chemicals page.`);
    if (mismatch.length) insights.push(`${plural(mismatch.length, 'row')} have a limit in a different kind of unit (for example a limit in kilograms for a liquid held in litres); they are not compared.`);
    if (plain) insights.push(`${plural(plain, 'container')} of parts with no hazard class are not counted here.`);
    return {
      reportId: this.id, name: this.name, headline, generatedAt: new Date().toISOString(),
      scope: { facilities: scope.codes, description: scope.description }, filters: params,
      kpis: [
        { label: 'Location and class pairs', value: rows.length, type: 'integer', status: 'neutral' },
        { label: 'Over a company limit', value: over.length, type: 'integer', status: over.length ? 'bad' : 'good' },
        { label: 'No limit set', value: unset.length, type: 'integer', status: unset.length ? 'watch' : 'good' },
      ],
      insights: insights.slice(0, 5),
      columns: [
        { key: 'facility', label: 'Site', type: 'text', width: 0.4 }, { key: 'location', label: 'Location', type: 'text', width: 0.8 }, { key: 'hazard', label: 'Hazard class', type: 'text', width: 1 },
        { key: 'containers', label: 'Containers', type: 'integer', width: 0.5 }, { key: 'qty', label: 'Quantity', type: 'number', width: 0.6 }, { key: 'unit', label: 'Unit', type: 'text', width: 0.3 },
        { key: 'limit', label: 'Company limit', type: 'number', width: 0.6 }, { key: 'used', label: 'Of limit', type: 'percent', width: 0.5 }, { key: 'status', label: 'Status', type: 'text', width: 0.7 },
      ],
      rows,
      exceptions: rows.map((r, i) => (r.status === 'Over limit' ? i : -1)).filter((i) => i >= 0),
      notes: [
        'The platform ships no regulatory limits. A limit appears only where the company entered one for that location and hazard class; check yours against the rules that apply to your site.',
        'Quantity is what the containers in storage or in use still hold. A container with several hazard classes counts toward each class, so classes are not added together. Volumes are added in litres and masses in kilograms; other units are added as they are.',
        'Limits are compared only in the same kind of unit (volume with volume, mass with mass).',
      ],
      source: 'Chemical containers, parts and the limits set per location (chemical_container, chemical_part, chemical_location_limit).',
    };
  },
};

export const chemicalExpiryReport: ReportDefinition = {
  id: 'chemical-expiry',
  name: 'Chemical expiry and beyond-use dates',
  description: 'Containers in storage or in use, and prepared reagents, that are past their use-by date or reach it within the window.',
  permission: 'chemicals.view',
  params: z.object({ facilityId: z.string().uuid().optional(), days: z.coerce.number().int().min(1).max(365).default(30) }),
  async run(tx, actor, params): Promise<ReportResult> {
    const scope = await reportScope(tx, actor, 'chemicals.view', params.facilityId);
    const items = await many(tx, `
      SELECT 'Container' AS kind, c.number, p.part_number || ' ' || p.description AS item, c.lot_number AS lot, f.code AS facility, l.code AS location, c.qty, c.uom, c.opened_on, c.use_by, (c.use_by - current_date) AS days_left,
             (c.beyond_use_on IS NOT NULL AND c.beyond_use_on = c.use_by AND c.beyond_use_on IS DISTINCT FROM c.expires_on) AS beyond, c.id
      FROM chemical_container c JOIN part p ON p.id = c.part_id JOIN facility f ON f.id = c.facility_id JOIN stock_location l ON l.id = c.location_id
      WHERE c.facility_id = ANY ($1) AND c.status IN ('in_storage', 'in_use') AND c.use_by <= current_date + $2::int
      UNION ALL
      SELECT 'Preparation', x.number, x.name, NULL, f.code, NULL, x.qty_remaining, x.uom, x.prepared_on, x.expires_on, (x.expires_on - current_date), false, x.id
      FROM chemical_preparation x JOIN facility f ON f.id = x.facility_id WHERE x.facility_id = ANY ($1) AND x.status = 'active' AND x.expires_on <= current_date + $2::int
      ORDER BY 10, 2`, [scope.ids, params.days]);
    const rows = items.map((r) => ({ ...r, state: r.days_left < 0 ? (r.beyond ? 'Beyond use' : 'Expired') : 'Expiring' }));
    const past = rows.filter((r) => r.days_left < 0); const soon = rows.filter((r) => r.days_left >= 0);
    const headline = !rows.length ? `No chemicals past or reaching their use-by date within ${params.days} days`
      : [past.length ? `${plural(past.length, 'item')} past use-by and still in storage` : '', soon.length ? `${plural(soon.length, 'item')} reaching use-by within ${params.days} days` : ''].filter(Boolean).join('; ');
    const insights: string[] = [];
    if (past.length) insights.push(`Past use-by: ${past.slice(0, 4).map((r) => `${r.number} (${r.days_left * -1} days)`).join(', ')}. Dispose of them, or retest and record the decision outside this record.`);
    if (soon.length) insights.push(`Use first: ${soon.slice(0, 4).map((r) => `${r.number} (${r.days_left} days)`).join(', ')}.`);
    return {
      reportId: this.id, name: this.name, headline, generatedAt: new Date().toISOString(),
      scope: { facilities: scope.codes, description: scope.description }, filters: params,
      kpis: [
        { label: 'Past use-by, still in storage', value: past.length, type: 'integer', status: past.length ? 'bad' : 'good' },
        { label: `Reaching use-by within ${params.days} days`, value: soon.length, type: 'integer', status: soon.length ? 'watch' : 'good' },
      ],
      insights,
      columns: [
        { key: 'kind', label: 'Type', type: 'text', width: 0.6 }, { key: 'number', label: 'Number', type: 'text', width: 0.7 }, { key: 'item', label: 'Item', type: 'text', width: 1.6 },
        { key: 'lot', label: 'Lot', type: 'text', width: 0.7 }, { key: 'facility', label: 'Site', type: 'text', width: 0.4 }, { key: 'location', label: 'Location', type: 'text', width: 0.7 },
        { key: 'qty', label: 'Quantity', type: 'number', width: 0.5 }, { key: 'uom', label: 'Unit', type: 'text', width: 0.3 }, { key: 'opened_on', label: 'Opened / made', type: 'date', width: 0.6 },
        { key: 'use_by', label: 'Use by', type: 'date', width: 0.6 }, { key: 'days_left', label: 'Days left', type: 'integer', width: 0.5 }, { key: 'state', label: 'State', type: 'text', width: 0.6 },
      ],
      rows,
      exceptions: rows.map((r, i) => (r.days_left < 0 ? i : -1)).filter((i) => i >= 0),
      notes: ['Use by is the earlier of the lot expiry and, once opened, the opened date plus the part\'s in-use days. A prepared reagent\'s use-by is the earliest of its components\' dates and the shelf life stated when it was made.'],
      source: 'Chemical containers and preparations (chemical_container, chemical_preparation).',
    };
  },
};

export const chemicalExceptionsReport: ReportDefinition = {
  id: 'chemical-exceptions',
  name: 'Chemical exceptions',
  description: 'Chemical parts with no safety data sheet or one older than the company limit, no storage group, containers past use-by in storage, and storage-rule overrides.',
  permission: 'chemicals.view',
  params: z.object({ facilityId: z.string().uuid().optional(), days: z.coerce.number().int().min(1).max(730).default(90) }),
  async run(tx, actor, params): Promise<ReportResult> {
    const scope = await reportScope(tx, actor, 'chemicals.view', params.facilityId);
    const years = (await many(tx, 'SELECT sds_max_age_years FROM chemical_setting'))[0]?.sds_max_age_years ?? 3;
    const today = todayIso();
    const rows: { exception: string; item: string; detail: string; facility: string | null; on: string | null }[] = [];
    const parts = await many(tx, `SELECT p.part_number, p.description, cp.sds_document_id, cp.sds_revision_on, cp.storage_group_id, d.doc_number,
        coalesce((SELECT string_agg(DISTINCT f.code, ', ') FROM chemical_container c JOIN facility f ON f.id = c.facility_id WHERE c.part_id = cp.part_id AND c.status IN ('in_storage', 'in_use') AND c.facility_id = ANY ($1)), '') AS sites,
        (SELECT count(*)::int FROM chemical_container c WHERE c.part_id = cp.part_id AND c.status IN ('in_storage', 'in_use')) AS stored
      FROM chemical_part cp JOIN part p ON p.id = cp.part_id LEFT JOIN document d ON d.id = cp.sds_document_id WHERE cp.is_chemical ORDER BY p.part_number`, [scope.ids]);
    for (const p of parts) {
      const item = `${p.part_number} ${p.description}`;
      const site = p.sites || null;
      if (!p.sds_document_id) rows.push({ exception: 'No safety data sheet', item, detail: p.stored ? `${p.stored} container${p.stored === 1 ? '' : 's'} in storage` : 'None in storage', facility: site, on: null });
      else if (p.sds_revision_on && olderThanYears(p.sds_revision_on, years, today)) rows.push({ exception: `Safety data sheet older than ${years} years`, item, detail: `${p.doc_number}, revision dated ${p.sds_revision_on}`, facility: site, on: p.sds_revision_on });
      if (!p.storage_group_id) rows.push({ exception: 'No storage group', item, detail: 'Storage compatibility cannot be checked', facility: site, on: null });
    }
    const late = await many(tx, `SELECT c.number, p.part_number, f.code AS facility, l.code AS location, c.use_by FROM chemical_container c JOIN part p ON p.id = c.part_id JOIN facility f ON f.id = c.facility_id JOIN stock_location l ON l.id = c.location_id
      WHERE c.facility_id = ANY ($1) AND c.status IN ('in_storage', 'in_use') AND c.use_by < current_date ORDER BY c.use_by`, [scope.ids]);
    for (const c of late) rows.push({ exception: 'Past use-by, still in storage', item: `${c.number} ${c.part_number}`, detail: `At ${c.location}`, facility: c.facility, on: c.use_by });
    const overrides = await many(tx, `SELECT e.created_at, e.data, c.number, f.code AS facility, u.display_name AS by FROM chemical_container_event e JOIN chemical_container c ON c.id = e.container_id JOIN facility f ON f.id = e.facility_id
      LEFT JOIN app_user u ON u.id = e.created_by WHERE e.kind = 'override' AND e.facility_id = ANY ($1) AND e.created_at >= now() - make_interval(days => $2) ORDER BY e.created_at DESC`, [scope.ids, params.days]);
    for (const o of overrides) rows.push({ exception: 'Storage rule overridden', item: o.number, detail: `${o.by ?? 'Someone'}: ${o.data.reason} (${(o.data.pairs ?? []).join('; ')})`, facility: o.facility, on: String(o.created_at instanceof Date ? o.created_at.toISOString() : o.created_at).slice(0, 10) });
    const count = (k: string) => rows.filter((r) => r.exception.startsWith(k)).length;
    const headline = !rows.length ? 'No chemical exceptions in scope'
      : `${plural(rows.length, 'exception')}: ${[count('No safety') ? `${count('No safety')} with no safety data sheet` : '', count('Safety data sheet older') ? `${count('Safety data sheet older')} with an old sheet` : '', count('Past use-by') ? `${count('Past use-by')} past use-by in storage` : '', count('Storage rule') ? `${count('Storage rule')} storage overrides` : ''].filter(Boolean).join(', ') || 'see the list'}`;
    return {
      reportId: this.id, name: this.name, headline, generatedAt: new Date().toISOString(),
      scope: { facilities: scope.codes, description: scope.description }, filters: params,
      kpis: [
        { label: 'No safety data sheet', value: count('No safety'), type: 'integer', status: count('No safety') ? 'bad' : 'good' },
        { label: `Sheet older than ${years} years`, value: count('Safety data sheet older'), type: 'integer', status: count('Safety data sheet older') ? 'watch' : 'good' },
        { label: 'Past use-by in storage', value: count('Past use-by'), type: 'integer', status: count('Past use-by') ? 'bad' : 'good' },
        { label: `Storage overrides (${params.days} days)`, value: count('Storage rule'), type: 'integer', status: count('Storage rule') ? 'watch' : 'good' },
      ],
      insights: [],
      columns: [
        { key: 'exception', label: 'Exception', type: 'text', width: 1.2 }, { key: 'item', label: 'Item', type: 'text', width: 1.6 }, { key: 'detail', label: 'Detail', type: 'text', width: 2 },
        { key: 'facility', label: 'Site', type: 'text', width: 0.5 }, { key: 'on', label: 'Date', type: 'date', width: 0.6 },
      ],
      rows,
      exceptions: rows.map((_, i) => i),
      notes: [`A safety data sheet is flagged when its revision date is more than ${years} years old; the limit is a company setting on the Chemicals page, not a regulatory figure.`, 'Part-level rows (sheet, storage group) cover every chemical part; the site column shows where containers are stored.'],
      source: 'Chemical parts, containers and events (chemical_part, chemical_container, chemical_container_event) and the company settings.',
    };
  },
};

export const chemicalReports: ReportDefinition[] = [hazardousInventoryReport, chemicalExpiryReport, chemicalExceptionsReport];
