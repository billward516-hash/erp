import type { Actor } from '../../platform/auth/actor.js';
import { requirePermission } from '../../platform/auth/actor.js';
import { audit } from '../../platform/audit/audit.js';
import type { Tx } from '../../platform/db/tx.js';
import { many, one } from '../../platform/db/tx.js';
import { invalid } from '../../platform/errors.js';
import { setFeature } from '../features/service.js';
import { type Answers, INTERVIEW_VERSION, QUESTIONS, askable, evaluate } from './interview.js';

export async function getInterview(tx: Tx, actor: Actor) {
  requirePermission(actor, 'tenant.admin');
  const row = await one(tx, 'SELECT answers, result, taken_at, updated_at, version FROM fit_interview');
  const answers = (row?.answers ?? {}) as Answers;
  return { version: INTERVIEW_VERSION, questions: askable(answers), answers, result: row ? evaluate(answers) : null, takenAt: row?.taken_at ?? null, updatedAt: row?.updated_at ?? null };
}

/** Saves answers (a partial set is fine: the interview can be resumed) and returns the recommendation they give. Unknown or unasked answers are refused. */
export async function saveAnswers(tx: Tx, actor: Actor, input: Answers) {
  requirePermission(actor, 'tenant.admin');
  const cur = ((await one(tx, 'SELECT answers FROM fit_interview'))?.answers ?? {}) as Answers;
  const next: Answers = { ...cur, ...input };
  const byId = new Map(QUESTIONS.map((q) => [q.id, q]));
  for (const [id, v] of Object.entries(input)) {
    const q = byId.get(id);
    if (!q) throw invalid(`there is no question ${id}`);
    if (q.kind === 'yesno' && typeof v !== 'boolean') throw invalid(`${id}: answer yes or no`);
    const ok = new Set((q.options ?? []).map((o) => o.value));
    if (q.kind === 'single' && !(typeof v === 'string' && ok.has(v))) throw invalid(`${id}: choose one of the options`);
    if (q.kind === 'multi' && !(Array.isArray(v) && v.every((x) => ok.has(x)))) throw invalid(`${id}: choose from the options`);
  }
  // Answers to questions no longer asked (a branch changed) are dropped so they cannot colour the result.
  const asked = new Set(askable(next).map((q) => q.id));
  for (const k of Object.keys(next)) if (!asked.has(k)) delete next[k];
  const result = evaluate(next);
  await tx.query(`INSERT INTO fit_interview (tenant_id, version, answers, result, taken_by) VALUES ($1, $2, $3, $4, $5)
    ON CONFLICT (tenant_id) DO UPDATE SET answers = EXCLUDED.answers, result = EXCLUDED.result, version = EXCLUDED.version, updated_at = now()`, [actor.tenantId, INTERVIEW_VERSION, JSON.stringify(next), JSON.stringify(result), actor.userId]);
  await audit(tx, actor, { action: 'fit_interview.saved', entityType: 'fit_interview', entityId: actor.tenantId, data: { answered: Object.keys(next).length } });
  return getInterview(tx, actor);
}

/** Optional: hides the features the interview did not recommend (they come back from the Features page). Recommended and "maybe" features stay. */
export async function applyRecommendation(tx: Tx, actor: Actor) {
  requirePermission(actor, 'tenant.admin');
  const row = await one(tx, 'SELECT answers FROM fit_interview');
  if (!row) throw invalid('take the interview first');
  const r = evaluate(row.answers as Answers);
  const keep = new Set([...r.show, ...r.maybe].map((x) => x.feature));
  let hidden = 0;
  for (const f of r.hide) if (!keep.has(f.feature) && f.feature !== 'field_service') { await setFeature(tx, actor, f.feature, { mode: 'off' }); hidden++; }
  await audit(tx, actor, { action: 'fit_interview.applied', entityType: 'fit_interview', entityId: actor.tenantId, data: { hidden } });
  return { hidden, planDepth: r.depth };
}

export async function interviewHistory(tx: Tx) { return many(tx, 'SELECT taken_at, updated_at FROM fit_interview'); }
