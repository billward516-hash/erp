import type { Actor } from '../../platform/auth/actor.js';
import type { Tx } from '../../platform/db/tx.js';
import { many, one } from '../../platform/db/tx.js';
import { invalid } from '../../platform/errors.js';

/**
 * Unsaved form entries (D-164). The web app saves what a person types into any form, a second after they stop, keyed by
 * the page and the form, and puts it back when they open that page again on any device. A draft is private to its
 * author (row-level security on the user), removed when the form is saved or discarded, and swept by retention after
 * a period the company sets (90 days by default).
 */
const MAX_DRAFTS = 200;

export async function listDrafts(tx: Tx, actor: Actor, q: { path?: string } = {}) {
  return many(tx, `SELECT key, path, label, data, updated_at FROM form_draft WHERE user_id = $1 AND ($2::text IS NULL OR path = $2) ORDER BY updated_at DESC LIMIT 100`,
    [actor.userId, q.path ?? null]);
}

export async function saveDraft(tx: Tx, actor: Actor, key: string, input: { path: string; label?: string | null; data: unknown }) {
  if (!input.path.startsWith('/')) throw invalid('a draft belongs to a page path');
  const n = await one(tx, 'SELECT count(*)::int AS n FROM form_draft WHERE user_id = $1 AND key <> $2', [actor.userId, key]);
  if (n.n >= MAX_DRAFTS) {
    // Oldest drafts make room; a person with 200 unsaved forms has long forgotten the oldest.
    await tx.query(`DELETE FROM form_draft WHERE user_id = $1 AND key IN (SELECT key FROM form_draft WHERE user_id = $1 ORDER BY updated_at LIMIT $2)`, [actor.userId, n.n - MAX_DRAFTS + 1]);
  }
  return one(tx, `INSERT INTO form_draft (tenant_id, user_id, key, path, label, data) VALUES ($1, $2, $3, $4, $5, $6)
    ON CONFLICT (tenant_id, user_id, key) DO UPDATE SET path = EXCLUDED.path, label = EXCLUDED.label, data = EXCLUDED.data, updated_at = now()
    RETURNING key, path, label, updated_at`, [actor.tenantId, actor.userId, key, input.path, input.label?.slice(0, 200) ?? null, JSON.stringify(input.data)]);
}

export async function deleteDraft(tx: Tx, actor: Actor, key: string) {
  await tx.query('DELETE FROM form_draft WHERE user_id = $1 AND key = $2', [actor.userId, key]);
}
