import { z } from 'zod';
import { many } from '../../platform/db/tx.js';
import { plural } from './definitions.js';
import type { ReportDefinition, ReportResult } from './types.js';

const day = (d: unknown) => (d ? new Date(d as string).toISOString().slice(0, 10) : null);

/**
 * Read and understood (D-170): for every revision that required it, how many people had to read it, how many did and
 * when, and who is overdue. The evidence that people were told about the revision they work to.
 */
export const documentReadsReport: ReportDefinition = {
  id: 'document-reads',
  name: 'Read and understood',
  description: 'For each document revision that required it: people who had to read it, who acknowledged it and when, and who is overdue.',
  permission: 'documents.manage',
  params: z.object({ days: z.coerce.number().int().min(30).max(1825).default(365) }),
  async run(tx, _actor, params): Promise<ReportResult> {
    const rev = await many(tx, `SELECT d.doc_number, d.title, v.revision, v.version_label, v.approved_at, min(o.due_on) AS due_on, count(*)::int AS required,
        count(*) FILTER (WHERE o.acknowledged_at IS NOT NULL)::int AS acknowledged,
        count(*) FILTER (WHERE o.acknowledged_at IS NULL AND o.superseded_at IS NULL AND o.due_on < current_date)::int AS overdue,
        count(*) FILTER (WHERE o.acknowledged_at IS NULL AND o.superseded_at IS NOT NULL)::int AS replaced,
        count(*) FILTER (WHERE o.acknowledged_at IS NOT NULL AND o.acknowledged_at::date > o.due_on)::int AS late
      FROM document_read_obligation o JOIN document d ON d.id = o.document_id JOIN document_version v ON v.id = o.version_id
      WHERE o.created_at > now() - make_interval(days => $1) GROUP BY d.doc_number, d.title, v.revision, v.version_label, v.approved_at ORDER BY d.doc_number, v.revision DESC`, [params.days]);
    const people = await many(tx, `SELECT u.display_name, d.doc_number, v.version_label, o.due_on FROM document_read_obligation o JOIN app_user u ON u.id = o.user_id JOIN document d ON d.id = o.document_id
      JOIN document_version v ON v.id = o.version_id WHERE o.acknowledged_at IS NULL AND o.superseded_at IS NULL AND o.due_on < current_date ORDER BY o.due_on LIMIT 200`);
    const counted = rev.map((r) => ({ ...r, counted: r.required - r.replaced }));
    const rows0 = counted;
    const required = counted.reduce((s, r) => s + r.counted, 0); const acknowledged = counted.reduce((s, r) => s + r.acknowledged, 0);
    const overdue = counted.reduce((s, r) => s + r.overdue, 0);
    const rate = required ? Math.round((1000 * acknowledged) / required) / 1000 : null;
    const rows = rows0.map((r) => ({ number: r.doc_number, title: r.title, revision: r.version_label, released: day(r.approved_at), due: day(r.due_on), required: r.counted, acknowledged: r.acknowledged,
      overdue: r.overdue, rate: r.counted ? Math.round((1000 * r.acknowledged) / r.counted) / 1000 : null }));
    return {
      reportId: this.id, name: this.name, generatedAt: new Date().toISOString(), scope: { facilities: [], description: 'Documents you may see' }, filters: params,
      period: { from: new Date(Date.now() - params.days * 86_400_000).toISOString().slice(0, 10), to: new Date().toISOString().slice(0, 10) },
      headline: !required ? 'No revisions have required reading in this period' : `${Math.round((rate ?? 0) * 100)}% read and acknowledged (${acknowledged} of ${required}); ${overdue ? `${plural(overdue, 'reading')} overdue` : 'none overdue'}`,
      kpis: [
        { label: 'Acknowledged', value: rate, type: 'percent', status: rate == null ? 'neutral' : rate >= 0.95 ? 'good' : 'watch' },
        { label: 'Required readings', value: required, type: 'integer', status: 'neutral' },
        { label: 'Overdue', value: overdue, type: 'integer', status: overdue ? 'bad' : 'good' },
        { label: 'Acknowledged late', value: counted.reduce((s, r) => s + r.late, 0), type: 'integer', status: 'neutral' },
      ],
      insights: people.length ? [`Overdue: ${[...new Set(people.map((p) => p.display_name))].slice(0, 6).join(', ')}${new Set(people.map((p) => p.display_name)).size > 6 ? ' and others' : ''}.`] : [],
      columns: [
        { key: 'number', label: 'Document', type: 'text', width: 0.8 }, { key: 'title', label: 'Title', type: 'text', width: 1.8 }, { key: 'revision', label: 'Rev', type: 'text', width: 0.4 },
        { key: 'released', label: 'Released', type: 'date', width: 0.7 }, { key: 'due', label: 'Due', type: 'date', width: 0.7 }, { key: 'required', label: 'Required', type: 'integer', width: 0.6 },
        { key: 'acknowledged', label: 'Acknowledged', type: 'integer', width: 0.7 }, { key: 'overdue', label: 'Overdue', type: 'integer', width: 0.6 }, { key: 'rate', label: 'Done', type: 'percent', width: 0.5 },
      ],
      rows, exceptions: rows.map((r, i) => (r.overdue ? i : -1)).filter((i) => i >= 0),
      notes: ['A person can acknowledge a revision only after opening it (the opening is logged). An acknowledgement cannot be changed or removed. A newer revision released before a reading was done replaces that reading, and it is left out of the counts.'],
      source: 'Document server read-and-understood records (live query)',
    } as unknown as ReportResult;
  },
};
