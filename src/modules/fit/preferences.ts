import type { Actor } from '../../platform/auth/actor.js';
import type { Tx } from '../../platform/db/tx.js';
import { one } from '../../platform/db/tx.js';
import { invalid } from '../../platform/errors.js';

/**
 * "How I like to work" (SC-004 E): per-person display settings that change how every screen looks and how reports open. None of them is
 * labelled by gender or any other group. Only settings with a real effect are offered.
 */
export interface Preferences { density: 'roomy' | 'normal' | 'compact'; textSize: 'normal' | 'large' | 'larger'; highContrast: boolean; reducedMotion: boolean; defaultView: 'chart' | 'table'; suggestions: boolean }
const DEFAULTS: Preferences = { density: 'normal', textSize: 'normal', highContrast: false, reducedMotion: false, defaultView: 'chart', suggestions: true };

export async function getPreferences(tx: Tx, actor: Actor): Promise<Preferences> {
  const r = await one(tx, 'SELECT density, text_size, high_contrast, reduced_motion, default_view, suggestions FROM user_preference WHERE user_id = $1', [actor.userId]);
  return r ? { density: r.density, textSize: r.text_size, highContrast: r.high_contrast, reducedMotion: r.reduced_motion, defaultView: r.default_view, suggestions: r.suggestions } : DEFAULTS;
}

export async function savePreferences(tx: Tx, actor: Actor, patch: Partial<Preferences>) {
  const next = { ...(await getPreferences(tx, actor)), ...patch };
  if (!['roomy', 'normal', 'compact'].includes(next.density)) throw invalid('density is roomy, normal or compact');
  if (!['normal', 'large', 'larger'].includes(next.textSize)) throw invalid('text size is normal, large or larger');
  if (!['chart', 'table'].includes(next.defaultView)) throw invalid('reports open as a chart or a table');
  await tx.query(`INSERT INTO user_preference (user_id, tenant_id, density, text_size, high_contrast, reduced_motion, default_view, suggestions) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
    ON CONFLICT (user_id) DO UPDATE SET density = EXCLUDED.density, text_size = EXCLUDED.text_size, high_contrast = EXCLUDED.high_contrast, reduced_motion = EXCLUDED.reduced_motion, default_view = EXCLUDED.default_view, suggestions = EXCLUDED.suggestions, updated_at = now()`,
  [actor.userId, actor.tenantId, next.density, next.textSize, next.highContrast, next.reducedMotion, next.defaultView, next.suggestions]);
  return next;
}
