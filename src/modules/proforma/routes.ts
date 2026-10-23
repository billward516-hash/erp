import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Actor } from '../../platform/auth/actor.js';
import { asActor } from '../../platform/auth/actor.js';
import type { Tx } from '../../platform/db/tx.js';
import { actorOf, parse } from '../../platform/http/helpers.js';
import { archiveProforma, baselineFromBooks, compareProformas, copyProforma, createProforma, getProforma, importLines, importSources, listProformas, planVsActual, proformaSettings, reopenProforma, saveProformaSettings, saveProforma, starterLines,
  submitProforma } from './service.js';

const Id = z.object({ id: z.string().uuid() });
const num = z.number().finite();
const Scenario = z.object({ revenuePct: num, costPct: num, capitalPct: num, delayMonths: z.number().int() });
const Line = z.object({
  section: z.enum(['revenue', 'cost_of_sales', 'operating', 'capital']), label: z.string().max(200), method: z.enum(['units_price', 'fixed_monthly', 'pct_of_revenue', 'headcount', 'one_time']),
  amount: num, qty: num.nullable().optional(), growthPct: num.nullable().optional(), startMonth: z.number().int().min(0).nullable().optional(),
  endMonth: z.number().int().min(1).nullable().optional(), rampMonths: z.number().int().min(0).max(120).nullable().optional(), lifeYears: num.positive().max(100).nullable().optional(),
  note: z.string().max(1000).nullable().optional(), source: z.string().max(200).nullable().optional(),
});
const Header = z.object({
  facilityId: z.string().uuid().nullable().optional(), title: z.string().min(3).max(200), kind: z.enum(['new_site', 'product_line', 'customer_contract', 'capital_project', 'other']),
  description: z.string().max(4000).nullable().optional(), startMonth: z.string(), years: z.number().int().optional(), discountRatePct: num.min(0).max(100).optional(),
  taxRatePct: num.min(0).max(100).optional(), workingCapitalDays: z.number().int().min(0).max(365).optional(), ownerUserId: z.string().uuid().nullable().optional(),
  scenarios: z.object({ low: Scenario, base: Scenario, high: Scenario }).partial().optional(),
});
const run = <T>(req: any, fn: (tx: Tx, a: Actor) => Promise<T>) => asActor(actorOf(req), (tx) => fn(tx, actorOf(req)));

export async function proformaRoutes(app: FastifyInstance) {
  app.get('/proformas', async (req) => {
    const q = parse(z.object({ status: z.enum(['draft', 'submitted', 'approved', 'archived']).optional() }), req.query);
    return run(req, (tx, a) => listProformas(tx, a, q));
  });
  app.post('/proformas', async (req, reply) => {
    const b = parse(Header.extend({ lines: z.array(Line).optional(), useStarter: z.boolean().optional() }), req.body);
    reply.status(201);
    return run(req, (tx, a) => createProforma(tx, a, b));
  });
  app.get('/proformas/starter/:kind', async (req) => {
    const { kind } = parse(z.object({ kind: z.enum(['new_site', 'product_line', 'customer_contract', 'capital_project', 'other']) }), req.params);
    return starterLines(kind);
  });
  app.get('/proformas/baseline', async (req) => {
    const q = parse(z.object({ facilityId: z.string().uuid() }), req.query);
    return run(req, (tx, a) => baselineFromBooks(tx, a, q.facilityId));
  });
  // ?plans=<id>[:<revision>],<id>[:<revision>] (two or three)
  app.get('/proformas/compare', async (req) => {
    const q = parse(z.object({ plans: z.string().max(400) }), req.query);
    const refs = q.plans.split(',').map((x) => { const [id, rev] = x.split(':'); return { id: parse(z.string().uuid(), id), revision: rev ? parse(z.coerce.number().int().min(1), rev) : null }; });
    return run(req, (tx, a) => compareProformas(tx, a, refs));
  });
  app.get('/proformas/settings', async (req) => run(req, (tx, a) => proformaSettings(tx, a)));
  app.put('/proformas/settings', async (req) => {
    const b = parse(z.object({ approverUserId: z.string().uuid().nullable() }), req.body);
    return run(req, (tx, a) => saveProformaSettings(tx, a, b));
  });
  app.get('/proformas/sources', async (req) => {
    const q = parse(z.object({ facilityId: z.string().uuid().optional() }), req.query);
    return run(req, (tx, a) => importSources(tx, a, q.facilityId ?? null));
  });
  app.post('/proformas/import-lines', async (req) => {
    const b = parse(z.object({ source: z.enum(['books', 'budget', 'opportunity', 'rent_roll', 'asset', 'labor']), facilityId: z.string().uuid().nullable().optional(),
      refId: z.string().uuid().nullable().optional(), startMonth: z.string().regex(/^\d{4}-\d{2}$/).nullable().optional() }), req.body);
    return run(req, (tx, a) => importLines(tx, a, b));
  });
  app.get('/proformas/:id', async (req) => { const { id } = parse(Id, req.params); return run(req, (tx, a) => getProforma(tx, a, id)); });
  app.put('/proformas/:id', async (req) => {
    const { id } = parse(Id, req.params);
    const b = parse(Header.extend({ lines: z.array(Line) }), req.body);
    return run(req, (tx, a) => saveProforma(tx, a, id, b));
  });
  app.get('/proformas/:id/actuals', async (req) => { const { id } = parse(Id, req.params); return run(req, (tx, a) => planVsActual(tx, a, id)); });
  app.post('/proformas/:id/submit', async (req) => { const { id } = parse(Id, req.params); return run(req, (tx, a) => submitProforma(tx, a, id)); });
  app.post('/proformas/:id/reopen', async (req) => {
    const { id } = parse(Id, req.params); const b = parse(z.object({ reason: z.string().max(1000) }), req.body);
    return run(req, (tx, a) => reopenProforma(tx, a, id, b.reason));
  });
  app.post('/proformas/:id/copy', async (req, reply) => { const { id } = parse(Id, req.params); reply.status(201); return run(req, (tx, a) => copyProforma(tx, a, id)); });
  app.post('/proformas/:id/archive', async (req, reply) => { const { id } = parse(Id, req.params); await run(req, (tx, a) => archiveProforma(tx, a, id)); reply.status(204); });
}
