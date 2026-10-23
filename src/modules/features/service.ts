import type { Actor } from '../../platform/auth/actor.js';
import { requirePermission } from '../../platform/auth/actor.js';
import { audit } from '../../platform/audit/audit.js';
import type { Tx } from '../../platform/db/tx.js';
import { many, one } from '../../platform/db/tx.js';
import { invalid, notFound } from '../../platform/errors.js';
import { FEATURE_BY_KEY, FEATURES, forgetFeatures } from '../../platform/features.js';

/**
 * The Features screen (D-149): every feature with who sees it, whatever its setting; the only place a hidden feature
 * still appears. Administrators only.
 */
export async function listFeatures(tx: Tx, actor: Actor) {
  requirePermission(actor, 'tenant.admin');
  const rows = await many(tx, `SELECT f.feature_key, f.mode, f.role_keys, f.updated_at, u.display_name AS updated_by FROM tenant_feature f JOIN app_user u ON u.id = f.updated_by`);
  const by = new Map(rows.map((r) => [r.feature_key, r]));
  const roles = await many(tx, `SELECT r.key, r.name, (SELECT count(DISTINCT a.user_id)::int FROM user_role_assignment a JOIN app_user u ON u.id = a.user_id WHERE a.role_id = r.id AND u.status = 'active') AS users
    FROM role r ORDER BY r.name`);
  return {
    roles,
    features: FEATURES.map((f) => {
      const s = by.get(f.key);
      return { key: f.key, label: f.label, group: f.group, description: f.description, affects: f.affects ?? null, nav: f.nav, reports: f.reports,
        mode: s?.mode ?? 'all', roleKeys: s?.role_keys ?? [], updatedAt: s?.updated_at ?? null, updatedBy: s?.updated_by ?? null };
    }),
  };
}

export async function setFeature(tx: Tx, actor: Actor, key: string, input: { mode: 'all' | 'roles' | 'off'; roleKeys?: string[] }) {
  requirePermission(actor, 'tenant.admin');
  const f = FEATURE_BY_KEY.get(key);
  if (!f) throw notFound('feature');
  const roleKeys = [...new Set(input.roleKeys ?? [])];
  if (input.mode === 'roles') {
    if (!roleKeys.length) throw invalid('choose at least one role, or turn the feature off');
    const known = new Set((await many(tx, 'SELECT key FROM role WHERE key = ANY ($1)', [roleKeys])).map((r) => r.key));
    const unknown = roleKeys.filter((r) => !known.has(r));
    if (unknown.length) throw invalid(`unknown role ${unknown.join(', ')}`);
  }
  const prior = await one(tx, 'SELECT mode, role_keys FROM tenant_feature WHERE feature_key = $1', [key]);
  if (input.mode === 'all') await tx.query('DELETE FROM tenant_feature WHERE feature_key = $1', [key]);
  else await tx.query(`INSERT INTO tenant_feature (tenant_id, feature_key, mode, role_keys, updated_by) VALUES ($1, $2, $3, $4, $5)
    ON CONFLICT (tenant_id, feature_key) DO UPDATE SET mode = EXCLUDED.mode, role_keys = EXCLUDED.role_keys, updated_by = EXCLUDED.updated_by, updated_at = now()`,
  [actor.tenantId, key, input.mode, input.mode === 'roles' ? roleKeys : [], actor.userId]);
  forgetFeatures(actor.tenantId);
  await audit(tx, actor, { action: 'feature.visibility_set', entityType: 'tenant_feature', entityId: actor.tenantId,
    data: { feature: key, from: prior ? { mode: prior.mode, roles: prior.role_keys } : { mode: 'all' }, to: { mode: input.mode, roles: input.mode === 'roles' ? roleKeys : [] } } });
}
