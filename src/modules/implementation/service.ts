import type { Actor } from '../../platform/auth/actor.js';
import { can, requirePermission } from '../../platform/auth/actor.js';
import { audit } from '../../platform/audit/audit.js';
import type { Tx } from '../../platform/db/tx.js';
import { many, one } from '../../platform/db/tx.js';
import { conflict, invalid, notFound } from '../../platform/errors.js';
import { notify } from '../../platform/notify/notify.js';
import { getTarget } from '../imports/targets/registry.js';
import type { Depth, StepDef } from './catalogue.js';
import { CATALOGUE, DEPTH_RANK, stepDef, stepsFor } from './catalogue.js';

/**
 * Implementation planner (SC-003). One plan per company, built from the catalogue at the chosen depth. A data step is
 * "loaded" as soon as a batch for its import target has been committed (read from import_batch, never typed); a person
 * then verifies it against the check named in the step. Steps are locked until what they depend on is loaded, verified
 * or skipped; an administrator can open a locked step with a recorded reason.
 */
const DONE = new Set(['loaded', 'verified', 'skipped']);

function admin(actor: Actor) { requirePermission(actor, 'tenant.admin'); }

export async function createPlan(tx: Tx, actor: Actor, input: { depth: Depth; targetGoLive?: string | null }) {
  admin(actor);
  if (await one(tx, 'SELECT 1 FROM implementation_plan')) throw conflict('this company already has an implementation plan');
  const plan = await one(tx, `INSERT INTO implementation_plan (tenant_id, depth, target_go_live, created_by) VALUES ($1, $2, $3, $4) RETURNING *`,
    [actor.tenantId, input.depth, input.targetGoLive ?? null, actor.userId]);
  await addSteps(tx, actor, plan.id, input.depth);
  await audit(tx, actor, { action: 'implementation.plan_created', entityType: 'implementation_plan', entityId: plan.id, data: { depth: input.depth } });
  return getPlan(tx, actor);
}

async function addSteps(tx: Tx, actor: Actor, planId: string, depth: Depth) {
  for (const [i, s] of CATALOGUE.entries()) {
    if (DEPTH_RANK[s.depth] > DEPTH_RANK[depth]) continue;
    await tx.query(`INSERT INTO implementation_step (tenant_id, plan_id, step_key, position) VALUES ($1, $2, $3, $4) ON CONFLICT (plan_id, step_key) DO NOTHING`, [actor.tenantId, planId, s.key, i]);
  }
}

/** A different depth adds the steps it includes and drops untouched steps it does not; steps with work or a person on them stay. */
export async function setDepth(tx: Tx, actor: Actor, depth: Depth) {
  admin(actor);
  const plan = await one(tx, 'SELECT * FROM implementation_plan FOR UPDATE');
  if (!plan) throw notFound('implementation plan');
  await tx.query('UPDATE implementation_plan SET depth = $2, updated_at = now() WHERE id = $1', [plan.id, depth]);
  await addSteps(tx, actor, plan.id, depth);
  const keep = stepsFor(depth).map((s) => s.key);
  await tx.query(`DELETE FROM implementation_step WHERE plan_id = $1 AND NOT (step_key = ANY ($2)) AND status = 'todo' AND assignee_user_id IS NULL AND note IS NULL`, [plan.id, keep]);
  await audit(tx, actor, { action: 'implementation.depth_set', entityType: 'implementation_plan', entityId: plan.id, data: { from: plan.depth, to: depth } });
  return getPlan(tx, actor);
}

export async function setGoLiveDate(tx: Tx, actor: Actor, date: string | null) {
  admin(actor);
  const r = await one(tx, 'UPDATE implementation_plan SET target_go_live = $1, updated_at = now() RETURNING id', [date]);
  if (!r) throw notFound('implementation plan');
}

async function loadedByTarget(tx: Tx) {
  const rows = await many(tx, `SELECT target, sum(coalesce((stats->>'created')::int, 0) + coalesce((stats->>'updated')::int, 0))::int AS n, max(committed_at) AS last
    FROM import_batch WHERE status = 'committed' GROUP BY target`);
  return new Map(rows.map((r) => [r.target as string, { n: r.n as number, last: r.last as Date }]));
}

export async function getPlan(tx: Tx, actor: Actor) {
  const plan = await one(tx, 'SELECT * FROM implementation_plan');
  if (!plan) return { plan: null as null, steps: [] as any[], readiness: null as any, answer: 'No implementation plan yet. Choose how much guidance this company needs and one is built.' };
  const rows = await many(tx, `SELECT s.*, u.display_name AS assignee_name FROM implementation_step s LEFT JOIN app_user u ON u.id = s.assignee_user_id WHERE s.plan_id = $1 ORDER BY s.position`, [plan.id]);
  const loaded = await loadedByTarget(tx);
  // Loading a file moves its step on by itself.
  for (const r of rows) {
    const def = stepDef(r.step_key);
    const l = def?.target ? loaded.get(def.target) : undefined;
    if (def?.target && l && l.n > 0 && ['todo', 'in_progress'].includes(r.status)) {
      await tx.query(`UPDATE implementation_step SET status = 'loaded', updated_at = now() WHERE id = $1`, [r.id]);
      r.status = 'loaded';
    }
  }
  const statusOf = new Map(rows.map((r) => [r.step_key as string, r.status as string]));
  const dataKeys = rows.filter((r) => stepDef(r.step_key)?.track === 'data' && !stepDef(r.step_key)!.optional).map((r) => r.step_key as string);
  const allKeys = rows.map((r) => r.step_key as string).filter((k) => k !== 'go_live');
  const expand = (s: StepDef) => s.dependsOn.flatMap((k) => (k === '*data' ? dataKeys : k === '*all' ? allKeys : [k])).filter((k) => statusOf.has(k));
  const steps = rows.map((r) => {
    const def = stepDef(r.step_key)!;
    const waiting = expand(def).filter((k) => !DONE.has(statusOf.get(k)!));
    const target = def.target ? getTarget(def.target) : undefined;
    const l = def.target ? loaded.get(def.target) : undefined;
    return {
      id: r.id as string, key: def.key, track: def.track, title: def.title, owner: def.owner, optional: !!def.optional, target: def.target ?? null, importReady: def.target ? !!target : null,
      bring: def.bring, doneWhen: def.doneWhen, help: def.help, status: r.status as string,
      assigneeId: r.assignee_user_id as string | null, assignee: r.assignee_name as string | null, expected: r.expected_count as number | null, loadedCount: l?.n ?? 0,
      lastLoadedAt: l?.last ?? null, note: r.note as string | null, skippedReason: r.skipped_reason as string | null, overrideReason: r.override_reason as string | null,
      locked: waiting.length > 0 && !r.override_reason && !DONE.has(r.status) && r.status === 'todo',
      waitingFor: waiting.map((k) => stepDef(k)!.title), completedAt: r.completed_at as Date | null,
    };
  });
  const required = steps.filter((s) => !s.optional && s.key !== 'go_live');
  const finished = required.filter((s) => s.status === 'verified' || s.status === 'skipped');
  const loadedOnly = required.filter((s) => s.status === 'loaded');
  const blockers = required.filter((s) => s.status !== 'verified' && s.status !== 'skipped');
  const byOwner = new Map<string, { owner: string; open: number; total: number }>();
  for (const s of required) {
    const o = byOwner.get(s.owner) ?? { owner: s.owner, open: 0, total: 0 };
    o.total++; if (s.status !== 'verified' && s.status !== 'skipped') o.open++;
    byOwner.set(s.owner, o);
  }
  const readiness = { required: required.length, verified: finished.length, loadedNotVerified: loadedOnly.length, open: blockers.length,
    percent: required.length ? Math.round((finished.length / required.length) * 100) : 0, canGoLive: blockers.length === 0, byOwner: [...byOwner.values()].sort((a, b) => b.open - a.open) };
  const next = steps.filter((s) => s.status === 'todo' && !s.locked && !s.optional)[0];
  const answer = plan.went_live_on ? `Live since ${new Date(plan.went_live_on).toISOString().slice(0, 10)}.`
    : readiness.canGoLive ? 'Every required step is verified or skipped: the company can go live.'
      : `${readiness.verified} of ${readiness.required} required steps are verified${readiness.loadedNotVerified ? `, ${readiness.loadedNotVerified} loaded and waiting to be checked` : ''}.${next ? ` Next: ${next.title} (${next.owner}).` : ''}`;
  return { plan: { id: plan.id as string, depth: plan.depth as Depth, targetGoLive: plan.target_go_live as string | null, wentLiveOn: plan.went_live_on as string | null }, steps, readiness, answer };
}

async function stepRow(tx: Tx, key: string) {
  const s = await one(tx, 'SELECT * FROM implementation_step WHERE step_key = $1 FOR UPDATE', [key]);
  if (!s) throw notFound('step');
  return s;
}
function mayWork(actor: Actor, s: { assignee_user_id: string | null }) {
  if (can(actor, 'tenant.admin') || s.assignee_user_id === actor.userId) return;
  requirePermission(actor, 'tenant.admin');
}

export async function updateStep(tx: Tx, actor: Actor, key: string, input: { assigneeUserId?: string | null; expectedCount?: number | null; note?: string | null }) {
  const s = await stepRow(tx, key);
  if (input.assigneeUserId !== undefined || input.expectedCount !== undefined) admin(actor); else mayWork(actor, s);
  if (input.assigneeUserId) {
    const u = await one(tx, `SELECT id FROM app_user WHERE id = $1 AND status = 'active'`, [input.assigneeUserId]);
    if (!u) throw invalid('that person is not an active user of this company');
  }
  await tx.query(`UPDATE implementation_step SET assignee_user_id = CASE WHEN $2::boolean THEN $3 ELSE assignee_user_id END, expected_count = CASE WHEN $4::boolean THEN $5 ELSE expected_count END,
    note = CASE WHEN $6::boolean THEN $7 ELSE note END, updated_at = now() WHERE id = $1`,
  [s.id, input.assigneeUserId !== undefined, input.assigneeUserId ?? null, input.expectedCount !== undefined, input.expectedCount ?? null, input.note !== undefined, input.note?.trim() || null]);
  if (input.assigneeUserId && input.assigneeUserId !== s.assignee_user_id && input.assigneeUserId !== actor.userId) {
    const def = stepDef(key)!;
    await notify(tx, actor.tenantId, [input.assigneeUserId], { kind: 'action.assigned', title: `Implementation step for you: ${def.title}`, link: '/implementation',
      subjectType: 'implementation_step', subjectId: s.id, dedupeKey: `impl:${s.id}:${input.assigneeUserId}` }, actor.userId);
  }
  return getPlan(tx, actor);
}

async function lockedNow(tx: Tx, actor: Actor, key: string) {
  const p = await getPlan(tx, actor);
  return p.steps.find((x: any) => x.key === key);
}

export async function startStep(tx: Tx, actor: Actor, key: string, input: { overrideReason?: string | null } = {}) {
  const s = await stepRow(tx, key); mayWork(actor, s);
  const view = await lockedNow(tx, actor, key);
  if (s.status !== 'todo') throw conflict(`this step is ${s.status}`);
  if (view.locked) {
    if (!input.overrideReason?.trim() || input.overrideReason.trim().length < 5) throw invalid(`${view.title} waits for ${view.waitingFor.join(', ')}; an administrator can start it early by saying why`);
    admin(actor);
    await tx.query(`UPDATE implementation_step SET override_reason = $2, override_by = $3 WHERE id = $1`, [s.id, input.overrideReason.trim(), actor.userId]);
    await audit(tx, actor, { action: 'implementation.step_unlocked', entityType: 'implementation_step', entityId: s.id, data: { step: key, reason: input.overrideReason.trim(), waitingFor: view.waitingFor } });
  }
  await tx.query(`UPDATE implementation_step SET status = 'in_progress', updated_at = now() WHERE id = $1`, [s.id]);
  return getPlan(tx, actor);
}

/** The owner confirms the step against its check. A data step must have a committed load first. */
export async function verifyStep(tx: Tx, actor: Actor, key: string, input: { note?: string | null } = {}) {
  const s = await stepRow(tx, key); mayWork(actor, s);
  const view = await lockedNow(tx, actor, key);
  const def = stepDef(key)!;
  if (s.status === 'verified' || s.status === 'skipped') throw conflict(`this step is already ${s.status}`);
  if (def.track === 'data' && view.status !== 'loaded') throw invalid(`load ${def.title.toLowerCase()} first; a step is verified after its file is committed`);
  if (view.locked) throw invalid(`${def.title} waits for ${view.waitingFor.join(', ')}`);
  if (key === 'go_live') {
    const p = await getPlan(tx, actor);
    if (!p.readiness.canGoLive) throw invalid(`${p.readiness.open} required step${p.readiness.open === 1 ? ' is' : 's are'} not yet verified or skipped: ${p.steps.filter((x: any) => !x.optional && x.key !== 'go_live' && !['verified', 'skipped'].includes(x.status)).slice(0, 4).map((x: any) => x.title).join(', ')}`);
    await tx.query(`UPDATE implementation_plan SET went_live_on = current_date, updated_at = now()`);
  }
  await tx.query(`UPDATE implementation_step SET status = 'verified', completed_by = $2, completed_at = now(), note = coalesce($3, note), updated_at = now() WHERE id = $1`, [s.id, actor.userId, input.note?.trim() || null]);
  await audit(tx, actor, { action: 'implementation.step_verified', entityType: 'implementation_step', entityId: s.id, data: { step: key, loadedCount: view.loadedCount, note: input.note ?? null } });
  return getPlan(tx, actor);
}

export async function skipStep(tx: Tx, actor: Actor, key: string, reason: string) {
  admin(actor);
  const s = await stepRow(tx, key);
  if (!reason?.trim() || reason.trim().length < 5) throw invalid('say why this step is not needed');
  if (key === 'go_live') throw invalid('the go-live sign-off cannot be skipped');
  await tx.query(`UPDATE implementation_step SET status = 'skipped', skipped_reason = $2, completed_by = $3, completed_at = now(), updated_at = now() WHERE id = $1`, [s.id, reason.trim(), actor.userId]);
  await audit(tx, actor, { action: 'implementation.step_skipped', entityType: 'implementation_step', entityId: s.id, data: { step: key, reason: reason.trim() } });
  return getPlan(tx, actor);
}

/** Puts a verified or skipped step back to be done again (a late change). */
export async function reopenStep(tx: Tx, actor: Actor, key: string) {
  admin(actor);
  const s = await stepRow(tx, key);
  await tx.query(`UPDATE implementation_step SET status = 'todo', completed_by = NULL, completed_at = NULL, skipped_reason = NULL, updated_at = now() WHERE id = $1`, [s.id]);
  if (key === 'go_live') await tx.query('UPDATE implementation_plan SET went_live_on = NULL');
  await audit(tx, actor, { action: 'implementation.step_reopened', entityType: 'implementation_step', entityId: s.id, data: { step: key } });
  return getPlan(tx, actor);
}

/** The person's own open steps, across the plan. */
export async function myImplementationSteps(tx: Tx, actor: Actor) {
  const p = await getPlan(tx, actor);
  return p.steps.filter((s: any) => s.assigneeId === actor.userId && !['verified', 'skipped'].includes(s.status));
}
