import { z } from 'zod';
import { DOC_TYPES, searchDocuments } from '../documents/service.js';
import { plural } from './definitions.js';
import type { ReportDefinition, ReportResult } from './types.js';

const day = (d: unknown) => (d ? new Date(d as string).toISOString().slice(0, 10) : null);

/**
 * The document master list (D-168): every controlled document the reader may see, with the revision in force, when it
 * took effect, who approved it, what is in review or waiting for its date, and for external documents the issuer's
 * number and revision. The list an auditor asks for first.
 */
export const documentMasterListReport: ReportDefinition = {
  id: 'document-master-list',
  name: 'Document master list',
  description: 'Every controlled document with its revision in force, effective date, approver, owner and status; external documents with the issuer\'s number and revision.',
  permission: 'documents.view',
  params: z.object({ docType: z.enum(DOC_TYPES).optional(), origin: z.enum(['internal', 'external']).optional(), status: z.enum(['active', 'obsolete']).optional() }),
  async run(tx, actor, params): Promise<ReportResult> {
    const docs = await searchDocuments(tx, actor, { docType: params.docType, origin: params.origin, status: params.status, limit: 1000 });
    const inForce = docs.filter((d) => d.current_version_id);
    const noRelease = docs.filter((d) => !d.current_version_id);
    const inReview = docs.filter((d) => d.open_version_status === 'in_review');
    const pending = docs.filter((d) => d.pending_version_label);
    const external = docs.filter((d) => d.origin === 'external');
    const rows = docs.map((d) => ({ number: d.doc_number, title: d.title, type: d.type_label, site: d.facility_code ?? 'Company', folder: d.folder_name ?? '',
      issuer: d.origin === 'external' ? `${d.issuer}${d.issuer_doc_number ? ` ${d.issuer_doc_number}` : ''}${d.current_issuer_revision ? ` rev ${d.current_issuer_revision}` : ''}` : '',
      revision: d.current_version_label ?? '—', effective: day(d.current_effective_on ?? d.current_approved_at), approved: day(d.current_approved_at), owner: d.owner_name ?? '',
      next: d.pending_version_label ? `rev ${d.pending_version_label} from ${day(d.pending_effective_on)}` : d.open_version_status === 'in_review' ? 'in review' : d.open_version_status === 'draft' ? 'draft' : '',
      access: d.restricted ? 'restricted' : d.limited ? 'limited roles' : 'all', status: d.status }));
    return {
      reportId: this.id, name: this.name, generatedAt: new Date().toISOString(), scope: { facilities: [], description: 'Documents you may see' }, filters: params,
      headline: !docs.length ? 'No controlled documents' : `${plural(inForce.length, 'document')} in force, ${external.length} external; ${inReview.length} in review, ${pending.length} waiting for their effective date`,
      kpis: [
        { label: 'In force', value: inForce.length, type: 'integer', status: 'neutral' },
        { label: 'External', value: external.length, type: 'integer', status: 'neutral' },
        { label: 'In review', value: inReview.length, type: 'integer', status: inReview.length ? 'watch' : 'good' },
        { label: 'Waiting for effective date', value: pending.length, type: 'integer', status: 'neutral' },
        { label: 'Never released', value: noRelease.length, type: 'integer', status: noRelease.length ? 'watch' : 'good' },
      ],
      insights: [
        ...(pending.length ? [`Taking effect soon: ${pending.slice(0, 4).map((d) => `${d.doc_number} rev ${d.pending_version_label} on ${day(d.pending_effective_on)}`).join('; ')}. Train people before then.`] : []),
        ...(noRelease.length ? [`${plural(noRelease.length, 'document')} with no released version: ${noRelease.slice(0, 5).map((d) => d.doc_number).join(', ')}.`] : []),
      ],
      columns: [
        { key: 'number', label: 'Number', type: 'text', width: 0.7 }, { key: 'title', label: 'Title', type: 'text', width: 1.8 }, { key: 'type', label: 'Kind', type: 'text', width: 1 },
        { key: 'site', label: 'Site', type: 'text', width: 0.5 }, { key: 'folder', label: 'Folder', type: 'text', width: 0.8 }, { key: 'issuer', label: 'Issuer, number, revision', type: 'text', width: 1.2 },
        { key: 'revision', label: 'Rev', type: 'text', width: 0.4 }, { key: 'effective', label: 'Effective', type: 'date', width: 0.7 }, { key: 'approved', label: 'Approved', type: 'date', width: 0.7 },
        { key: 'owner', label: 'Owner', type: 'text', width: 0.8 }, { key: 'next', label: 'Next', type: 'text', width: 0.9 }, { key: 'access', label: 'Access', type: 'text', width: 0.6 },
      ],
      rows,
      exceptions: rows.map((r, i) => (r.revision === '—' ? i : -1)).filter((i) => i >= 0),
      notes: [
        'Released versions cannot be changed or deleted (database guard); each keeps its file checksum, author, reviewers, approver, reason for change and effective date.',
        'Every opening of a document file is logged with the reader and the revision. Read access is by site, by the restricted flag, and by the roles set on the document or its folder.',
      ],
      source: 'Document server (live query)',
    } as unknown as ReportResult;
  },
};
