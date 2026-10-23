import { createHash } from 'node:crypto';
import type { Actor } from '../../platform/auth/actor.js';
import { hashToken } from '../../platform/auth/actor.js';
import { audit } from '../../platform/audit/audit.js';
import type { Tx } from '../../platform/db/tx.js';
import { many, one } from '../../platform/db/tx.js';
import { invalid } from '../../platform/errors.js';
import { documentSettings } from './specs.js';

/**
 * Optional electronic signatures (D-170), for the kinds of document an administrator chooses (21 CFR Part 11 style).
 * A reviewer or approver of such a document must re-enter their sign-in credential at the moment of signing; the
 * signature records who signed, with what meaning (reviewed or approved), when, and the checksum of the exact file
 * signed, sealed with a hash over all of those. A signature cannot be changed or removed (database guard).
 *
 * The credential check re-presents the person's own sign-in token. For people who sign in through a company identity
 * provider, the provider's fresh sign-in is the right proof (an OpenID Connect re-authentication); that is configured
 * with the provider (owner register O-1).
 */
export const MEANING = { reviewed: 'Reviewed', approved: 'Approved' } as const;

export async function signatureRequired(tx: Tx, docType: string) {
  return (await documentSettings(tx)).esignTypes.includes(docType);
}

/** True when the credential is the signer's own current sign-in credential. */
async function credentialIsTheirs(tx: Tx, userId: string, credential: string) {
  const r = await one(tx, 'SELECT user_id FROM auth_resolve_token($1)', [hashToken(credential)]);
  return r?.user_id === userId;
}

export function sealOf(parts: { docNumber: string; revision: number; sha256: string; userId: string; meaning: string; signedAt: string }) {
  return createHash('sha256').update([parts.docNumber, parts.revision, parts.sha256, parts.userId, parts.meaning, parts.signedAt].join('|')).digest('hex');
}

/** Signs a version if its kind requires it; refuses when the credential is missing or is not the signer's own. */
export async function signIfRequired(tx: Tx, actor: Actor, versionId: string, meaning: keyof typeof MEANING, credential?: string | null) {
  const v = await one(tx, `SELECT v.id, v.revision, v.sha256, v.document_id, d.doc_number, d.doc_type, d.facility_id FROM document_version v JOIN document d ON d.id = v.document_id WHERE v.id = $1`, [versionId]);
  if (!v || !(await signatureRequired(tx, v.doc_type))) return null;
  if (!credential) throw invalid(`this kind of document is signed electronically: re-enter your sign-in credential to sign as ${MEANING[meaning].toLowerCase()}`);
  if (!(await credentialIsTheirs(tx, actor.userId, credential))) throw invalid('the credential is not yours; the signature was not recorded');
  const who = await one(tx, 'SELECT display_name FROM app_user WHERE id = $1', [actor.userId]);
  const signedAt = new Date().toISOString();
  const seal = sealOf({ docNumber: v.doc_number, revision: v.revision, sha256: v.sha256, userId: actor.userId, meaning, signedAt });
  await tx.query(`INSERT INTO document_signature (tenant_id, document_id, version_id, user_id, signer_name, meaning, version_sha256, signed_at, signature_hash) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [actor.tenantId, v.document_id, versionId, actor.userId, who.display_name, meaning, v.sha256, signedAt, seal]);
  await audit(tx, actor, { action: 'document.signed', entityType: 'document', entityId: v.document_id, facilityId: v.facility_id, data: { versionId, revision: v.revision, meaning, signatureHash: seal } });
  return { meaning, signedAt, seal };
}

/** For an approval step on a document revision: the signature it needs, if any. Used before the decision is recorded. */
export async function signStep(tx: Tx, actor: Actor, stepId: string, credential?: string | null) {
  const s = await one(tx, `SELECT s.label, r.subject_type, r.subject_id FROM approval_step s JOIN approval_request r ON r.id = s.request_id WHERE s.id = $1`, [stepId]);
  if (!s || s.subject_type !== 'document_version') return null;
  return signIfRequired(tx, actor, s.subject_id, /^Review by/.test(s.label) ? 'reviewed' : 'approved', credential);
}

/** Which of the given document versions need a signature to approve (for the approvals screen). */
export async function signaturesNeeded(tx: Tx, versionIds: string[]) {
  if (!versionIds.length) return new Map<string, boolean>();
  const { esignTypes } = await documentSettings(tx);
  const rows = await many(tx, `SELECT v.id, d.doc_type FROM document_version v JOIN document d ON d.id = v.document_id WHERE v.id = ANY ($1)`, [versionIds]);
  return new Map(rows.map((r) => [r.id as string, esignTypes.includes(r.doc_type)]));
}

/** Signatures on the versions of a document, as the verifier sees them: recomputable from the stored facts. */
export function verifySeal(sig: { signer_name: string; user_id: string; meaning: string; version_sha256: string; signed_at: string | Date; signature_hash: string }, doc: { doc_number: string; revision: number }) {
  return sealOf({ docNumber: doc.doc_number, revision: doc.revision, sha256: sig.version_sha256, userId: sig.user_id, meaning: sig.meaning, signedAt: new Date(sig.signed_at).toISOString() }) === sig.signature_hash;
}
