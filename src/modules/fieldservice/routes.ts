import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { asActor } from '../../platform/auth/actor.js';
import { actorOf, parse, qbool } from '../../platform/http/helpers.js';
import {
  activateAgreement, addCustomerEquipment, addPlan, addTimeOff, cancelVisit, createAgreement, createCallout, endAgreement, generateVisits, getAgreement, getSettings, getVisit, listAgreements, listCustomerEquipment,
  listSites, listTechnicians, listTimeOff, listVehicles, listVisits, removeTimeOff, saveSettings, saveSite, saveTechnician, saveVehicle, setPlanActive, suspendAgreement, updateAgreement,
} from './service.js';
import { checkoutTool, listToolCheckouts, listTools, restockList, restockTruck, returnTool, setTruckLevel, truckStock } from './trucks.js';
import { billVisit, getReport, quoteFromReport, readyToBill, reportSignature, runMonthlyBilling, saveReportDraft, submitReport } from './report.js';
import { assign, board, dispatchDay, myDay, startVisit, suggest, unassign } from './dispatch.js';

const Id = z.object({ id: z.string().uuid() });
const uuid = z.string().uuid();
const date = z.string().date();
const lat = z.number().min(-90).max(90).nullable().optional();
const lon = z.number().min(-180).max(180).nullable().optional();

/** Field service (SC-002): agreements, covered units, visits, technicians and vehicles. */
export async function fieldServiceRoutes(app: FastifyInstance) {
  const run = <T>(req: any, f: (tx: any, a: any) => Promise<T>) => asActor(actorOf(req), (tx) => f(tx, actorOf(req)));
  app.get('/service-settings', async (req) => run(req, (tx) => getSettings(tx)));
  app.put('/service-settings', async (req) => {
    const b = parse(z.object({ roadFactor: z.number().optional(), avgSpeedMph: z.number().optional(), horizonDays: z.number().int().optional(), defaultVisitMinutes: z.number().int().optional(), laborRatePerHour: z.number().optional(), partsMarkupPercent: z.number().optional() }), req.body);
    return run(req, (tx, a) => saveSettings(tx, a, b));
  });

  app.get('/customer-sites', async (req) => { const q = parse(z.object({ customerId: uuid.optional() }), req.query); return run(req, (tx, a) => listSites(tx, a, q)); });
  app.post('/customer-sites', async (req, reply) => {
    const b = parse(z.object({ id: uuid.optional(), customerId: uuid, name: z.string().min(1).max(200), address: z.record(z.string().max(200)).optional(), lat, lon, accessNotes: z.string().max(2000).nullable().optional(), contactId: uuid.nullable().optional(), active: z.boolean().optional() }), req.body);
    reply.status(b.id ? 200 : 201);
    return run(req, (tx, a) => saveSite(tx, a, b));
  });
  app.get('/customer-equipment', async (req) => { const q = parse(z.object({ customerId: uuid.optional(), siteId: uuid.optional() }), req.query); return run(req, (tx, a) => listCustomerEquipment(tx, a, q)); });
  app.post('/customer-equipment', async (req, reply) => {
    const b = parse(z.object({ facilityId: uuid, customerId: uuid, siteId: uuid, assetTag: z.string().min(1).max(60), name: z.string().min(1).max(200), manufacturer: z.string().max(100).nullable().optional(), model: z.string().max(100).nullable().optional(),
      serialNumber: z.string().max(100).nullable().optional(), category: z.string().max(100).nullable().optional() }), req.body);
    reply.status(201);
    return run(req, (tx, a) => addCustomerEquipment(tx, a, b));
  });

  app.get('/technicians', async (req) => run(req, (tx, a) => listTechnicians(tx, a)));
  app.put('/technicians/:id', async (req, reply) => {
    const { id } = parse(Id, req.params);
    const b = parse(z.object({ homeLat: lat, homeLon: lon, skills: z.array(z.string().max(60)).max(40).optional(), dayStart: z.string().regex(/^\d{2}:\d{2}$/).optional(), dayEnd: z.string().regex(/^\d{2}:\d{2}$/).optional(),
      workDays: z.array(z.number().int().min(0).max(6)).max(7).optional(), vehicleId: uuid.nullable().optional(), active: z.boolean().optional() }), req.body);
    return run(req, (tx, a) => saveTechnician(tx, a, id, b)).then((r) => { reply.status(200); return r; });
  });
  app.get('/technician-time-off', async (req) => { const q = parse(z.object({ employeeId: uuid.optional() }), req.query); return run(req, (tx, a) => listTimeOff(tx, a, q.employeeId)); });
  app.post('/technicians/:id/time-off', async (req, reply) => {
    const { id } = parse(Id, req.params); const b = parse(z.object({ fromDate: date, toDate: date, reason: z.string().max(300).nullable().optional() }), req.body);
    reply.status(201);
    return run(req, (tx, a) => addTimeOff(tx, a, id, b));
  });
  app.delete('/technician-time-off/:id', async (req, reply) => { const { id } = parse(Id, req.params); await run(req, (tx, a) => removeTimeOff(tx, a, id)); reply.status(204); });
  app.get('/vehicles', async (req) => run(req, (tx, a) => listVehicles(tx, a)));
  app.post('/vehicles', async (req, reply) => {
    const b = parse(z.object({ id: uuid.optional(), facilityId: uuid, tag: z.string().min(1).max(60), name: z.string().min(1).max(200), plate: z.string().max(20).nullable().optional(), vin: z.string().max(30).nullable().optional(),
      homeLat: lat, homeLon: lon, assignedEmployeeId: uuid.nullable().optional() }), req.body);
    reply.status(b.id ? 200 : 201);
    return run(req, (tx, a) => saveVehicle(tx, a, b));
  });

  app.get('/service-agreements', async (req) => { const q = parse(z.object({ status: z.string().optional(), customerId: uuid.optional() }), req.query); return run(req, (tx, a) => listAgreements(tx, a, q)); });
  const agreementBody = {
    startsOn: date, endsOn: date.nullable().optional(), billingModel: z.enum(['per_visit', 'monthly']), monthlyFee: z.number().nonnegative().nullable().optional(), perVisitFee: z.number().nonnegative().nullable().optional(),
    responseHours: z.number().int().positive().max(720).nullable().optional(), autoRenew: z.boolean().optional(), partsIncluded: z.boolean().optional(), paymentTerms: z.string().max(100).nullable().optional(), terms: z.string().max(8000).nullable().optional(),
  };
  app.post('/service-agreements', async (req, reply) => {
    const b = parse(z.object({ facilityId: uuid, customerId: uuid, ownerUserId: uuid.nullable().optional(), ...agreementBody }), req.body);
    reply.status(201);
    return run(req, (tx, a) => createAgreement(tx, a, b));
  });
  app.get('/service-agreements/:id', async (req) => { const { id } = parse(Id, req.params); return run(req, (tx, a) => getAgreement(tx, a, id)); });
  app.patch('/service-agreements/:id', async (req) => {
    const { id } = parse(Id, req.params);
    const b = parse(z.object(Object.fromEntries(Object.entries(agreementBody).map(([k, v]) => [k, (v as z.ZodTypeAny).optional()]))), req.body);
    return run(req, (tx, a) => updateAgreement(tx, a, id, b as any));
  });
  app.post('/service-agreements/:id/plans', async (req, reply) => {
    const { id } = parse(Id, req.params);
    const b = parse(z.object({ assetId: uuid, title: z.string().min(1).max(200), everyN: z.number().int().min(1).max(60), unit: z.enum(['week', 'month', 'year']), firstDueOn: date, estimatedMinutes: z.number().int().min(5).max(960).nullable().optional(),
      requiredSkill: z.string().max(60).nullable().optional(), checklist: z.array(z.string().max(300)).max(60).optional(), perVisitFee: z.number().nonnegative().nullable().optional() }), req.body);
    reply.status(201);
    return run(req, (tx, a) => addPlan(tx, a, id, b));
  });
  app.post('/service-plans/:id/active', async (req, reply) => { const { id } = parse(Id, req.params); const b = parse(z.object({ active: z.boolean() }), req.body); await run(req, (tx, a) => setPlanActive(tx, a, id, b.active)); reply.status(204); });
  app.post('/service-agreements/:id/activate', async (req) => { const { id } = parse(Id, req.params); return run(req, (tx, a) => activateAgreement(tx, a, id)); });
  app.post('/service-agreements/:id/suspend', async (req, reply) => { const { id } = parse(Id, req.params); const b = parse(z.object({ reason: z.string().min(3).max(1000) }), req.body); await run(req, (tx, a) => suspendAgreement(tx, a, id, b.reason)); reply.status(204); });
  app.post('/service-agreements/:id/end', async (req, reply) => {
    const { id } = parse(Id, req.params); const b = parse(z.object({ outcome: z.enum(['ended', 'cancelled']), reason: z.string().min(3).max(1000) }), req.body);
    await run(req, (tx, a) => endAgreement(tx, a, id, b)); reply.status(204);
  });

  app.get('/service-visits', async (req) => {
    const q = parse(z.object({ status: z.string().optional(), open: qbool.optional(), from: date.optional(), to: date.optional(), technicianId: uuid.optional(), customerId: uuid.optional(), overdue: qbool.optional(), unassigned: qbool.optional() }), req.query);
    return run(req, (tx, a) => listVisits(tx, a, q));
  });
  app.post('/service-visits/generate', async (req) => { const b = parse(z.object({ horizonDays: z.number().int().min(1).max(365).optional() }), req.body ?? {}); return run(req, (tx, a) => generateVisits(tx, a, b)); });
  app.post('/service-visits', async (req, reply) => {
    const b = parse(z.object({ facilityId: uuid, customerId: uuid, siteId: uuid.nullable().optional(), assetId: uuid, agreementId: uuid.nullable().optional(), title: z.string().min(3).max(300), priority: z.number().int().min(1).max(4).optional(),
      dueOn: date.optional(), estimatedMinutes: z.number().int().min(5).max(960).optional(), requiredSkill: z.string().max(60).nullable().optional(), notes: z.string().max(4000).nullable().optional() }), req.body);
    reply.status(201);
    return run(req, (tx, a) => createCallout(tx, a, b));
  });
  app.get('/service-visits/:id', async (req) => { const { id } = parse(Id, req.params); return run(req, (tx, a) => getVisit(tx, a, id)); });
  app.post('/service-visits/:id/cancel', async (req, reply) => { const { id } = parse(Id, req.params); const b = parse(z.object({ reason: z.string().min(3).max(1000) }), req.body); await run(req, (tx, a) => cancelVisit(tx, a, id, b.reason)); reply.status(204); });

  // Dispatch (F2)
  app.get('/service-dispatch/board', async (req) => { const q = parse(z.object({ date }), req.query); return run(req, (tx, a) => board(tx, a, q.date)); });
  app.get('/service-visits/:id/suggestions', async (req) => { const { id } = parse(Id, req.params); const q = parse(z.object({ date: date.optional() }), req.query); return run(req, (tx, a) => suggest(tx, a, id, q.date)); });
  app.post('/service-visits/:id/assign', async (req) => {
    const { id } = parse(Id, req.params);
    const b = parse(z.object({ technicianId: uuid, date, start: z.string().regex(/^\d{2}:\d{2}$/).nullable().optional(), vehicleId: uuid.nullable().optional(), allowOvertime: z.boolean().optional() }), req.body);
    return run(req, (tx, a) => assign(tx, a, id, b));
  });
  app.post('/service-visits/:id/unassign', async (req, reply) => { const { id } = parse(Id, req.params); await run(req, (tx, a) => unassign(tx, a, id)); reply.status(204); });
  app.post('/service-dispatch/dispatch', async (req) => { const b = parse(z.object({ technicianId: uuid, date }), req.body); return run(req, (tx, a) => dispatchDay(tx, a, b)); });
  app.get('/service-my-day', async (req) => { const q = parse(z.object({ date: date.optional() }), req.query); return run(req, (tx, a) => myDay(tx, a, q.date ?? new Date().toISOString().slice(0, 10))); });
  app.post('/service-visits/:id/start', async (req, reply) => { const { id } = parse(Id, req.params); await run(req, (tx, a) => startVisit(tx, a, id)); reply.status(204); });

  // Service report, billing, quotes (F3)
  const repairs = z.array(z.object({ description: z.string().min(3).max(500), qty: z.number().positive().optional(), urgency: z.enum(['now', 'soon', 'when_convenient']).optional(), partId: uuid.nullable().optional(), unitPrice: z.number().nonnegative().nullable().optional() })).max(40);
  const report = z.object({
    arrivedAt: z.string().datetime().nullable().optional(), departedAt: z.string().datetime().nullable().optional(), laborHours: z.number().positive().max(24).nullable().optional(),
    checklistResults: z.array(z.object({ item: z.string().max(300), result: z.enum(['ok', 'issue', 'na']), note: z.string().max(1000).nullable().optional() })).max(80).optional(),
    readings: z.array(z.object({ name: z.string().max(100), value: z.union([z.number(), z.string().max(100)]), unit: z.string().max(20).nullable().optional() })).max(60).optional(),
    workPerformed: z.string().max(8000).nullable().optional(), findings: z.string().max(8000).nullable().optional(),
    partsUsed: z.array(z.object({ partId: uuid, qty: z.number().positive(), locationId: uuid.nullable().optional(), lots: z.array(z.object({ lot: z.string().max(60), qty: z.number().positive() })).nullable().optional() })).max(60).optional(),
    recommendedRepairs: repairs.optional(), customerPresent: z.boolean().optional(), customerSignedName: z.string().max(200).nullable().optional(), signaturePng: z.string().max(400_000).nullable().optional(),
    noSignatureReason: z.string().max(500).nullable().optional(), resolved: z.boolean().nullable().optional(),
  });
  app.get('/service-visits/:id/report', async (req) => { const { id } = parse(Id, req.params); return run(req, (tx, a) => getReport(tx, a, id)); });
  app.put('/service-visits/:id/report', async (req) => { const { id } = parse(Id, req.params); const b = parse(report, req.body); return run(req, (tx, a) => saveReportDraft(tx, a, id, b as any)); });
  app.post('/service-visits/:id/report/submit', async (req) => { const { id } = parse(Id, req.params); const b = parse(report, req.body); return run(req, (tx, a) => submitReport(tx, a, id, b as any)); });
  app.get('/service-visits/:id/report/signature', async (req, reply) => { const { id } = parse(Id, req.params); const png = await run(req, (tx, a) => reportSignature(tx, a, id)); reply.header('content-type', 'image/png'); return png; });
  app.post('/service-visits/:id/quote', async (req, reply) => {
    const { id } = parse(Id, req.params); const b = parse(z.object({ items: z.array(z.object({ index: z.number().int().min(0), unitPrice: z.number().nonnegative().nullable().optional() })).min(1).max(40), validUntil: date.nullable().optional() }), req.body);
    reply.status(201);
    return run(req, (tx, a) => quoteFromReport(tx, a, id, b));
  });
  app.get('/service-billing/ready', async (req) => run(req, (tx, a) => readyToBill(tx, a)));
  app.post('/service-visits/:id/bill', async (req, reply) => { const { id } = parse(Id, req.params); reply.status(201); return run(req, (tx, a) => billVisit(tx, a, id)); });
  app.post('/service-billing/monthly', async (req) => { const b = parse(z.object({ month: z.string().regex(/^\d{4}-\d{2}$/) }), req.body); return run(req, (tx, a) => runMonthlyBilling(tx, a, b.month)); });

  // Trucks and tools (F4)
  app.get('/vehicles/:id/stock', async (req) => { const { id } = parse(Id, req.params); return run(req, (tx, a) => truckStock(tx, a, id)); });
  app.put('/vehicles/:id/stock-levels/:partId', async (req, reply) => {
    const p = parse(z.object({ id: uuid, partId: uuid }), req.params); const b = parse(z.object({ min: z.number().nonnegative(), par: z.number().positive() }), req.body);
    await run(req, (tx, a) => setTruckLevel(tx, a, p.id, p.partId, b)); reply.status(204);
  });
  app.get('/truck-restock', async (req) => run(req, (tx, a) => restockList(tx, a)));
  app.post('/vehicles/:id/restock', async (req, reply) => {
    const { id } = parse(Id, req.params); const b = parse(z.object({ fromLocationId: uuid, lines: z.array(z.object({ partId: uuid, qty: z.number().positive() })).min(1).max(100) }), req.body);
    reply.status(201);
    return run(req, (tx, a) => restockTruck(tx, a, id, b));
  });
  app.get('/service-tools', async (req) => run(req, (tx, a) => listTools(tx, a)));
  app.get('/tool-checkouts', async (req) => { const q = parse(z.object({ open: qbool.optional() }), req.query); return run(req, (tx, a) => listToolCheckouts(tx, a, q)); });
  app.post('/service-tools/:id/checkout', async (req, reply) => {
    const { id } = parse(Id, req.params); const b = parse(z.object({ employeeId: uuid.nullable().optional(), vehicleId: uuid.nullable().optional(), note: z.string().max(500).nullable().optional() }), req.body ?? {});
    reply.status(201);
    return run(req, (tx, a) => checkoutTool(tx, a, id, b));
  });
  app.post('/service-tools/:id/return', async (req, reply) => { const { id } = parse(Id, req.params); const b = parse(z.object({ note: z.string().max(500).nullable().optional() }), req.body ?? {}); await run(req, (tx, a) => returnTool(tx, a, id, b.note)); reply.status(204); });
}
