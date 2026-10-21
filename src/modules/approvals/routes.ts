import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { asActor } from '../../platform/auth/actor.js';
import { myApprovalQueue } from '../../platform/approvals/engine.js';
import { many } from '../../platform/db/tx.js';
import { actorOf, parse } from '../../platform/http/helpers.js';
import { decideApproval } from './service.js';

export async function approvalRoutes(app: FastifyInstance) {
  app.get('/approvals/queue', async (req) => asActor(actorOf(req), async (tx) => {
    const steps = await myApprovalQueue(tx, actorOf(req));
    const mocIds = steps.filter((s) => s.subject_type === 'moc_change').map((s) => s.subject_id);
    const mocs = new Map((await many(tx, 'SELECT id, number, title, risk_level, revision FROM moc_change WHERE id = ANY ($1)', [mocIds])).map((m) => [m.id, m]));
    return steps.map((s) => ({ stepId: s.step_id, label: s.label, role: s.role_key, purpose: s.purpose, subjectType: s.subject_type, subjectId: s.subject_id,
      requestedAt: s.created_at, subject: s.subject_type === 'moc_change' ? mocs.get(s.subject_id) : undefined }));
  }));
  app.post('/approvals/steps/:id/decide', async (req) => {
    const { id } = parse(z.object({ id: z.string().uuid() }), req.params);
    const b = parse(z.object({ decision: z.enum(['approve', 'reject']), comment: z.string().max(2000).nullable().optional() }), req.body);
    return asActor(actorOf(req), (tx) => decideApproval(tx, actorOf(req), id, b));
  });
}
