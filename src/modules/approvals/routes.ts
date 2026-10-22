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
    const prIds = steps.filter((s) => s.subject_type === 'purchase_request').map((s) => s.subject_id);
    const prs = new Map((await many(tx, `SELECT r.id, r.number, r.title, r.spend_type, r.revision, u.display_name AS requested_by,
        (SELECT coalesce(sum(l.qty * l.est_unit_price), 0)::float FROM purchase_request_line l WHERE l.request_id = r.id) AS total
      FROM purchase_request r JOIN app_user u ON u.id = r.requested_by WHERE r.id = ANY ($1)`, [prIds])).map((m) => [m.id, m]));
    const quoteIds = steps.filter((s) => s.subject_type === 'quote').map((s) => s.subject_id);
    const quotes = new Map((await many(tx, `SELECT q.id, q.number, q.title, q.revision, q.approval_reasons, c.name AS customer_name, u.display_name AS requested_by,
        (SELECT coalesce(sum(l.qty * l.unit_price), 0)::float FROM quote_line l WHERE l.quote_id = q.id) AS total
      FROM quote q JOIN customer c ON c.id = q.customer_id JOIN app_user u ON u.id = q.created_by WHERE q.id = ANY ($1)`, [quoteIds])).map((m) => [m.id, m]));
    return steps.map((s) => ({ stepId: s.step_id, label: s.label, role: s.role_key, purpose: s.purpose, subjectType: s.subject_type, subjectId: s.subject_id,
      requestedAt: s.created_at, onBehalfOf: s.on_behalf_of,
      subject: s.subject_type === 'moc_change' ? mocs.get(s.subject_id) : s.subject_type === 'purchase_request' ? prs.get(s.subject_id) : s.subject_type === 'quote' ? quotes.get(s.subject_id) : undefined }));
  }));
  app.post('/approvals/steps/:id/decide', async (req) => {
    const { id } = parse(z.object({ id: z.string().uuid() }), req.params);
    const b = parse(z.object({ decision: z.enum(['approve', 'reject']), comment: z.string().max(2000).nullable().optional() }), req.body);
    return asActor(actorOf(req), (tx) => decideApproval(tx, actorOf(req), id, b));
  });
}
