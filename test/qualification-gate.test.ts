import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { asActor } from '../src/platform/auth/actor.js';
import type { Actor } from '../src/platform/auth/actor.js';
import { closePools, getAdminPool } from '../src/platform/db/pool.js';
import { allowedInLite } from '../src/platform/edition.js';
import { createAsset, getAsset, recordState } from '../src/modules/assets/service.js';
import { setFeature } from '../src/modules/features/service.js';
import { whatIsLate } from '../src/modules/late/service.js';
import { addLabor, createWorkOrder, transitionWorkOrder } from '../src/modules/maintenance/service.js';
import { createChange, requestStartup } from '../src/modules/moc/service.js';
import { runReminders } from '../src/modules/notifications/reminders.js';
import { declareQualified, getAssetQualification, getProtocol, listQualification, setRequalifyAfterWork, switchOn } from '../src/modules/qualification/service.js';
import type { World } from './fixtures.js';
import { makeWorld } from './fixtures.js';
import { addUser, approve, runProtocol } from './qualification-helpers.js';

const db = () => getAdminPool();
let w: World; let qm: Actor; let app: FastifyInstance;
let A: string;
const q = (assetId: string) => asActor(w.managerA, (tx) => getAssetQualification(tx, w.managerA, assetId));
const state = (assetId: string, s: string, who: Actor = w.techA) => asActor(who, (tx) => recordState(tx, who, assetId, { state: s as never, note: 'test' }));
const newTool = async (tag: string, o: { qualified?: boolean; control?: boolean; parent?: string; requalify?: boolean } = {}) => {
  const id = (await asActor(w.admin, (tx) => createAsset(tx, w.admin, { facilityId: A, assetTag: tag, name: `Tool ${tag}`, parentAssetId: o.parent }))).id as string;
  if (o.control !== false) {
    await asActor(w.managerA, (tx) => switchOn(tx, w.managerA, id, { requalifyAfterWork: o.requalify }));
    if (o.qualified !== false) await asActor(w.managerA, (tx) => declareQualified(tx, w.managerA, id, { qualifiedOn: '2026-01-15', basis: 'PQ-2026-01 on file with the vendor FAT report' }));
  }
  return id;
};
/** Repair order for a tool: opened, worked and completed by a technician (the tool is down while it is repaired). */
async function repair(assetId: string, title = 'Replace RF match network') {
  const wo = await asActor(w.managerA, (tx) => createWorkOrder(tx, w.managerA, { assetId, title }));
  await asActor(w.techA, async (tx) => {
    await transitionWorkOrder(tx, w.techA, wo.id, { to: 'in_progress' });
    await addLabor(tx, w.techA, wo.id, { workDate: '2026-10-20', hours: 2, hourlyRate: 40 });
    await transitionWorkOrder(tx, w.techA, wo.id, { to: 'completed', remedy: title });
  });
  return wo as { id: string; number: string };
}

beforeAll(async () => {
  app = buildApp();
  w = await makeWorld('qg'); A = w.facilities.A!;
  qm = await addUser(w, 'qm', [{ role: 'quality_manager', facility: A }]);
});
afterAll(async () => { await app.close(); await closePools(); });

describe('requalification after work on a qualified tool', () => {
  let tool: string; let wo: { id: string; number: string };
  it('completing a work order marks the tool “requalification required” and tells the qualification managers', async () => {
    tool = await newTool('ETCH-1');
    expect(await q(tool)).toMatchObject({ state: 'qualified' });
    await state(tool, 'unplanned_downtime');
    wo = await repair(tool);
    const s = await q(tool);
    expect(s).toMatchObject({ state: 'requalification_required', requiredRefType: 'work_order', requiredReason: expect.stringContaining(wo.number) });
    expect(s.events.map((e: any) => e.kind)).toContain('requal_required');
    const note = await db().query(`SELECT count(*)::int AS n FROM notification WHERE tenant_id = $1 AND kind = 'qualification.required'`, [w.tenantId]);
    expect(note.rows[0].n).toBeGreaterThan(0);
  });

  it('verification cannot return the tool to service, with a clear message; verifying with the return switched off works', async () => {
    await expect(asActor(w.managerA, (tx) => transitionWorkOrder(tx, w.managerA, wo.id, { to: 'verified' }))).rejects.toThrow(/ETCH-1 cannot return to service: requalification has been required since .*switch "return to service" off/);
    // Nothing of the failed attempt was kept.
    expect((await asActor(w.managerA, (tx) => getAsset(tx, w.managerA, tool))).operational_state).toBe('unplanned_downtime');
    const v = await asActor(w.managerA, (tx) => transitionWorkOrder(tx, w.managerA, wo.id, { to: 'verified', returnToService: false }));
    expect(v.status).toBe('verified');
    expect((await asActor(w.managerA, (tx) => getAsset(tx, w.managerA, tool))).operational_state).toBe('unplanned_downtime');
    // Verifying did not mark it again: the same work order counts once.
    expect((await q(tool)).events.filter((e: any) => e.kind === 'requal_required')).toHaveLength(1);
  });

  it('a state change back to available or running is refused, as is idle; going the other way is not', async () => {
    for (const s of ['available', 'running', 'idle']) await expect(state(tool, s)).rejects.toThrow(/cannot return to service/);
    await state(tool, 'out_of_service'); // down to down is fine
    await state(tool, 'planned_downtime');
    await expect(state(tool, 'available')).rejects.toMatchObject({ code: 'requalification_required', status: 422 });
  });

  it('an IQ, or a protocol executed before requalification became required, does not clear it', async () => {
    const iq = await runProtocol(w, w.managerA, tool, { type: 'IQ', title: 'IQ after the repair' });
    await approve(qm, iq.id);
    expect((await q(tool)).state).toBe('requalification_required');
    expect((await q(tool)).events.map((e: any) => e.summary).join('\n')).toMatch(/an IQ does not stand in for a requalification/);
    await expect(state(tool, 'available')).rejects.toThrow(/cannot return to service/);

    // An OQ executed now, then work is done on the tool again before it is approved: approval does not clear the newer requirement.
    const early = await runProtocol(w, w.managerA, tool, { type: 'OQ', title: 'OQ executed before the next repair' });
    await state(tool, 'unplanned_downtime');
    await db().query(`UPDATE asset_qualification SET required_since = now() + interval '1 minute' WHERE asset_id = $1`, [tool]);
    await approve(qm, early.id);
    expect((await q(tool)).state).toBe('requalification_required');
    expect((await q(tool)).events.map((e: any) => e.summary).join('\n')).toMatch(/executed before requalification became required/);
    await db().query(`UPDATE asset_qualification SET required_since = now() - interval '1 minute' WHERE asset_id = $1`, [tool]);
  });

  it('a failed protocol does not clear it either', async () => {
    const bad = await runProtocol(w, w.managerA, tool, { type: 'OQ', fail: true, title: 'OQ with a failing leak-up' });
    await approve(qm, bad.id);
    expect((await asActor(w.managerA, (tx) => getProtocol(tx, w.managerA, bad.id))).status).toBe('failed');
    await expect(state(tool, 'available')).rejects.toThrow(/cannot return to service/);
  });

  it('an approved passing OQ executed after the date clears it, and the tool can return to service', async () => {
    const ok = await runProtocol(w, w.managerA, tool, { type: 'OQ', title: 'OQ after the RF match replacement' });
    await expect(state(tool, 'available')).rejects.toThrow(/cannot return to service/); // not approved yet
    await approve(qm, ok.id);
    const s = await q(tool);
    expect(s).toMatchObject({ state: 'qualified', requiredSince: null });
    expect(s.events.map((e: any) => e.kind)).toContain('requal_cleared');
    await state(tool, 'available');
    expect((await asActor(w.managerA, (tx) => getAsset(tx, w.managerA, tool))).operational_state).toBe('available');
  });

  it('a second repair requires requalification again', async () => {
    await state(tool, 'unplanned_downtime');
    await repair(tool, 'Replace the turbo pump');
    expect((await q(tool)).state).toBe('requalification_required');
    expect((await q(tool)).events.filter((e: any) => e.kind === 'requal_required')).toHaveLength(2);
  });
});

describe('when the gate does not apply', () => {
  it('a tool that is not under qualification control, or has requalify-after-work switched off, is never gated', async () => {
    const free = await newTool('LATHE-1', { control: false });
    await state(free, 'unplanned_downtime');
    await repair(free);
    await state(free, 'available');
    expect((await asActor(w.managerA, (tx) => getAsset(tx, w.managerA, free))).operational_state).toBe('available');

    const quiet = await newTool('MILL-1', { requalify: false });
    await state(quiet, 'unplanned_downtime');
    const wo = await repair(quiet);
    expect((await q(quiet)).state).toBe('qualified');
    await asActor(w.managerA, (tx) => transitionWorkOrder(tx, w.managerA, wo.id, { to: 'verified' }));
    expect((await asActor(w.managerA, (tx) => getAsset(tx, w.managerA, quiet))).operational_state).toBe('available');
    // Switching the setting on makes the next repair count.
    await asActor(w.managerA, (tx) => setRequalifyAfterWork(tx, w.managerA, quiet, true));
    await repair(quiet, 'Second repair');
    expect((await q(quiet)).state).toBe('requalification_required');
  });

  it('a verified work order on a tool that is running leaves it running (no return happens, so no gate)', async () => {
    const t = await newTool('POLISH-1');
    const wo = await repair(t);
    expect((await q(t)).state).toBe('requalification_required');
    await asActor(w.managerA, (tx) => transitionWorkOrder(tx, w.managerA, wo.id, { to: 'verified' }));
    expect((await asActor(w.managerA, (tx) => getAsset(tx, w.managerA, t))).operational_state).toBe('available');
  });

  it('a tool under control that was never qualified cannot come out of downtime until it is', async () => {
    const t = await newTool('NEW-1', { qualified: false });
    await state(t, 'out_of_service');
    await expect(state(t, 'available')).rejects.toThrow(/NEW-1 cannot return to service: it is under qualification control but has no approved PQ/);
    const pq = await runProtocol(w, w.managerA, t, { type: 'PQ', title: 'PQ of the new tool' });
    await approve(qm, pq.id);
    await state(t, 'available');
    expect((await q(t)).state).toBe('qualified');
  });

  it('is not enforced while the feature is turned off for everyone (nobody could clear it), and is again when it is back on', async () => {
    const t = await newTool('OFF-1', { qualified: false });
    await state(t, 'out_of_service');
    await expect(state(t, 'available')).rejects.toThrow(/cannot return to service/);
    await asActor(w.admin, (tx) => setFeature(tx, w.admin, 'qualification', { mode: 'off', roleKeys: [] }));
    const wo = await repair(t); // completing work marks nothing while the feature is off
    await state(t, 'available', w.admin);
    expect((await asActor(w.admin, (tx) => getAsset(tx, w.admin, t))).operational_state).toBe('available');
    await asActor(w.admin, (tx) => setFeature(tx, w.admin, 'qualification', { mode: 'all', roleKeys: [] }));
    await state(t, 'out_of_service');
    await expect(state(t, 'available')).rejects.toThrow(/cannot return to service/);
    expect(wo.id).toBeTruthy();
  });

  it('imported history is not a return to service', async () => {
    const t = await newTool('NEW-2', { qualified: false });
    await state(t, 'out_of_service');
    await asActor(w.managerA, (tx) => recordState(tx, w.managerA, t, { state: 'running', source: 'import', at: new Date() }));
  });
});

describe('a change put in service, and components', () => {
  it('requires requalification of the tools it affects, once, when it goes into service', async () => {
    const t = await newTool('IMPL-1');
    const c = await asActor(w.managerA, (tx) => createChange(tx, w.managerA, {
      facilityId: A, title: 'Replace the RF generator with a 3 kW unit', changeType: 'equipment', description: 'Fit the new generator and recalibrate the match.', justification: 'The old unit is obsolete.',
      consequences: 'Process drift until retuned', qmsImpact: 'Recipe update', resources: 'Vendor engineer', responsibilities: 'Maintenance', affected: [{ entityType: 'asset', entityId: t }],
    }));
    expect((await q(t)).state).toBe('qualified');
    await db().query(`UPDATE moc_change SET status = 'approved', pssr_required = false WHERE id = $1`, [c.id]);
    await asActor(w.managerA, (tx) => requestStartup(tx, w.managerA, c.id));
    const s = await q(t);
    expect(s).toMatchObject({ state: 'requalification_required', requiredRefType: 'moc_change', requiredReason: expect.stringContaining(c.number) });
  });

  it('work on a component of a qualified tool requires requalification of the tool', async () => {
    const parent = await newTool('CLUSTER-1');
    const comp = await newTool('CLUSTER-1-PUMP', { control: false, parent });
    await repair(comp, 'Rebuild the pump');
    expect(await q(parent)).toMatchObject({ state: 'requalification_required', requiredReason: expect.stringMatching(/on a component/) });
  });
});

describe('due dates, What is late and the reminder', () => {
  it('a passed requalification date shows on What is late and in the weekly reminder, once', async () => {
    const t = await newTool('DUE-1');
    await db().query(`UPDATE asset_qualification SET requal_due_on = current_date - 5 WHERE asset_id = $1`, [t]);
    const s = await q(t);
    expect(s).toMatchObject({ state: 'requalification_due', overdue: true, dueInDays: -5 });
    const late = await asActor(w.managerA, (tx) => whatIsLate(tx, w.managerA));
    const sec = late.sections.find((x) => x.key === 'requalification')!;
    expect(sec.rows.map((r) => r.label)).toEqual([expect.stringContaining('DUE-1')]);
    expect(sec.rows[0]).toMatchObject({ daysLate: 5, href: `/qualification/assets/${t}` });
    expect((await asActor(w.techA, (tx) => whatIsLate(tx, w.techA))).sections.find((x) => x.key === 'requalification')).toBeDefined(); // technicians hold qualification.view
    expect((await asActor(w.operatorB, (tx) => whatIsLate(tx, w.operatorB))).sections.find((x) => x.key === 'requalification')).toBeUndefined();
    const today = new Date().toISOString().slice(0, 10);
    const first = await runReminders(w.tenantId, today);
    expect(first.qualification_due).toBeGreaterThan(0);
    const mine = await db().query(`SELECT title FROM notification WHERE tenant_id = $1 AND kind = 'reminder.qualification_due'`, [w.tenantId]);
    expect(mine.rows[0].title).toMatch(/A: 1 tool due for requalification, 1 overdue/);
    expect((await runReminders(w.tenantId, today)).qualification_due ?? 0).toBe(0);
  });

  it('a date further than the warning period away leaves the tool “qualified”', async () => {
    const t = await newTool('DUE-2');
    await db().query(`UPDATE asset_qualification SET requal_due_on = current_date + 90 WHERE asset_id = $1`, [t]);
    expect(await q(t)).toMatchObject({ state: 'qualified', dueInDays: 90 });
    await db().query(`UPDATE asset_qualification SET requal_due_on = current_date + 10 WHERE asset_id = $1`, [t]);
    expect(await q(t)).toMatchObject({ state: 'requalification_due', overdue: false });
    const list = await asActor(w.managerA, (tx) => listQualification(tx, w.managerA, { state: 'requalification_due' }));
    expect(list.map((r) => r.asset_tag)).toContain('DUE-2');
  });
});

describe('the interface to the platform', () => {
  const h = (who: string) => ({ authorization: `Bearer ${w.tokens[who]}` });
  it('serves the API under /api/qualification and refuses it in the Lite edition', async () => {
    const ok = await app.inject({ method: 'GET', url: '/api/qualification', headers: h('managerA') });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().counts.underControl).toBeGreaterThan(0);
    expect(allowedInLite('/api/qualification/assets/x')).toBe(false);
    expect(allowedInLite('/api/reports/tool-states')).toBe(false);
  });

  it('the gate answers an API state change with the clear message', async () => {
    const t = await newTool('API-1');
    await state(t, 'out_of_service');
    await db().query(`UPDATE asset_qualification SET status = 'requalification_required', required_since = now() - interval '1 hour', required_reason = 'a test' WHERE asset_id = $1`, [t]);
    const r = await app.inject({ method: 'POST', url: `/api/assets/${t}/state`, headers: h('techA'), payload: { state: 'running' } });
    expect(r.statusCode).toBe(422);
    expect(r.json().error).toMatchObject({ code: 'requalification_required', message: expect.stringContaining('API-1 cannot return to service') });
  });
});
