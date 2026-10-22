import { z } from 'zod';
import { listTurns, rentRoll } from '../leasing/service.js';
import { pct, plural, reportScope } from './definitions.js';
import type { ReportDefinition, ReportResult } from './types.js';

const money = (n: number) => Math.round(n * 100) / 100;
const usd = (n: number) => `$${n.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;

export const rentRollReport: ReportDefinition = {
  id: 'rent-roll',
  name: 'Rent roll and occupancy',
  description: 'Every rental unit with its renter, lease dates, rent and balance; occupancy, rent lost to vacancy, past-due rent, leases ending soon and unit turns running late.',
  permission: 'leasing.view',
  params: z.object({ facilityId: z.string().uuid().optional(), asOf: z.string().date().optional() }),
  async run(tx, actor, params): Promise<ReportResult> {
    const scope = await reportScope(tx, actor, 'leasing.view', params.facilityId);
    const asOf = params.asOf ?? new Date().toISOString().slice(0, 10);
    const all = (await rentRoll(tx, actor, { facilityId: params.facilityId, asOf })).filter((r) => scope.ids.includes(r.facilityId));
    const rentable = all.filter((r) => r.status !== 'offline');
    const occupied = rentable.filter((r) => r.status === 'occupied' || r.status === 'notice');
    const vacant = rentable.filter((r) => r.status === 'vacant');
    const occupancy = rentable.length ? occupied.length / rentable.length : null;
    const lossToVacancy = money(vacant.reduce((s, r) => s + (r.marketRent ?? 0), 0));
    const scheduled = money(occupied.reduce((s, r) => s + (r.rent ?? 0) + (r.charges ?? 0), 0));
    const pastDue = all.filter((r) => r.pastDue > 0);
    const pastDueTotal = money(pastDue.reduce((s, r) => s + r.pastDue, 0));
    const in60 = new Date(Date.parse(`${asOf}T00:00:00Z`) + 60 * 86_400_000).toISOString().slice(0, 10);
    const ending = occupied.filter((r) => r.status === 'occupied' && r.leaseEnd && r.leaseEnd >= asOf && r.leaseEnd <= in60 && !r.nextLeaseId);
    const notice = occupied.filter((r) => r.status === 'notice' && !r.nextLeaseId);
    const belowMarket = occupied.filter((r) => r.marketRent && r.rent != null && r.rent < r.marketRent * 0.95);
    const turns = (await listTurns(tx, actor, { facilityId: params.facilityId, open: true })).filter((t) => scope.ids.includes(t.facility_id));
    const lateTurns = turns.filter((t) => t.late);
    const headline = !all.length ? 'No rental units in scope'
      : `${pct(occupancy)} occupied (${occupied.length} of ${plural(rentable.length, 'rentable unit')}); ${usd(lossToVacancy)} a month lost to vacancy${pastDueTotal ? `; ${usd(pastDueTotal)} past due` : ''}`;
    const insights: string[] = [];
    if (vacant.length) insights.push(`Vacant: ${vacant.slice(0, 5).map((r) => `${r.unit}${r.daysVacant != null ? ` (${r.daysVacant} days)` : ''}${r.nextLease ? ', pre-leased' : ''}`).join(', ')}.`);
    if (ending.length || notice.length) insights.push(`${plural(ending.length, 'lease')} ending within 60 days with no renewal${ending.length ? ` (${ending.slice(0, 4).map((r) => `${r.unit} ${r.leaseEnd}`).join(', ')})` : ''}; ${plural(notice.length, 'renter')} on notice with no next lease.`);
    if (pastDue.length) insights.push(`Past due after the grace period: ${pastDue.sort((a, b) => b.pastDue - a.pastDue).slice(0, 4).map((r) => `${r.unit} ${r.renter ?? ''} ${usd(r.pastDue)}`).join('; ')}.`);
    if (lateTurns.length) insights.push(`${plural(lateTurns.length, 'unit turn')} past the target ready date: ${lateTurns.slice(0, 4).map((t) => `${t.asset_tag} (${t.days} days, ${t.open_jobs} open jobs)`).join(', ')}.`);
    if (belowMarket.length) insights.push(`${plural(belowMarket.length, 'unit')} let more than 5% below market rent; worth checking at renewal.`);
    const rows = all.map((r) => ({ ...r, status: r.status === 'notice' ? `notice (out ${r.moveOutOn})` : r.status, rent_total: r.rent == null ? null : money(r.rent + (r.charges ?? 0)) }));
    return {
      reportId: this.id, name: this.name, headline, generatedAt: new Date().toISOString(),
      scope: { facilities: scope.codes, description: scope.description }, filters: { ...params, asOf },
      kpis: [
        { label: 'Occupancy', value: occupancy, type: 'percent', status: occupancy == null ? 'neutral' : occupancy >= 0.95 ? 'good' : occupancy >= 0.9 ? 'watch' : 'bad', note: `${occupied.length} of ${rentable.length} rentable` },
        { label: 'Scheduled rent and charges', value: scheduled, type: 'currency', status: 'neutral', note: 'a month' },
        { label: 'Lost to vacancy', value: lossToVacancy, type: 'currency', status: lossToVacancy ? 'watch' : 'good', note: 'market rent, a month' },
        { label: 'Past due', value: pastDueTotal, type: 'currency', status: pastDueTotal ? 'bad' : 'good', note: 'after grace' },
        { label: 'Unit turns running late', value: lateTurns.length, type: 'integer', status: lateTurns.length ? 'watch' : 'good' },
      ],
      insights: insights.slice(0, 5),
      columns: [
        { key: 'facility', label: 'Property', type: 'text', width: 0.5 },
        { key: 'unit', label: 'Unit', type: 'text', width: 0.7 },
        { key: 'unitType', label: 'Type', type: 'text', width: 0.6 },
        { key: 'status', label: 'Status', type: 'text', width: 0.8 },
        { key: 'renter', label: 'Renter', type: 'text', width: 1.1 },
        { key: 'leaseStart', label: 'From', type: 'date', width: 0.6 },
        { key: 'leaseEnd', label: 'To', type: 'date', width: 0.6 },
        { key: 'marketRent', label: 'Market rent', type: 'currency', width: 0.6 },
        { key: 'rent_total', label: 'Rent + charges', type: 'currency', width: 0.6 },
        { key: 'deposit', label: 'Deposit', type: 'currency', width: 0.5 },
        { key: 'balance', label: 'Balance', type: 'currency', width: 0.5 },
        { key: 'pastDue', label: 'Past due', type: 'currency', width: 0.5 },
        { key: 'nextLease', label: 'Next lease', type: 'text', width: 1 },
      ],
      rows,
      exceptions: rows.map((r, i) => (r.pastDue > 0 || r.status === 'vacant' ? i : -1)).filter((i) => i >= 0),
      drillDown: { rowKey: 'leaseId', path: '/api/leases/{leaseId}' },
      notes: [
        'Occupied includes renters on notice. Offline units (renovation, model, office) are left out of occupancy and vacancy.',
        'Lost to vacancy = market rent of vacant rentable units for one month. Past due = invoices on the lease unpaid after their due date plus the lease\'s grace days.',
        'Balance and past due come from customer invoices and payments (with an API accounting connection, payments arrive from accounting). Security deposits are shown as agreed; the accounting system holds them.',
      ],
      source: 'Rental units, leases, customer invoices and payments, unit turns (live query)',
    };
  },
};
