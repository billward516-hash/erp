import type { Actor } from '../../platform/auth/actor.js';
import { decideStep } from '../../platform/approvals/engine.js';
import type { Tx } from '../../platform/db/tx.js';
import { onApprovalDecided } from '../moc/service.js';
import { onApprovalDecided as onPurchaseDecided } from '../purchasing/service.js';
import { onQuoteApprovalDecided } from '../sales/service.js';
import { onFmeaDecided } from '../quality/fmea.js';
import { onContinuityDecided } from '../continuity/service.js';
import { onExpenseDecided } from '../expenses/service.js';
import { onProformaDecided } from '../proforma/service.js';
import { onDocumentDecided } from '../documents/service.js';

/** Subject modules react to decisions here, inside the same transaction as the decision. */
const HANDLERS: Record<string, (tx: Tx, actor: Actor, subjectId: string, purpose: string, status: string) => Promise<void>> = {
  moc_change: onApprovalDecided,
  purchase_request: onPurchaseDecided,
  quote: onQuoteApprovalDecided,
  fmea: onFmeaDecided,
  continuity_plan: onContinuityDecided,
  expense_report: onExpenseDecided,
  proforma: onProformaDecided,
  document_version: onDocumentDecided,
};

export async function decideApproval(tx: Tx, actor: Actor, stepId: string, input: { decision: 'approve' | 'reject'; comment?: string | null }) {
  const r = await decideStep(tx, actor, stepId, input);
  await HANDLERS[r.subjectType]?.(tx, actor, r.subjectId, r.purpose, r.requestStatus);
  return r;
}
