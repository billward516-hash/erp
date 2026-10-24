import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { asActor, requirePermission } from '../../platform/auth/actor.js';
import { many } from '../../platform/db/tx.js';
import { actorOf, parse, qbool } from '../../platform/http/helpers.js';
import { certificateData, renderCertificatePdf } from './certificate.js';
import { createMethod, getMethod, listMethods, retireMethod, reviseMethod } from './methods.js';
import { closeInvestigation, addTest, cancelTest, enterResults, getInvestigation, listInvestigations, raiseQuality, returnTest, reviewTest, updateInvestigation } from './results.js';
import { disposeSample, getSample, holdSample, listSamples, receiveSample, recordCustody, releaseSample, resumeSample, setSampleDates } from './samples.js';

const Id = z.object({ id: z.string().uuid() });
const uuid = z.string().uuid();
const day = z.string().date();
const text = (max = 2000) => z.string().min(1).max(max);
const analyte = z.object({ name: text(200), unit: text(40), specLow: z.number().nullable().optional(), specHigh: z.number().nullable().optional() });
const methodBody = z.object({
  name: text(200), description: z.string().max(4000).nullable().optional(), documentId: uuid.nullable().optional(), requiredQualificationId: uuid.nullable().optional(),
  requiredInstrumentClass: z.string().max(100).nullable().optional(), analytes: z.array(analyte).min(1).max(100),
});

/** Samples and test results (SC-007 D, D-184D). Every route's area is `lab`: a Lite company and a user who does not see the feature are refused before it runs. */
export async function labRoutes(app: FastifyInstance) {
  const run = <T>(req: any, fn: (tx: any, actor: any) => Promise<T>) => asActor(actorOf(req), (tx) => fn(tx, actorOf(req)));
  const done = (reply: any) => reply.status(204);

  // Choices for the forms: customers, instruments under calibration control, qualifications, controlled documents and people at the site.
  app.get('/lab/options', async (req) => {
    const q = parse(z.object({ facilityId: uuid.optional() }), req.query);
    return run(req, async (tx, a) => {
      requirePermission(a, 'lab.view', q.facilityId);
      const f = q.facilityId ?? null;
      return {
        customers: await many(tx, 'SELECT id, code, name FROM customer ORDER BY name LIMIT 500'),
        instruments: await many(tx, `SELECT x.id, x.asset_tag, x.name, x.category, x.facility_id, p.next_due,
            (p.next_due < current_date OR coalesce((SELECT r.as_left FROM calibration_record r WHERE r.plan_id = p.id ORDER BY r.performed_on DESC, r.created_at DESC LIMIT 1), '') = 'failed' OR x.operational_state = 'out_of_service') AS blocked
          FROM calibration_plan p JOIN asset x ON x.id = p.asset_id WHERE p.active AND ($1::uuid IS NULL OR p.facility_id = $1) ORDER BY x.asset_tag`, [f]),
        qualifications: await many(tx, 'SELECT id, code, name FROM qualification ORDER BY code'),
        documents: await many(tx, 'SELECT id, doc_number, title FROM document WHERE NOT restricted AND current_version_id IS NOT NULL ORDER BY doc_number LIMIT 500'),
        users: await many(tx, `SELECT DISTINCT u.id, u.display_name FROM app_user u JOIN user_role_scope s ON s.user_id = u.id WHERE u.status = 'active' AND ($1::uuid IS NULL OR s.facility_id IS NULL OR s.facility_id = $1) ORDER BY u.display_name`, [f]),
      };
    });
  });

  // Methods
  app.get('/lab/methods', async (req) => { const q = parse(z.object({ facilityId: uuid.optional(), all: qbool.optional() }), req.query); return run(req, (tx, a) => listMethods(tx, a, q)); });
  app.post('/lab/methods', async (req, reply) => {
    const b = parse(methodBody.extend({ facilityId: uuid, code: text(60) }), req.body);
    reply.status(201);
    return run(req, (tx, a) => createMethod(tx, a, b));
  });
  app.get('/lab/methods/:id', async (req) => { const { id } = parse(Id, req.params); return run(req, (tx, a) => getMethod(tx, a, id)); });
  app.post('/lab/methods/:id/revise', async (req, reply) => {
    const { id } = parse(Id, req.params); const b = parse(methodBody.partial(), req.body);
    reply.status(201);
    return run(req, (tx, a) => reviseMethod(tx, a, id, b));
  });
  app.post('/lab/methods/:id/retire', async (req, reply) => { const { id } = parse(Id, req.params); await run(req, (tx, a) => retireMethod(tx, a, id)); done(reply); });

  // Samples
  app.get('/lab/samples', async (req) => {
    const q = parse(z.object({ facilityId: uuid.optional(), status: z.enum(['received', 'in_testing', 'in_review', 'released', 'on_hold', 'disposed']).optional(), open: qbool.optional(), overdue: qbool.optional() }), req.query);
    return run(req, (tx, a) => listSamples(tx, a, q));
  });
  app.post('/lab/samples', async (req, reply) => {
    const b = parse(z.object({ facilityId: uuid, source: z.enum(['customer', 'internal']), customerId: uuid.nullable().optional(), customerReference: z.string().max(200).nullable().optional(), description: text(1000),
      container: z.string().max(200).nullable().optional(), quantity: z.number().min(0).nullable().optional(), quantityUnit: z.string().max(40).nullable().optional(), storageLocation: z.string().max(200).nullable().optional(),
      receivedOn: day.nullable().optional(), dueOn: day, retentionUntil: day.nullable().optional() }), req.body);
    reply.status(201);
    return run(req, (tx, a) => receiveSample(tx, a, b));
  });
  app.get('/lab/samples/:id', async (req) => { const { id } = parse(Id, req.params); return run(req, (tx, a) => getSample(tx, a, id)); });
  app.post('/lab/samples/:id/custody', async (req, reply) => {
    const { id } = parse(Id, req.params);
    const b = parse(z.object({ kind: z.enum(['moved', 'handed_over', 'returned']), toWhere: text(200), fromWhere: z.string().max(200).nullable().optional(), note: z.string().max(2000).nullable().optional() }), req.body);
    await run(req, (tx, a) => recordCustody(tx, a, id, b)); done(reply);
  });
  app.post('/lab/samples/:id/hold', async (req, reply) => { const { id } = parse(Id, req.params); const b = parse(z.object({ reason: text() }), req.body); await run(req, (tx, a) => holdSample(tx, a, id, b.reason)); done(reply); });
  app.post('/lab/samples/:id/resume', async (req, reply) => { const { id } = parse(Id, req.params); const b = parse(z.object({ note: z.string().max(2000).nullable().optional() }), req.body ?? {}); await run(req, (tx, a) => resumeSample(tx, a, id, b.note)); done(reply); });
  app.post('/lab/samples/:id/release', async (req, reply) => { const { id } = parse(Id, req.params); const b = parse(z.object({ note: z.string().max(2000).nullable().optional() }), req.body ?? {}); await run(req, (tx, a) => releaseSample(tx, a, id, b.note)); done(reply); });
  app.post('/lab/samples/:id/dispose', async (req, reply) => {
    const { id } = parse(Id, req.params); const b = parse(z.object({ note: text(), confirmEarly: z.boolean().optional() }), req.body);
    await run(req, (tx, a) => disposeSample(tx, a, id, b)); done(reply);
  });
  app.put('/lab/samples/:id/dates', async (req, reply) => {
    const { id } = parse(Id, req.params); const b = parse(z.object({ dueOn: day.optional(), retentionUntil: day.nullable().optional(), reason: text() }), req.body);
    await run(req, (tx, a) => setSampleDates(tx, a, id, b)); done(reply);
  });
  app.post('/lab/samples/:id/tests', async (req, reply) => {
    const { id } = parse(Id, req.params); const b = parse(z.object({ methodId: uuid, assignedUserId: uuid.nullable().optional() }), req.body);
    reply.status(201);
    return run(req, (tx, a) => addTest(tx, a, id, b));
  });
  app.get('/lab/samples/:id/certificate.pdf', async (req, reply) => {
    const { id } = parse(Id, req.params);
    const c = await run(req, (tx, a) => certificateData(tx, a, id));
    reply.header('content-type', 'application/pdf').header('content-disposition', `inline; filename="${c.number}-certificate-of-analysis.pdf"`);
    return renderCertificatePdf(c);
  });

  // Tests and results
  app.post('/lab/tests/:id/results', async (req) => {
    const { id } = parse(Id, req.params);
    const b = parse(z.object({ results: z.array(z.object({ analyteId: uuid, value: z.number().finite(), instrumentId: uuid.nullable().optional(), note: z.string().max(1000).nullable().optional() })).min(1).max(100) }), req.body);
    return run(req, (tx, a) => enterResults(tx, a, id, b.results));
  });
  app.post('/lab/tests/:id/review', async (req, reply) => { const { id } = parse(Id, req.params); const b = parse(z.object({ note: z.string().max(2000).nullable().optional() }), req.body ?? {}); await run(req, (tx, a) => reviewTest(tx, a, id, b.note)); done(reply); });
  app.post('/lab/tests/:id/return', async (req, reply) => { const { id } = parse(Id, req.params); const b = parse(z.object({ reason: text() }), req.body); await run(req, (tx, a) => returnTest(tx, a, id, b.reason)); done(reply); });
  app.post('/lab/tests/:id/cancel', async (req, reply) => { const { id } = parse(Id, req.params); const b = parse(z.object({ reason: text() }), req.body); await run(req, (tx, a) => cancelTest(tx, a, id, b.reason)); done(reply); });

  // Out-of-specification investigations
  app.get('/lab/investigations', async (req) => { const q = parse(z.object({ status: z.enum(['open', 'closed']).optional(), facilityId: uuid.optional() }), req.query); return run(req, (tx, a) => listInvestigations(tx, a, q)); });
  app.get('/lab/investigations/:id', async (req) => { const { id } = parse(Id, req.params); return run(req, (tx, a) => getInvestigation(tx, a, id)); });
  app.put('/lab/investigations/:id', async (req, reply) => {
    const { id } = parse(Id, req.params); const b = parse(z.object({ cause: z.string().max(4000).nullable().optional(), retestResult: z.string().max(4000).nullable().optional() }), req.body);
    await run(req, (tx, a) => updateInvestigation(tx, a, id, b)); done(reply);
  });
  app.post('/lab/investigations/:id/close', async (req, reply) => {
    const { id } = parse(Id, req.params);
    const b = parse(z.object({ decision: z.enum(['confirmed_oos', 'invalidated']), conclusion: text(4000), invalidReason: z.string().max(2000).nullable().optional() }), req.body);
    await run(req, (tx, a) => closeInvestigation(tx, a, id, b)); done(reply);
  });
  app.post('/lab/investigations/:id/quality', async (req, reply) => {
    const { id } = parse(Id, req.params);
    const b = parse(z.object({ kind: z.enum(['ncr', 'capa']), severity: z.enum(['minor', 'major', 'critical']).optional(), ownerUserId: uuid.nullable().optional(), priority: z.enum(['low', 'medium', 'high']).optional() }), req.body);
    reply.status(201);
    return run(req, (tx, a) => raiseQuality(tx, a, id, { ...b, ownerUserId: b.ownerUserId ?? undefined }));
  });
}
