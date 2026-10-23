import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { asActor } from '../../platform/auth/actor.js';
import { actorOf, parse } from '../../platform/http/helpers.js';
import { listReminders, setReminder, setReminderEditors } from './settings.js';

const Key = z.object({ key: z.string().max(40) });

export async function reminderRoutes(app: FastifyInstance) {
  app.get('/reminder-settings', async (req) => asActor(actorOf(req), (tx) => listReminders(tx, actorOf(req))));
  app.put('/reminder-settings/:key', async (req, reply) => {
    const { key } = parse(Key, req.params);
    const b = parse(z.object({ enabled: z.boolean(), leadDays: z.number().int().nullable().optional(), repeat: z.enum(['daily', 'weekly', 'once']) }), req.body);
    await asActor(actorOf(req), (tx) => setReminder(tx, actorOf(req), key, b));
    reply.status(204);
  });
  app.put('/reminder-settings/:key/editors', async (req, reply) => {
    const { key } = parse(Key, req.params);
    const b = parse(z.object({ roleKeys: z.array(z.string().max(60)).max(100).nullable() }), req.body);
    await asActor(actorOf(req), (tx) => setReminderEditors(tx, actorOf(req), key, b.roleKeys));
    reply.status(204);
  });
}
