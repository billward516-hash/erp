import { z } from 'zod';
import { many } from '../../platform/db/tx.js';
import { plural, reportScope } from './definitions.js';
import type { ReportDefinition, ReportResult } from './types.js';

export const kitReadinessReport: ReportDefinition = {
  id: 'kit-readiness',
  name: 'Kit readiness and critical spares',
  description: 'Upcoming work orders with planned parts and whether their kit is reserved, short, staged or missing; critical spares below their minimum at the site.',
  permission: 'work_orders.view',
  params: z.object({ facilityId: z.string().uuid().optional(), days: z.coerce.number().int().min(1).max(90).default(14) }),
  async run(tx, actor, params): Promise<ReportResult> {
    const scope = await reportScope(tx, actor, 'work_orders.view', params.facilityId);
    const wos = await many(tx, `
      SELECT w.id, w.number, w.title, w.wo_type, w.due_at, w.status, f.code AS facility, a.asset_tag,
             (SELECT count(*)::int FROM work_order_part x WHERE x.work_order_id = w.id AND x.qty_planned > x.qty_used) AS planned_lines,
             k.number AS kit, k.status AS kit_status,
             (SELECT count(*)::int FROM kit_line l WHERE l.kit_id = k.id AND l.qty_reserved < l.qty_needed) AS short_lines
      FROM work_order w JOIN facility f ON f.id = w.facility_id JOIN asset a ON a.id = w.asset_id
      LEFT JOIN kit k ON k.work_order_id = w.id AND k.status NOT IN ('closed', 'cancelled')
      WHERE w.facility_id = ANY ($1) AND w.status IN ('planned', 'scheduled', 'in_progress', 'on_hold')
        AND (w.due_at IS NULL OR w.due_at <= now() + make_interval(days => $2))
        AND EXISTS (SELECT 1 FROM work_order_part x WHERE x.work_order_id = w.id AND x.qty_planned > x.qty_used)
      ORDER BY w.due_at NULLS LAST, w.number`, [scope.ids, params.days]);
    const spares = await many(tx, `
      SELECT a.asset_tag, f.code AS facility, p.part_number, p.description, coalesce(ap.min_on_hand, 1)::float AS min_on_hand,
             coalesce((SELECT sum(b.qty_on_hand - (SELECT coalesce(sum(kl.qty_reserved - kl.qty_staged), 0) FROM kit_line kl JOIN kit k ON k.id = kl.kit_id
               WHERE kl.from_location_id = b.location_id AND kl.part_id = b.part_id AND k.status = 'reserved'))
               FROM inventory_balance b JOIN stock_location l ON l.id = b.location_id WHERE b.part_id = ap.part_id AND b.facility_id = a.facility_id AND l.kind = 'storeroom'), 0)::float AS available
      FROM asset_part ap JOIN asset a ON a.id = ap.asset_id JOIN part p ON p.id = ap.part_id JOIN facility f ON f.id = a.facility_id
      WHERE ap.critical AND a.facility_id = ANY ($1)`, [scope.ids]);
    const lowSpares = spares.filter((s) => s.available < s.min_on_hand);
    const state = (w: any) => (w.status === 'in_progress' && w.kit_status === 'issued' ? 'Issued'
      : !w.kit ? 'No kit' : w.kit_status === 'issued' ? 'Issued' : w.short_lines ? `Short ${plural(w.short_lines, 'line')}` : w.kit_status === 'staged' ? 'Staged' : 'Reserved');
    const rows = wos.map((w) => ({ ...w, readiness: state(w), wo_type: w.wo_type[0].toUpperCase() + w.wo_type.slice(1) }));
    const notReady = rows.filter((r) => r.readiness === 'No kit' || r.readiness.startsWith('Short'));
    const short = rows.filter((r) => r.readiness.startsWith('Short'));
    const none = rows.filter((r) => r.readiness === 'No kit');
    const headline = !rows.length ? `No work orders with planned parts due in the next ${params.days} days`
      : notReady.length ? `${notReady.length} of ${plural(rows.length, 'upcoming work order')} not ready: ${[short.length ? `${short.length} short of parts` : '', none.length ? `${none.length} without a kit` : ''].filter(Boolean).join(', ')}`
      : `All ${plural(rows.length, 'upcoming work order')} have their parts reserved or staged`;
    const insights: string[] = [];
    if (short.length) insights.push(`Short kits: ${short.slice(0, 4).map((r) => `${r.kit} for ${r.number} (${r.asset_tag})`).join(', ')}; request the missing parts from the work order.`);
    if (none.length) insights.push(`No kit yet: ${none.slice(0, 4).map((r) => `${r.number} (${r.asset_tag})`).join(', ')}.`);
    const staged = rows.filter((r) => r.readiness === 'Staged').length;
    if (rows.length) insights.push(`${staged} staged (physical kit), ${rows.filter((r) => r.readiness === 'Reserved').length} reserved in the storeroom (virtual kit).`);
    if (lowSpares.length) insights.push(`${plural(lowSpares.length, 'critical spare')} below minimum: ${lowSpares.slice(0, 4).map((s) => `${s.part_number} for ${s.asset_tag} (${s.available} of ${s.min_on_hand})`).join(', ')}.`);
    return {
      reportId: this.id, name: this.name, headline, generatedAt: new Date().toISOString(),
      scope: { facilities: scope.codes, description: scope.description }, filters: params,
      kpis: [
        { label: `Work orders with parts (${params.days} d)`, value: rows.length, type: 'integer', status: 'neutral' },
        { label: 'Kits ready', value: rows.length - notReady.length, type: 'integer', status: notReady.length ? 'watch' : 'good' },
        { label: 'Short of parts', value: short.length, type: 'integer', status: short.length ? 'bad' : 'good' },
        { label: 'Without a kit', value: none.length, type: 'integer', status: none.length ? 'watch' : 'good' },
        { label: 'Critical spares below minimum', value: lowSpares.length, type: 'integer', status: lowSpares.length ? 'bad' : 'good' },
      ],
      insights: insights.slice(0, 5),
      columns: [
        { key: 'number', label: 'Work order', type: 'text', width: 0.8 },
        { key: 'facility', label: 'Site', type: 'text', width: 0.5 },
        { key: 'asset_tag', label: 'Asset', type: 'text', width: 0.7 },
        { key: 'title', label: 'Work', type: 'text', width: 2 },
        { key: 'wo_type', label: 'Type', type: 'text', width: 0.7 },
        { key: 'due_at', label: 'Due', type: 'datetime', width: 1 },
        { key: 'planned_lines', label: 'Part lines', type: 'integer', width: 0.5 },
        { key: 'kit', label: 'Kit', type: 'text', width: 0.8 },
        { key: 'readiness', label: 'Readiness', type: 'text', width: 0.9 },
      ],
      rows,
      exceptions: rows.map((r, i) => (r.readiness === 'No kit' || r.readiness.startsWith('Short') ? i : -1)).filter((i) => i >= 0),
      drillDown: { rowKey: 'id', path: '/api/work-orders/{id}' },
      notes: [
        'Reserved = a virtual kit: the stock stays on its storeroom shelf but is no longer available to other work. Staged = a physical kit moved to a staging location through the stock ledger.',
        'Short = planned parts the site could not reserve when the kit was built or last refreshed; parts on order are not counted until received.',
        'Critical spares are parts marked critical on a machine\'s parts list; minimum defaults to 1 when none is set. Available excludes stock reserved by kits and stock in staging.',
      ],
      source: 'Work orders, kits, equipment parts lists and storeroom balances (live query)',
    };
  },
};
