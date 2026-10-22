import { assetLifecycle } from './lifecycle.js';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { asActor } from '../../platform/auth/actor.js';
import { auditHistory } from '../../platform/audit/audit.js';
import { actorOf, parse } from '../../platform/http/helpers.js';
import { assetReliability, assetUtilization, createAsset, getAsset, getAssetByQr, listAssets, recordState, updateAsset } from './service.js';
import { ASSET_STATES } from './utilization.js';

const nullableStr = z.string().max(500).nullable().optional();
const AssetFields = {
  assetTag: z.string().min(1).max(64), name: z.string().min(1).max(200), locationId: z.string().uuid().nullable().optional(),
  parentAssetId: z.string().uuid().nullable().optional(),
  assetClass: z.enum(['equipment', 'component', 'tool', 'vehicle', 'facility_system', 'it', 'space']).optional(),
  category: nullableStr, manufacturer: nullableStr, model: nullableStr, serialNumber: nullableStr,
  commissionedOn: z.string().date().nullable().optional(), warrantyExpiresOn: z.string().date().nullable().optional(),
  criticality: z.enum(['high', 'medium', 'low']).nullable().optional(), lifecycleStatus: z.enum(['planned', 'active', 'inactive', 'disposed']).optional(),
  responsibleTeam: nullableStr, vendorName: nullableStr, ratedCapacity: z.number().nonnegative().nullable().optional(),
  ratedCapacityUnit: nullableStr, replacementCost: z.number().nonnegative().nullable().optional(),
  expectedLifeYears: z.number().int().min(1).max(100).nullable().optional(), downtimeCostPerHour: z.number().nonnegative().max(1e6).nullable().optional(), customFields: z.record(z.unknown()).optional(),
};
const CreateAsset = z.object({ facilityId: z.string().uuid(), ...AssetFields });
const PatchAsset = z.object(AssetFields).partial();
const Id = z.object({ id: z.string().uuid() });

export async function assetRoutes(app: FastifyInstance) {
  app.get('/assets', async (req) => {
    const q = parse(z.object({
      facilityId: z.string().uuid().optional(), q: z.string().optional(), state: z.enum(ASSET_STATES).optional(),
      criticality: z.enum(['high', 'medium', 'low']).optional(), topLevel: z.coerce.boolean().optional(),
      limit: z.coerce.number().int().positive().optional(), offset: z.coerce.number().int().nonnegative().optional(),
    }), req.query);
    return asActor(actorOf(req), (tx) => listAssets(tx, actorOf(req), { ...q, parentAssetId: q.topLevel ? null : undefined }));
  });
  app.post('/assets', async (req, reply) => {
    const body = parse(CreateAsset, req.body);
    reply.status(201);
    return asActor(actorOf(req), (tx) => createAsset(tx, actorOf(req), body));
  });
  app.get('/assets/qr/:token', async (req) => {
    const { token } = parse(z.object({ token: z.string().min(8).max(64) }), req.params);
    return asActor(actorOf(req), (tx) => getAssetByQr(tx, actorOf(req), token));
  });
  app.get('/assets/:id', async (req) => {
    const { id } = parse(Id, req.params);
    return asActor(actorOf(req), (tx) => getAsset(tx, actorOf(req), id));
  });
  app.patch('/assets/:id', async (req) => {
    const { id } = parse(Id, req.params);
    const body = parse(PatchAsset, req.body);
    return asActor(actorOf(req), async (tx) => (await updateAsset(tx, actorOf(req), id, body)).asset);
  });
  app.get('/assets/:id/lifecycle', async (req) => {
    const { id } = parse(Id, req.params);
    const q = parse(z.object({ discountRate: z.coerce.number().min(0).max(0.5).optional(), laborRate: z.coerce.number().min(0).max(1000).optional() }), req.query);
    return asActor(actorOf(req), (tx) => assetLifecycle(tx, actorOf(req), id, q));
  });
  app.post('/assets/:id/state', async (req) => {
    const { id } = parse(Id, req.params);
    const body = parse(z.object({ state: z.enum(ASSET_STATES), at: z.coerce.date().optional(), reasonCode: z.string().nullable().optional(), note: z.string().max(2000).nullable().optional() }), req.body);
    return asActor(actorOf(req), (tx) => recordState(tx, actorOf(req), id, { ...body, source: 'manual' }));
  });
  app.get('/assets/:id/utilization', async (req) => {
    const { id } = parse(Id, req.params);
    const q = parse(z.object({ from: z.coerce.date(), to: z.coerce.date(), basis: z.enum(['calendar', 'scheduled']).default('scheduled') }), req.query);
    return asActor(actorOf(req), (tx) => assetUtilization(tx, actorOf(req), id, q.from, q.to, q.basis));
  });
  app.get('/assets/:id/reliability', async (req) => {
    const { id } = parse(Id, req.params);
    const q = parse(z.object({ days: z.coerce.number().int().min(30).max(1095).default(365) }), req.query);
    return asActor(actorOf(req), (tx) => assetReliability(tx, actorOf(req), id, q.days));
  });
  app.get('/assets/:id/history', async (req) => {
    const { id } = parse(Id, req.params);
    return asActor(actorOf(req), async (tx) => { await getAsset(tx, actorOf(req), id); return auditHistory(tx, 'asset', id); });
  });
}
