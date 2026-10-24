import type { Tx } from '../../platform/db/tx.js';
import { one } from '../../platform/db/tx.js';
import { AppError } from '../../platform/errors.js';

/**
 * The return-to-service gate (SC-007 B, D-184B). Kept free of the rest of the qualification module so the asset and maintenance
 * code can call it without import cycles. An asset is gated only when it is under qualification control (a switched-on
 * asset_qualification row). Leaving a down state (planned or unplanned downtime, out of service) for an up state (available,
 * running, idle) is refused while the asset is not qualified or requalification is required.
 */
export const DOWN_STATES = ['planned_downtime', 'unplanned_downtime', 'out_of_service'] as const;
export const UP_STATES = ['available', 'running', 'idle'] as const;
const day = (d: unknown) => new Date(d as string).toISOString().slice(0, 10);

/**
 * Qualification is not enforced when nobody could act on it: the Lite edition has no qualification screens, and a company that turned the
 * feature off for everyone (Admin, Features) could neither see a requirement nor clear it. Turned on for some roles, it is enforced.
 */
export async function qualificationInactive(tx: Tx): Promise<boolean> {
  const f = await one(tx, `SELECT mode FROM tenant_feature WHERE feature_key = 'qualification'`);
  if (f?.mode === 'off') return true;
  return (await one(tx, 'SELECT edition FROM tenant_edition()'))?.edition === 'lite';
}

/** Why the asset may not return to service, or null when it may (or is not under qualification control). */
export async function returnToServiceBlock(tx: Tx, assetId: string): Promise<string | null> {
  if (await qualificationInactive(tx)) return null;
  const q = await one(tx, `SELECT q.status, q.required_since, q.required_reason, a.asset_tag FROM asset_qualification q JOIN asset a ON a.id = q.asset_id WHERE q.asset_id = $1 AND q.enabled`, [assetId]);
  if (!q) return null;
  if (q.status === 'requalification_required') {
    return `${q.asset_tag} cannot return to service: requalification has been required since ${day(q.required_since)} (${q.required_reason ?? 'work or a change on the tool'}). `
      + 'Execute an OQ, PQ or requalification protocol after that date and have it approved by someone other than the person who executed it.';
  }
  if (q.status === 'not_qualified') {
    return `${q.asset_tag} cannot return to service: it is under qualification control but has no approved PQ or requalification yet. `
      + 'Complete and approve a protocol, or record the existing qualification if the tool was qualified before it was entered here.';
  }
  return null;
}

/** Throws a 422 `requalification_required` when `from` is a down state, `to` an up state and the asset is gated. */
export async function assertReturnToService(tx: Tx, assetId: string, from: string | null, to: string) {
  if (!from || !(DOWN_STATES as readonly string[]).includes(from) || !(UP_STATES as readonly string[]).includes(to)) return;
  const why = await returnToServiceBlock(tx, assetId);
  if (why) throw new AppError(422, 'requalification_required', why, { assetId });
}
