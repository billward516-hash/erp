import { asActor, loadActor } from '../src/platform/auth/actor.js';
import type { Actor } from '../src/platform/auth/actor.js';
import { myApprovalQueue } from '../src/platform/approvals/engine.js';
import { getAdminPool } from '../src/platform/db/pool.js';
import { createUserWithToken } from '../src/platform/tenancy/provision.js';
import { decideApproval } from '../src/modules/approvals/service.js';
import { createProtocol, executeProtocol, getProtocol, recordResult } from '../src/modules/qualification/service.js';
import type { ProtocolType } from '../src/modules/qualification/service.js';
import type { World } from './fixtures.js';

let n = 0;
/** A user with the given roles, as an actor. */
export async function addUser(w: World, name: string, roles: { role: string; facility: string | null }[], employeeId?: string): Promise<Actor> {
  const u = await createUserWithToken(getAdminPool(), w.tenantId, { email: `${name}-${++n}@${w.tenantId.slice(0, 8)}.example`, displayName: name, roles, employeeId });
  return (await loadActor(w.tenantId, u.userId))!;
}

/** The approval step waiting on this subject for this person, if any. */
export const waitingFor = async (who: Actor, subjectId: string) => (await asActor(who, (tx) => myApprovalQueue(tx, who))).find((q) => q.subject_id === subjectId);

export async function approve(who: Actor, subjectId: string, comment = 'Reviewed the results against the acceptance criteria.') {
  const step = await waitingFor(who, subjectId);
  if (!step) throw new Error('no approval step is waiting for this person');
  return asActor(who, (tx) => decideApproval(tx, who, step.step_id, { decision: 'approve', comment }));
}
export async function reject(who: Actor, subjectId: string, comment = 'Step 2 needs the raw readings attached.') {
  const step = await waitingFor(who, subjectId);
  if (!step) throw new Error('no approval step is waiting for this person');
  return asActor(who, (tx) => decideApproval(tx, who, step.step_id, { decision: 'reject', comment }));
}

/** Writes a two-step protocol, records both steps and executes it (returns the executed protocol). */
export async function runProtocol(
  w: World, executor: Actor, assetId: string,
  o: { type?: ProtocolType; fail?: boolean; approverUserId?: string | null; intervalMonths?: number | null; title?: string } = {},
) {
  const p = await asActor(executor, (tx) => createProtocol(tx, executor, {
    assetId, protocolType: o.type ?? 'OQ', title: o.title ?? 'Operational qualification', acceptanceCriteria: 'All steps pass within the stated limits.',
    approverUserId: o.approverUserId, ...(o.intervalMonths !== undefined ? { intervalMonths: o.intervalMonths } : {}),
    steps: [{ step: 'Run the leak-up test', expected: 'Leak-up below 5 mTorr/min' }, { step: 'Cycle the chamber lid 50 times', expected: 'No faults' }],
  }));
  const steps = (await asActor(executor, (tx) => getProtocol(tx, executor, p.id))).steps;
  await asActor(executor, async (tx) => {
    await recordResult(tx, executor, steps[0].id, { actual: o.fail ? '9.1 mTorr/min' : '3.2 mTorr/min', outcome: o.fail ? 'fail' : 'pass' });
    await recordResult(tx, executor, steps[1].id, { actual: '50 cycles, no faults', outcome: 'pass' });
  });
  return asActor(executor, (tx) => executeProtocol(tx, executor, p.id, o.fail ? 'Leak-up above the limit; not accepted.' : 'The tool meets the acceptance criteria.'));
}
