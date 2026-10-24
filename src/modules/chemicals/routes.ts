import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { asActor } from '../../platform/auth/actor.js';
import { actorOf, parse } from '../../platform/http/helpers.js';
import { chemicalLabelsPdf, createPreparation, discardPreparation, getPreparation, listPreparations, usePreparation } from './preparations.js';
import {
  addIncompatiblePair, createContainer, deleteLimit, disposeContainer, getChemicalPart, getContainer, getSettings, listChemicalParts, listContainers, listLimits, listLocations, listStorageGroups,
  markEmpty, moveContainer, openContainer, overview, recordUse, removeIncompatiblePair, saveStorageGroup, setChemicalPart, setLimit, setSettings,
} from './service.js';

const uuid = z.string().uuid();
const Id = z.object({ id: uuid });
const date = z.string().date();

/** Chemicals and reagents (SC-007 C). Everything lives under /api/chemicals so one feature switch covers it. */
export async function chemicalRoutes(app: FastifyInstance) {
  const run = <T>(req: any, fn: (tx: any, a: ReturnType<typeof actorOf>) => Promise<T>) => asActor(actorOf(req), (tx) => fn(tx, actorOf(req)));

  app.get('/chemicals/overview', async (req) => run(req, (tx, a) => overview(tx, a)));
  app.get('/chemicals/settings', async (req) => run(req, (tx, a) => getSettings(tx, a)));
  app.put('/chemicals/settings', async (req, reply) => {
    const b = parse(z.object({ sdsMaxAgeYears: z.number().int().min(1).max(20).optional(), receiptContainers: z.boolean().optional() }), req.body);
    await run(req, (tx, a) => setSettings(tx, a, b));
    reply.status(204);
  });
  app.get('/chemicals/locations', async (req) => run(req, (tx, a) => listLocations(tx, a)));

  // Storage groups and the incompatible list
  app.get('/chemicals/storage-groups', async (req) => run(req, (tx, a) => listStorageGroups(tx, a)));
  app.post('/chemicals/storage-groups', async (req, reply) => {
    const b = parse(z.object({ id: uuid.nullable().optional(), code: z.string().min(1).max(20), name: z.string().min(2).max(120), description: z.string().max(300).nullable().optional(), active: z.boolean().optional() }), req.body);
    reply.status(b.id ? 200 : 201);
    return run(req, (tx, a) => saveStorageGroup(tx, a, b));
  });
  app.post('/chemicals/incompatible-pairs', async (req, reply) => {
    const b = parse(z.object({ groupA: uuid, groupB: uuid, reason: z.string().max(300).nullable().optional() }), req.body);
    reply.status(201);
    return run(req, (tx, a) => addIncompatiblePair(tx, a, b));
  });
  app.delete('/chemicals/incompatible-pairs/:id', async (req, reply) => {
    const { id } = parse(Id, req.params);
    await run(req, (tx, a) => removeIncompatiblePair(tx, a, id));
    reply.status(204);
  });

  // Chemical attributes of a part
  app.get('/chemicals/parts', async (req) => {
    const q = parse(z.object({ q: z.string().max(100).optional(), problem: z.enum(['no_sds', 'old_sds', 'no_group']).optional() }), req.query);
    return run(req, (tx, a) => listChemicalParts(tx, a, q));
  });
  app.get('/chemicals/parts/:id', async (req) => { const { id } = parse(Id, req.params); return run(req, (tx, a) => getChemicalPart(tx, a, id)); });
  app.put('/chemicals/parts/:id', async (req) => {
    const { id } = parse(Id, req.params);
    const b = parse(z.object({
      isChemical: z.boolean(), hazardClasses: z.array(z.string().max(40)).max(12).optional(), signalWord: z.enum(['none', 'warning', 'danger']).optional(), casNumber: z.string().max(20).nullable().optional(),
      sdsDocumentId: uuid.nullable().optional(), sdsRevisionOn: date.nullable().optional(), storageGroupId: uuid.nullable().optional(), inUseDays: z.number().int().positive().max(3650).nullable().optional(),
      storageConditions: z.string().max(500).nullable().optional(),
    }), req.body);
    return run(req, (tx, a) => setChemicalPart(tx, a, id, b));
  });

  // Containers
  app.get('/chemicals/containers', async (req) => {
    const q = parse(z.object({ facilityId: uuid.optional(), locationId: uuid.optional(), partId: uuid.optional(), q: z.string().max(100).optional(),
      status: z.enum(['active', 'in_storage', 'in_use', 'empty', 'disposed', 'all']).optional(), withinDays: z.coerce.number().int().min(0).max(3650).optional() }), req.query);
    return run(req, (tx, a) => listContainers(tx, a, q));
  });
  app.post('/chemicals/containers', async (req, reply) => {
    const b = parse(z.object({ partId: uuid, locationId: uuid, lot: z.string().min(1).max(60), qty: z.number().positive().max(1_000_000), expiresOn: date.nullable().optional(),
      receiveIntoStock: z.boolean().optional(), containerSize: z.number().positive().nullable().optional(), unitCost: z.number().nonnegative().nullable().optional(), overrideReason: z.string().max(500).nullable().optional() }), req.body);
    reply.status(201);
    return run(req, (tx, a) => createContainer(tx, a, b));
  });
  app.get('/chemicals/containers/:id', async (req) => { const { id } = parse(Id, req.params); return run(req, (tx, a) => getContainer(tx, a, id)); });
  app.post('/chemicals/containers/:id/open', async (req) => {
    const { id } = parse(Id, req.params); const b = parse(z.object({ openedOn: date.nullable().optional() }), req.body ?? {});
    return run(req, (tx, a) => openContainer(tx, a, id, b));
  });
  app.post('/chemicals/containers/:id/use', async (req, reply) => {
    const { id } = parse(Id, req.params);
    const b = parse(z.object({ qty: z.number().positive(), reference: z.string().min(1).max(100), reason: z.string().max(500).nullable().optional() }), req.body);
    await run(req, (tx, a) => recordUse(tx, a, id, b));
    reply.status(204);
  });
  app.post('/chemicals/containers/:id/move', async (req, reply) => {
    const { id } = parse(Id, req.params);
    const b = parse(z.object({ toLocationId: uuid, overrideReason: z.string().max(500).nullable().optional() }), req.body);
    await run(req, (tx, a) => moveContainer(tx, a, id, b));
    reply.status(204);
  });
  app.post('/chemicals/containers/:id/empty', async (req, reply) => {
    const { id } = parse(Id, req.params);
    await run(req, (tx, a) => markEmpty(tx, a, id));
    reply.status(204);
  });
  app.post('/chemicals/containers/:id/dispose', async (req, reply) => {
    const { id } = parse(Id, req.params);
    const b = parse(z.object({ note: z.string().min(3).max(500), disposedOn: date.nullable().optional() }), req.body);
    await run(req, (tx, a) => disposeContainer(tx, a, id, b));
    reply.status(204);
  });

  // Preparations
  app.get('/chemicals/preparations', async (req) => {
    const q = parse(z.object({ facilityId: uuid.optional(), status: z.enum(['active', 'used_up', 'discarded', 'all']).optional(), q: z.string().max(100).optional() }), req.query);
    return run(req, (tx, a) => listPreparations(tx, a, q));
  });
  app.post('/chemicals/preparations', async (req, reply) => {
    const b = parse(z.object({
      facilityId: uuid, name: z.string().min(2).max(160), kind: z.enum(['reagent', 'standard']), concentration: z.string().max(80).nullable().optional(), qty: z.number().positive().max(1_000_000), uom: z.string().min(1).max(10),
      preparedOn: date.nullable().optional(), shelfLifeDays: z.number().int().positive().max(36500).nullable().optional(), notes: z.string().max(1000).nullable().optional(),
      components: z.array(z.object({ containerId: uuid.nullable().optional(), preparationId: uuid.nullable().optional(), qty: z.number().positive() })).min(1).max(40),
    }), req.body);
    reply.status(201);
    return run(req, (tx, a) => createPreparation(tx, a, b));
  });
  app.get('/chemicals/preparations/:id', async (req) => { const { id } = parse(Id, req.params); return run(req, (tx, a) => getPreparation(tx, a, id)); });
  app.post('/chemicals/preparations/:id/use', async (req, reply) => {
    const { id } = parse(Id, req.params); const b = parse(z.object({ qty: z.number().positive(), note: z.string().max(300).nullable().optional() }), req.body);
    await run(req, (tx, a) => usePreparation(tx, a, id, b));
    reply.status(204);
  });
  app.post('/chemicals/preparations/:id/discard', async (req, reply) => {
    const { id } = parse(Id, req.params); const b = parse(z.object({ note: z.string().min(3).max(300) }), req.body);
    await run(req, (tx, a) => discardPreparation(tx, a, id, b));
    reply.status(204);
  });

  // Limits per location and hazard class (the company's own)
  app.get('/chemicals/limits', async (req) => { const q = parse(z.object({ facilityId: uuid.optional() }), req.query); return run(req, (tx, a) => listLimits(tx, a, q.facilityId)); });
  app.put('/chemicals/limits', async (req, reply) => {
    const b = parse(z.object({ locationId: uuid, hazardClass: z.string().min(1).max(40), limitQty: z.number().nonnegative().max(1e9), uom: z.string().min(1).max(10), note: z.string().max(300).nullable().optional() }), req.body);
    await run(req, (tx, a) => setLimit(tx, a, b));
    reply.status(204);
  });
  app.delete('/chemicals/limits/:id', async (req, reply) => {
    const { id } = parse(Id, req.params);
    await run(req, (tx, a) => deleteLimit(tx, a, id));
    reply.status(204);
  });

  // Labels on the scan station's Code 128 sheet
  app.post('/chemicals/labels/pdf', async (req, reply) => {
    const b = parse(z.object({ kind: z.enum(['container', 'preparation']), ids: z.array(uuid).min(1).max(300) }), req.body);
    const pdf = await run(req, (tx, a) => chemicalLabelsPdf(tx, a, b));
    reply.header('content-type', 'application/pdf').header('content-disposition', 'inline; filename="chemical-labels.pdf"');
    return pdf;
  });
}
