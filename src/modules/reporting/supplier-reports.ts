import { z } from 'zod';
import { supplierScorecards, THRESHOLDS } from '../purchasing/supplier-performance.js';
import { pct, plural } from './definitions.js';
import type { ReportDefinition, ReportResult } from './types.js';

const LABEL: Record<string, string> = { poor: 'Poor', watch: 'Watch', good: 'Good', none: 'Too little data' };

export const supplierPerformanceReport: ReportDefinition = {
  id: 'supplier-performance',
  name: 'Supplier performance',
  description: 'Each supplier\'s on-time delivery, rejected parts per million, price against quote and open corrective action requests over the period, worst first.',
  permission: 'purchasing.view',
  params: z.object({ from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), facilityId: z.string().uuid().optional() }),
  async run(tx, actor, params): Promise<ReportResult> {
    const r = await supplierScorecards(tx, actor, params);
    const rated = r.suppliers.filter((s) => s.overall !== 'none');
    const poor = r.suppliers.filter((s) => s.overall === 'poor');
    const lines = r.suppliers.reduce((t, s) => t + s.delivery.linesDue, 0); const onTime = r.suppliers.reduce((t, s) => t + (s.delivery.onTime ?? 0) * s.delivery.linesDue, 0);
    const recv = r.suppliers.reduce((t, s) => t + s.quality.inspected, 0); const rej = r.suppliers.reduce((t, s) => t + s.quality.rejected, 0);
    const headline = !r.suppliers.length ? 'No supplier activity in the period'
      : poor.length ? `${plural(poor.length, 'supplier')} rated poor: ${poor.slice(0, 3).map((s) => s.name).join(', ')}${poor.length > 3 ? '…' : ''}`
        : `No supplier rated poor; ${lines ? `${pct(onTime / lines)} of order lines on time` : 'no order lines due'}`;
    const insights: string[] = [];
    if (lines) insights.push(`${pct(onTime / lines)} of ${lines} order lines due in the period arrived complete on time; ${r.suppliers.reduce((t, s) => t + s.delivery.openPastDue, 0)} are still open past due.`);
    if (recv) insights.push(`${Math.round((rej / recv) * 1e6).toLocaleString('en-US')} ppm rejected across ${Math.round(recv).toLocaleString('en-US')} parts inspected (${plural(r.suppliers.reduce((t, s) => t + s.quality.ncrs, 0), 'nonconformance')}).`);
    const overdue = r.suppliers.flatMap((s) => s.scars.filter((c) => c.overdue).map((c) => `${s.name} ${c.number}`));
    if (overdue.length) insights.push(`Corrective action requests not answered on time: ${overdue.join(', ')}.`);
    const above = r.suppliers.filter((s) => s.price.aboveQuote).map((s) => `${s.name} (${s.price.aboveQuote} of ${s.price.lines} lines)`);
    if (above.length) insights.push(`Ordered above the quoted price: ${above.slice(0, 4).join(', ')}.`);
    const noDate = r.suppliers.reduce((t, s) => t + s.delivery.withoutDate, 0);
    const rows = r.suppliers.map((s) => ({ supplier: `${s.code} ${s.name}`, rating: LABEL[s.overall], lines_due: s.delivery.linesDue, on_time: s.delivery.onTime, avg_days_late: s.delivery.avgDaysLate,
      received: s.quality.received, ppm: s.quality.ppm, ncrs: s.quality.ncrs, above_quote: s.price.aboveQuote, invoice_variance: s.price.invoiceVariance, open_scars: s.scars.length }));
    return {
      reportId: this.id, name: this.name, headline, generatedAt: new Date().toISOString(), period: { from: r.from, to: r.to },
      scope: { facilities: [], description: params.facilityId ? 'One site' : 'All sites you can see' }, filters: params,
      kpis: [
        { label: 'Suppliers rated', value: rated.length, type: 'integer', status: 'neutral' },
        { label: 'Rated poor', value: poor.length, type: 'integer', status: poor.length ? 'bad' : 'good' },
        { label: 'Lines on time', value: lines ? onTime / lines : null, type: 'percent', status: !lines ? 'neutral' : onTime / lines >= THRESHOLDS.onTime.good ? 'good' : onTime / lines >= THRESHOLDS.onTime.watch ? 'watch' : 'bad' },
        { label: 'Rejected ppm', value: recv ? Math.round((rej / recv) * 1e6) : null, type: 'integer', status: !recv ? 'neutral' : (rej / recv) * 1e6 <= THRESHOLDS.ppm.good ? 'good' : 'watch' },
      ],
      insights: insights.slice(0, 5),
      columns: [
        { key: 'supplier', label: 'Supplier', type: 'text', width: 1.3 }, { key: 'rating', label: 'Rating', type: 'text', width: 0.6 }, { key: 'lines_due', label: 'Lines due', type: 'integer', width: 0.5 },
        { key: 'on_time', label: 'On time', type: 'percent', width: 0.5 }, { key: 'avg_days_late', label: 'Avg days late', type: 'number', width: 0.5 }, { key: 'received', label: 'Received', type: 'integer', width: 0.6 },
        { key: 'ppm', label: 'Rejected ppm', type: 'integer', width: 0.6 }, { key: 'ncrs', label: 'NCRs', type: 'integer', width: 0.4 }, { key: 'above_quote', label: 'Above quote', type: 'integer', width: 0.5 },
        { key: 'invoice_variance', label: 'Invoice vs PO', type: 'currency', width: 0.6 }, { key: 'open_scars', label: 'Open SCARs', type: 'integer', width: 0.5 },
      ],
      rows,
      exceptions: rows.map((x, i) => (x.rating === 'Poor' ? i : -1)).filter((i) => i >= 0),
      notes: [
        `On time = an order line received complete on or before its expected date; lines still open past it count as late; lines without an expected date (${noDate}) are not rated. Fewer than ${THRESHOLDS.minLines} lines due: delivery not rated.`,
        `Ratings: on time ≥ ${pct(THRESHOLDS.onTime.good)} good, ≥ ${pct(THRESHOLDS.onTime.watch)} watch; rejected ≤ ${THRESHOLDS.ppm.good.toLocaleString('en-US')} ppm good, ≤ ${THRESHOLDS.ppm.watch.toLocaleString('en-US')} watch; a corrective action request past its response date makes the supplier poor. The overall rating is the worst of these.`,
        'Rejected ppm = rejected ÷ (received + rejected at receiving): lots held at receiving count as inspected. Rejected quantities come from nonconformances raised at receiving or against the supplier in the period, and from rejects in imported delivery history.',
      ],
      source: 'Purchase orders, receipts, nonconformances, supplier prices, supplier invoices and corrective actions',
    };
  },
};
