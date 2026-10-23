import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { asActor } from '../../platform/auth/actor.js';
import { actorOf, parse } from '../../platform/http/helpers.js';
import { applyRecommendation, getInterview, saveAnswers } from './service.js';
import { getPreferences, savePreferences } from './preferences.js';
import { dismissSuggestion, nextSuggestion, openSuggestion, setCompanySuggestions, suggestionHistory, suggestionsEnabled } from './suggestions.js';

const Id = z.object({ id: z.string().uuid() });

export async function fitRoutes(app: FastifyInstance) {
  const run = <T>(req: any, f: (tx: any, a: any) => Promise<T>) => asActor(actorOf(req), (tx) => f(tx, actorOf(req)));
  app.get('/fit-interview', async (req) => run(req, (tx, a) => getInterview(tx, a)));
  app.put('/fit-interview', async (req) => {
    const b = parse(z.record(z.union([z.string(), z.boolean(), z.array(z.string())])), req.body);
    return run(req, (tx, a) => saveAnswers(tx, a, b));
  });
  app.post('/fit-interview/apply', async (req) => run(req, (tx, a) => applyRecommendation(tx, a)));

  app.get('/suggestions/next', async (req) => (await run(req, (tx, a) => nextSuggestion(tx, a))) ?? null);
  app.post('/suggestions/:id/dismiss', async (req, reply) => { const { id } = parse(Id, req.params); const b = parse(z.object({ snoozeDays: z.number().int().min(1).max(365).optional() }), req.body ?? {}); await run(req, (tx, a) => dismissSuggestion(tx, a, id, b)); reply.status(204); });
  app.post('/suggestions/:id/open', async (req, reply) => { const { id } = parse(Id, req.params); await run(req, (tx, a) => openSuggestion(tx, a, id)); reply.status(204); });
  app.get('/suggestions/settings', async (req) => run(req, (tx, a) => suggestionsEnabled(tx, a)));
  app.put('/suggestions/settings', async (req) => { const b = parse(z.object({ enabled: z.boolean() }), req.body); return run(req, (tx, a) => setCompanySuggestions(tx, a, b.enabled)); });
  app.get('/suggestions/history', async (req) => run(req, (tx, a) => suggestionHistory(tx, a)));

  app.get('/my-preferences', async (req) => run(req, (tx, a) => getPreferences(tx, a)));
  app.put('/my-preferences', async (req) => {
    const b = parse(z.object({ density: z.enum(['roomy', 'normal', 'compact']).optional(), textSize: z.enum(['normal', 'large', 'larger']).optional(), highContrast: z.boolean().optional(), reducedMotion: z.boolean().optional(),
      defaultView: z.enum(['chart', 'table']).optional(), suggestions: z.boolean().optional() }), req.body);
    return run(req, (tx, a) => savePreferences(tx, a, b));
  });
}
