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

/** Lots that need a decision (D-147): expired, expiring soon, or on hold, with the stock and its value. */
export const lotStatusReport: ReportDefinition = {
  id: 'lot-status',
  name: 'Lot expiry and holds',
  description: 'Tracked stock that is expired, expires within the window, or is on hold, by lot and storeroom, with its value at average cost.',
  permission: 'inventory.view',
  params: z.object({ facilityId: z.string().uuid().optional(), days: z.coerce.number().int().min(1).max(365).default(30) }),
  async run(tx, actor, params): Promise<ReportResult> {
    const scope = await reportScope(tx, actor, 'inventory.view', params.facilityId);
    const rows = (await many(tx, `
      SELECT l.id AS lot_id, f.code AS facility, sl.code AS location, p.part_number, p.description, l.number AS lot, l.kind, l.status, l.hold_reason, l.expires_on,
             (l.expires_on - current_date) AS days_left, lb.qty::float AS qty, p.uom, (lb.qty * coalesce(p.unit_cost, 0))::float AS value
      FROM lot_balance lb JOIN stock_lot l ON l.id = lb.lot_id JOIN part p ON p.id = l.part_id JOIN stock_location sl ON sl.id = lb.location_id JOIN facility f ON f.id = lb.facility_id
      WHERE lb.qty > 0 AND lb.facility_id = ANY ($1) AND (l.status = 'hold' OR (l.expires_on IS NOT NULL AND l.expires_on <= current_date + $2::int))
      ORDER BY (l.status = 'hold') DESC, l.expires_on NULLS LAST, p.part_number, l.number`, [scope.ids, params.days]))
      .map((r) => ({ ...r, state: r.status === 'hold' ? 'On hold' : r.days_left < 0 ? 'Expired' : 'Expiring', days_left: r.expires_on ? r.days_left : null }));
    const expired = rows.filter((r) => r.state === 'Expired'); const held = rows.filter((r) => r.state === 'On hold'); const soon = rows.filter((r) => r.state === 'Expiring');
    const sum = (rs: any[]) => Math.round(rs.reduce((s, r) => s + r.value, 0));
    const usd = (n: number) => n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
    const headline = !rows.length ? `No tracked stock expired, expiring within ${params.days} days, or on hold`
      : [expired.length ? `${plural(expired.length, 'lot')} expired (${usd(sum(expired))})` : '', soon.length ? `${plural(soon.length, 'lot')} expiring within ${params.days} days (${usd(sum(soon))})` : '',
        held.length ? `${plural(held.length, 'lot')} on hold (${usd(sum(held))})` : ''].filter(Boolean).join('; ');
    const insights: string[] = [];
    if (expired.length) insights.push(`Expired stock cannot be issued or shipped: scrap it, or extend the expiry after a retest, for ${expired.slice(0, 4).map((r) => `${r.part_number} ${r.lot}`).join(', ')}.`);
    if (soon.length) insights.push(`Use first: ${soon.slice(0, 4).map((r) => `${r.part_number} ${r.lot} (${r.days_left} days)`).join(', ')}. Issues already take the first-expiring lot.`);
    if (held.length) insights.push(`On hold: ${held.slice(0, 4).map((r) => `${r.part_number} ${r.lot}${r.hold_reason ? ` (${r.hold_reason})` : ''}`).join('; ')}.`);
    return {
      reportId: this.id, name: this.name, headline, generatedAt: new Date().toISOString(),
      scope: { facilities: scope.codes, description: scope.description }, filters: params,
      kpis: [
        { label: 'Expired', value: sum(expired), type: 'currency', note: plural(expired.length, 'lot'), status: expired.length ? 'bad' : 'good' },
        { label: `Expiring within ${params.days} days`, value: sum(soon), type: 'currency', note: plural(soon.length, 'lot'), status: soon.length ? 'watch' : 'good' },
        { label: 'On hold', value: sum(held), type: 'currency', note: plural(held.length, 'lot'), status: held.length ? 'watch' : 'good' },
      ],
      insights,
      columns: [
        { key: 'facility', label: 'Site', type: 'text', width: 0.4 }, { key: 'location', label: 'Storeroom', type: 'text', width: 0.6 },
        { key: 'part_number', label: 'Part', type: 'text', width: 0.8 }, { key: 'description', label: 'Description', type: 'text', width: 1.4 },
        { key: 'lot', label: 'Lot / serial', type: 'text', width: 0.8 }, { key: 'qty', label: 'On hand', type: 'number', width: 0.5 },
        { key: 'expires_on', label: 'Expires', type: 'date', width: 0.6 }, { key: 'days_left', label: 'Days left', type: 'integer', width: 0.5 },
        { key: 'state', label: 'State', type: 'text', width: 0.5 }, { key: 'hold_reason', label: 'Hold reason', type: 'text', width: 1.2 },
        { key: 'value', label: 'Value', type: 'currency', width: 0.6 },
      ],
      rows,
      exceptions: rows.map((r, i) => (r.state !== 'Expiring' ? i : -1)).filter((i) => i >= 0),
      drillDown: { rowKey: 'lot_id', path: '/api/lots/{lot_id}' },
      notes: ['Lot- and serial-tracked parts only. Value at the part\'s average cost.', 'Expired and held lots are never issued or shipped; they can still be moved, counted or scrapped.'],
      source: 'Lot balances and lot records (stock_lot, lot_balance).',
    };
  },
};
