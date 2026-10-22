import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { asActor } from '../../platform/auth/actor.js';
import { actorOf, parse } from '../../platform/http/helpers.js';
import {
  balanceSheet, categorizeBankLine, deleteRule, excludeBankLine, exportJournal, finishReconciliation, getReconciliation, listAccounts, listEntries, listReconciliations, listRules,
  manualEntry, matchBankLine, overview, profitAndLoss, register, reverse, reviewQueue, saveAccount, saveRule, saveSettings, setCleared, setupBooks, startReconciliation, trialBalance,
} from './service.js';

const Id = z.object({ id: z.string().uuid() });
const uuid = z.string().uuid();
const day = z.string().date();
const TYPES = ['asset', 'liability', 'equity', 'income', 'expense'] as const;

export async function bookRoutes(app: FastifyInstance) {
  const run = <T>(req: any, fn: (tx: any, actor: any) => Promise<T>) => asActor(actorOf(req), (tx) => fn(tx, actorOf(req)));
  const done = (reply: any) => reply.status(204);
  app.get('/books', async (req) => run(req, (tx, a) => overview(tx, a)));
  app.post('/books/setup', async (req) => {
    const b = parse(z.object({ startDate: day.optional(), bankName: z.string().max(80).optional(), bankLast4: z.string().regex(/^\d{4}$/).nullable().optional(),
      openingBalance: z.number().min(-1e9).max(1e9).optional(), fiscalYearStartMonth: z.number().int().min(1).max(12).optional() }), req.body ?? {});
    return run(req, (tx, a) => setupBooks(tx, a, b));
  });
  app.put('/books/settings', async (req, reply) => {
    const b = parse(z.object({ closedThrough: day.nullable().optional(), defaultBankAccountId: uuid.nullable().optional(), fiscalYearStartMonth: z.number().int().min(1).max(12).optional() }), req.body);
    await run(req, (tx, a) => saveSettings(tx, a, b)); done(reply);
  });
  app.get('/books/accounts', async (req) => run(req, (tx, a) => listAccounts(tx, a)));
  app.post('/books/accounts', async (req, reply) => {
    const b = parse(z.object({ id: uuid.optional(), code: z.string().min(1).max(20), name: z.string().min(1).max(120), type: z.enum(TYPES), subtype: z.string().max(40), active: z.boolean().optional(),
      bankLast4: z.string().regex(/^\d{4}$/).nullable().optional(), description: z.string().max(500).nullable().optional() }), req.body);
    await run(req, (tx, a) => saveAccount(tx, a, b)); done(reply);
  });
  app.get('/books/accounts/:id/register', async (req) => { const { id } = parse(Id, req.params); const q = parse(z.object({ from: day.optional(), to: day.optional() }), req.query); return run(req, (tx, a) => register(tx, a, id, q)); });
  app.get('/books/entries', async (req) => {
    const q = parse(z.object({ from: day.optional(), to: day.optional(), accountId: uuid.optional(), source: z.string().max(30).optional() }), req.query);
    return run(req, (tx, a) => listEntries(tx, a, q));
  });
  app.post('/books/entries', async (req, reply) => {
    const b = parse(z.object({ date: day, memo: z.string().min(2).max(500), lines: z.array(z.object({ accountId: uuid, debit: z.number().min(0).optional(), credit: z.number().min(0).optional(),
      memo: z.string().max(300).nullable().optional(), party: z.string().max(120).nullable().optional() })).min(2).max(50) }), req.body);
    reply.status(201); return run(req, (tx, a) => manualEntry(tx, a, b));
  });
  app.post('/books/entries/:id/reverse', async (req) => { const { id } = parse(Id, req.params); const b = parse(z.object({ date: day.optional() }), req.body ?? {}); return run(req, (tx, a) => reverse(tx, a, id, b)); });
  app.get('/books/export.csv', async (req, reply) => {
    const q = parse(z.object({ from: day.optional(), to: day.optional() }), req.query);
    const csv = await run(req, (tx, a) => exportJournal(tx, a, q));
    reply.header('content-type', 'text/csv; charset=utf-8').header('content-disposition', `attachment; filename="journal-${q.from ?? 'all'}-${q.to ?? 'today'}.csv"`);
    return csv;
  });
  app.get('/books/trial-balance', async (req) => { const q = parse(z.object({ asOf: day.optional() }), req.query); return run(req, (tx, a) => trialBalance(tx, a, q.asOf)); });
  app.get('/books/profit-and-loss', async (req) => { const q = parse(z.object({ from: day, to: day }), req.query); return run(req, (tx, a) => profitAndLoss(tx, a, q)); });
  app.get('/books/balance-sheet', async (req) => { const q = parse(z.object({ asOf: day.optional() }), req.query); return run(req, (tx, a) => balanceSheet(tx, a, q.asOf)); });
  app.get('/books/bank', async (req) => { const q = parse(z.object({ bankAccountId: uuid.optional(), status: z.enum(['unreviewed', 'matched', 'categorized', 'excluded']).optional() }), req.query); return run(req, (tx, a) => reviewQueue(tx, a, q)); });
  app.post('/books/bank/:id/match', async (req, reply) => { const { id } = parse(Id, req.params); const b = parse(z.object({ journalLineId: uuid }), req.body); await run(req, (tx, a) => matchBankLine(tx, a, id, b.journalLineId)); done(reply); });
  app.post('/books/bank/:id/categorize', async (req) => {
    const { id } = parse(Id, req.params);
    const b = parse(z.object({ accountId: uuid, memo: z.string().max(300).nullable().optional(), payee: z.string().max(120).nullable().optional(), remember: z.string().max(80).nullable().optional() }), req.body);
    return run(req, (tx, a) => categorizeBankLine(tx, a, id, b));
  });
  app.post('/books/bank/:id/exclude', async (req, reply) => { const { id } = parse(Id, req.params); const b = parse(z.object({ reason: z.string().min(2).max(300) }), req.body); await run(req, (tx, a) => excludeBankLine(tx, a, id, b.reason)); done(reply); });
  app.get('/books/rules', async (req) => run(req, (tx, a) => listRules(tx, a)));
  app.post('/books/rules', async (req) => {
    const b = parse(z.object({ id: uuid.optional(), contains: z.string().min(2).max(80), direction: z.enum(['in', 'out', 'any']).optional(), accountId: uuid, payee: z.string().max(120).nullable().optional(),
      priority: z.number().int().min(0).max(10_000).optional() }), req.body);
    return run(req, (tx, a) => saveRule(tx, a, b));
  });
  app.delete('/books/rules/:id', async (req, reply) => { const { id } = parse(Id, req.params); await run(req, (tx, a) => deleteRule(tx, a, id)); done(reply); });
  app.get('/books/reconciliations', async (req) => run(req, (tx, a) => listReconciliations(tx, a)));
  app.post('/books/reconciliations', async (req) => {
    const b = parse(z.object({ bankAccountId: uuid, statementDate: day, statementBalance: z.number().min(-1e10).max(1e10) }), req.body);
    return run(req, (tx, a) => startReconciliation(tx, a, b));
  });
  app.get('/books/reconciliations/:id', async (req) => { const { id } = parse(Id, req.params); return run(req, (tx, a) => getReconciliation(tx, a, id)); });
  app.post('/books/reconciliations/:id/cleared', async (req, reply) => {
    const { id } = parse(Id, req.params); const b = parse(z.object({ lineIds: z.array(uuid).min(1).max(1000), cleared: z.boolean() }), req.body);
    await run(req, (tx, a) => setCleared(tx, a, id, b)); done(reply);
  });
  app.post('/books/reconciliations/:id/finish', async (req, reply) => { const { id } = parse(Id, req.params); await run(req, (tx, a) => finishReconciliation(tx, a, id)); done(reply); });
}
