import { z } from 'zod';
import { many } from '../../platform/db/tx.js';
import { plural } from './definitions.js';
import type { ReportDefinition, ReportResult } from './types.js';

const day = (d: unknown) => (d ? new Date(d as string).toISOString().slice(0, 10) : null);

/**
 * Specification reviews (D-169): every new revision of a customer specification or standard, when it was received,
 * when its impact review was due and decided, the outcome, and the revisions of our documents it led to. The evidence
 * of timely review an IATF 16949 auditor asks for (7.5.3.2.2).
 */
export const specReviewReport: ReportDefinition = {
  id: 'spec-reviews',
  name: 'Specification reviews',
  description: 'New revisions of customer specifications and standards: received, due, decided, on time or late, the outcome and the follow-up revisions of our documents.',
  permission: 'documents.view',
  params: z.object({ days: z.coerce.number().int().min(30).max(1825).default(365) }),
  async run(tx, _actor, params): Promise<ReportResult> {
    const rows0 = await many(tx, `SELECT r.id, d.doc_number, d.title, d.issuer, d.issuer_doc_number, v.issuer_revision, pv.issuer_revision AS previous_revision, r.received_on, r.due_on, r.status,
        r.assessed_at, bu.display_name AS assessed_by, m.number AS moc_number, (r.status = 'open' AND r.due_on < current_date) AS overdue,
        CASE WHEN r.status = 'open' THEN NULL ELSE r.assessed_at::date <= r.due_on END AS on_time,
        (SELECT count(*)::int FROM spec_review_followup f WHERE f.review_id = r.id) AS followups,
        (SELECT count(*)::int FROM spec_review_followup f WHERE f.review_id = r.id AND f.status = 'open') AS followups_open
      FROM spec_review r JOIN document d ON d.id = r.document_id JOIN document_version v ON v.id = r.version_id LEFT JOIN document_version pv ON pv.id = r.previous_version_id
        LEFT JOIN app_user bu ON bu.id = r.assessed_by LEFT JOIN moc_change m ON m.id = r.moc_change_id
      WHERE r.received_on > current_date - $1::int ORDER BY r.received_on DESC`, [params.days]);
    const decided = rows0.filter((r) => r.status !== 'open');
    const onTime = decided.filter((r) => r.on_time);
    const open = rows0.filter((r) => r.status === 'open'); const late = open.filter((r) => r.overdue);
    const changes = decided.filter((r) => r.status === 'changes_required');
    const followupsOpen = rows0.reduce((s, r) => s + r.followups_open, 0);
    const rate = decided.length ? Math.round((1000 * onTime.length) / decided.length) / 1000 : null;
    const rows = rows0.map((r) => ({ spec: `${r.doc_number} ${r.title}`, issuer: `${r.issuer}${r.issuer_doc_number ? ` ${r.issuer_doc_number}` : ''}`,
      revision: `${r.previous_revision ? `${r.previous_revision} → ` : ''}${r.issuer_revision ?? ''}`, received: day(r.received_on), due: day(r.due_on), decided: day(r.assessed_at),
      result: r.status === 'open' ? (r.overdue ? 'open, late' : 'open') : `${r.status === 'no_impact' ? 'no impact' : 'changes required'}${r.on_time ? '' : ' (late)'}`,
      followups: r.followups ? `${r.followups - r.followups_open} of ${r.followups} done` : r.moc_number ?? '', by: r.assessed_by ?? '' }));
    return {
      reportId: this.id, name: this.name, generatedAt: new Date().toISOString(), scope: { facilities: [], description: 'Documents you may see' }, filters: params,
      period: { from: new Date(Date.now() - params.days * 86_400_000).toISOString().slice(0, 10), to: new Date().toISOString().slice(0, 10) },
      headline: !rows0.length ? `No specification revisions received in the last ${params.days} days`
        : `${rate == null ? 'None decided yet' : `${Math.round(rate * 100)}% reviewed on time`} (${onTime.length} of ${decided.length}); ${plural(open.length, 'review')} open${late.length ? `, ${late.length} late` : ''}`,
      kpis: [
        { label: 'Reviewed on time', value: rate, type: 'percent', status: rate == null ? 'neutral' : rate < 1 ? 'watch' : 'good' },
        { label: 'Open', value: open.length, type: 'integer', status: open.length ? 'watch' : 'good' },
        { label: 'Late', value: late.length, type: 'integer', status: late.length ? 'bad' : 'good' },
        { label: 'Needed changes', value: changes.length, type: 'integer', status: 'neutral' },
        { label: 'Document revisions still to do', value: followupsOpen, type: 'integer', status: followupsOpen ? 'watch' : 'good' },
      ],
      insights: [
        ...(late.length ? [`Late: ${late.slice(0, 4).map((r) => `${r.doc_number} rev ${r.issuer_revision} (due ${day(r.due_on)})`).join('; ')}.`] : []),
        ...(changes.length ? [`${plural(changes.length, 'revision')} required changes to our documents or processes.`] : []),
      ],
      columns: [
        { key: 'spec', label: 'Specification', type: 'text', width: 1.8 }, { key: 'issuer', label: 'Issuer', type: 'text', width: 1.1 }, { key: 'revision', label: 'Revision', type: 'text', width: 0.6 },
        { key: 'received', label: 'Received', type: 'date', width: 0.7 }, { key: 'due', label: 'Due', type: 'date', width: 0.7 }, { key: 'decided', label: 'Decided', type: 'date', width: 0.7 },
        { key: 'result', label: 'Result', type: 'text', width: 1 }, { key: 'followups', label: 'Follow-ups', type: 'text', width: 0.8 }, { key: 'by', label: 'Reviewed by', type: 'text', width: 0.8 },
      ],
      rows,
      exceptions: rows0.map((r, i) => (r.overdue || r.on_time === false ? i : -1)).filter((i) => i >= 0),
      notes: ['Due dates count working days (Monday to Friday) from the day the revision was received, at the company’s setting (10 by default). A revision cannot be put in force before its review is decided.'],
      source: 'Document server specification reviews (live query)',
    } as unknown as ReportResult;
  },
};
