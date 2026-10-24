import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { asActor } from '../src/platform/auth/actor.js';
import type { Actor } from '../src/platform/auth/actor.js';
import { closePools, getAdminPool } from '../src/platform/db/pool.js';
import { LocalBlobStore } from '../src/platform/storage/blob-store.js';
import { createAsset } from '../src/modules/assets/service.js';
import { addVersion, approveVersion, createDocument } from '../src/modules/documents/service.js';
import { addAttachment, listAttachments } from '../src/modules/quality/attachments.js';
import {
  addStep, cancelProtocol, createProtocol, declareQualified, executeProtocol, getAssetQualification, getProtocol, getSettings, linkProtocolDocument, listProtocols, listQualification, recordResult,
  removeStep, saveSettings, switchOff, switchOn, updateProtocol,
} from '../src/modules/qualification/service.js';
import type { World } from './fixtures.js';
import { makeWorld } from './fixtures.js';
import { addUser, approve, reject, runProtocol, waitingFor } from './qualification-helpers.js';

const blobs = new LocalBlobStore('./.storage/test');
const db = () => getAdminPool();
let w: World; let other: World;
let A: string; let B: string;
let tool: string; let qm: Actor; let qm2: Actor; let execQm: Actor; let techQm: Actor;

beforeAll(async () => {
  w = await makeWorld('qp'); other = await makeWorld('qpo');
  A = w.facilities.A!; B = w.facilities.B!;
  tool = (await asActor(w.admin, (tx) => createAsset(tx, w.admin, { facilityId: A, assetTag: 'ETCH-1', name: 'Plasma etch chamber', criticality: 'high' }))).id;
  qm = await addUser(w, 'qm', [{ role: 'quality_manager', facility: A }]);
  qm2 = await addUser(w, 'qm2', [{ role: 'quality_manager', facility: A }]);
  // A person who both runs protocols and holds the approving role (for separation of duties checks).
  execQm = await addUser(w, 'execqm', [{ role: 'maintenance_manager', facility: A }, { role: 'quality_manager', facility: A }]);
  techQm = await addUser(w, 'techqm', [{ role: 'technician', facility: A }, { role: 'quality_manager', facility: A }]);
});
afterAll(closePools);

describe('putting a tool under qualification control', () => {
  it('needs qualification.manage at the tool’s site, and a protocol needs the tool to be under control', async () => {
    await expect(asActor(w.techA, (tx) => switchOn(tx, w.techA, tool))).rejects.toThrow(/qualification.manage/);
    await expect(asActor(w.operatorB, (tx) => switchOn(tx, w.operatorB, tool))).rejects.toThrow(/not found|qualification.manage/);
    await expect(asActor(w.managerA, (tx) => createProtocol(tx, w.managerA, { assetId: tool, protocolType: 'OQ', title: 'OQ of the etch chamber' }))).rejects.toThrow(/under qualification control first/);
    const s = await asActor(w.managerA, (tx) => switchOn(tx, w.managerA, tool));
    expect(s).toMatchObject({ enabled: true, state: 'not_qualified', requalifyAfterWork: true });
    await expect(asActor(w.managerA, (tx) => switchOn(tx, w.managerA, tool))).rejects.toThrow(/already under/);
  });

  it('defaults the requalification interval per protocol type and lets a company change it', async () => {
    expect((await asActor(w.managerA, (tx) => getSettings(tx, w.managerA))).intervals).toEqual({ IQ: null, OQ: 12, PQ: 12, requalification: 12 });
    await expect(asActor(w.techA, (tx) => saveSettings(tx, w.techA, { intervals: { OQ: 6 } }))).rejects.toThrow(/qualification.manage/);
    await expect(asActor(w.managerA, (tx) => saveSettings(tx, w.managerA, { intervals: { OQ: 0 } }))).rejects.toThrow(/1 to 120/);
    const s = await asActor(w.managerA, (tx) => saveSettings(tx, w.managerA, { intervals: { requalification: 6 } }));
    expect(s.intervals).toEqual({ IQ: null, OQ: 12, PQ: 12, requalification: 6 });
    await asActor(w.managerA, (tx) => saveSettings(tx, w.managerA, { intervals: { requalification: 12 } }));
  });
});

describe('a protocol from draft to approved', () => {
  let p: any;
  it('is written with steps and linked documents, and results are recorded by the people who ran it', async () => {
    p = await asActor(w.managerA, (tx) => createProtocol(tx, w.managerA, { assetId: tool, protocolType: 'IQ', title: 'Installation qualification of ETCH-1', acceptanceCriteria: 'Utilities, vacuum and interlocks verified.',
      steps: [{ step: 'Verify utilities connected', expected: 'Per P&ID rev C' }] }));
    expect(p).toMatchObject({ number: expect.stringMatching(/^QP-\d{4}$/), status: 'draft', interval_months: null, protocol_type: 'IQ' });
    await asActor(w.techA, (tx) => addStep(tx, w.techA, p.id, { step: 'Check interlocks trip the RF generator', expected: 'Trips within 100 ms' }));
    const full = await asActor(w.techA, (tx) => getProtocol(tx, w.techA, p.id));
    expect(full.steps.map((s: any) => s.step)).toEqual(['Verify utilities connected', 'Check interlocks trip the RF generator']);
    await expect(asActor(w.techA, (tx) => updateProtocol(tx, w.techA, p.id, { title: 'Changed by a technician' }))).rejects.toThrow(/qualification.manage/);
    await expect(asActor(w.techA, (tx) => removeStep(tx, w.techA, full.steps[1].id))).rejects.toThrow(/qualification.manage/);
  });

  it('cannot be executed with a step still to do, or with no conclusion', async () => {
    await expect(asActor(w.managerA, (tx) => executeProtocol(tx, w.managerA, p.id, 'Done'))).rejects.toThrow(/2 steps have no result/);
    const steps = (await asActor(w.techA, (tx) => getProtocol(tx, w.techA, p.id))).steps;
    await expect(asActor(w.techA, (tx) => recordResult(tx, w.techA, steps[0].id, { outcome: 'pass' }))).rejects.toThrow(/what was found/);
    await asActor(w.techA, async (tx) => {
      await recordResult(tx, w.techA, steps[0].id, { actual: 'Matches P&ID rev C', outcome: 'pass' });
      await recordResult(tx, w.techA, steps[1].id, { actual: 'Tripped at 62 ms', outcome: 'pass' });
    });
    await expect(asActor(w.managerA, (tx) => executeProtocol(tx, w.managerA, p.id, ''))).rejects.toThrow(/conclusion/);
    await expect(asActor(w.operatorB, (tx) => executeProtocol(tx, w.operatorB, p.id, 'Nothing'))).rejects.toThrow(/not found|qualification.execute/);
  });

  it('takes evidence files on the protocol and on a result entry, and keeps the record of who recorded each result', async () => {
    const steps = (await asActor(w.techA, (tx) => getProtocol(tx, w.techA, p.id))).steps;
    expect(steps.map((s: any) => s.recorded_by_name)).toEqual(['techA', 'techA']);
    const f = await asActor(w.techA, (tx) => addAttachment(tx, w.techA, blobs, { subjectType: 'qualification_result', subjectId: steps[1].id, fileName: 'trip-trace.txt', mime: 'text/plain', content: Buffer.from('scope capture') }));
    expect(f.file_name).toBe('trip-trace.txt');
    expect((await asActor(w.managerA, (tx) => listAttachments(tx, w.managerA, 'qualification_result', steps[1].id))).map((x) => x.file_name)).toEqual(['trip-trace.txt']);
    await expect(asActor(w.operatorB, (tx) => listAttachments(tx, w.operatorB, 'qualification_result', steps[1].id))).rejects.toThrow(/not found|qualification.view/);
    await expect(asActor(w.exec, (tx) => addAttachment(tx, w.exec, blobs, { subjectType: 'qualification_protocol', subjectId: p.id, fileName: 'x.txt', mime: 'text/plain', content: Buffer.from('x') }))).rejects.toThrow(/qualification.execute/);
  });

  it('goes to the approver on execution; the executor cannot approve even holding the approving role', async () => {
    await expect(asActor(execQm, (tx) => executeProtocol(tx, execQm, p.id, 'x'))).rejects.toThrow(/conclusion|characters/);
    const exec = await asActor(execQm, (tx) => executeProtocol(tx, execQm, p.id, 'Installation verified against the drawings.'));
    expect(exec).toMatchObject({ status: 'executed', overall: 'pass' });
    expect(exec.executed_by_name).toBe('execqm');
    // The requester (executor) is never offered the step and cannot decide it.
    expect(await waitingFor(execQm, p.id)).toBeUndefined();
    const stepId = (await db().query(`SELECT s.id FROM approval_step s JOIN approval_request r ON r.id = s.request_id WHERE r.subject_id = $1`, [p.id])).rows[0].id;
    const { decideApproval } = await import('../src/modules/approvals/service.js');
    await expect(asActor(execQm, (tx) => decideApproval(tx, execQm, stepId, { decision: 'approve', comment: 'Looks good to me.' }))).rejects.toThrow(/cannot approve a request you raised/);
    // A step of a protocol already executed can no longer change.
    await expect(asActor(w.techA, (tx) => recordResult(tx, w.techA, exec.steps[0].id, { actual: 'edited', outcome: 'pass' }))).rejects.toThrow(/only a draft/);
    await expect(asActor(w.managerA, (tx) => cancelProtocol(tx, w.managerA, p.id, 'no longer needed'))).rejects.toThrow(/only a draft/);
  });

  it('cannot be approved by someone who recorded a result, but can by an independent approver (with a comment)', async () => {
    // techQm holds the approving role and also recorded a result on this protocol: set one up for them.
    const q = await asActor(w.managerA, (tx) => createProtocol(tx, w.managerA, { assetId: tool, protocolType: 'OQ', title: 'OQ with a shared tester', steps: [{ step: 'Leak-up test', expected: '< 5 mTorr/min' }] }));
    const st = (await asActor(w.managerA, (tx) => getProtocol(tx, w.managerA, q.id))).steps[0];
    await asActor(techQm, (tx) => recordResult(tx, techQm, st.id, { actual: '3 mTorr/min', outcome: 'pass' }));
    await asActor(w.managerA, (tx) => executeProtocol(tx, w.managerA, q.id, 'Meets the criteria.'));
    await expect(approve(techQm, q.id)).rejects.toThrow(/must differ from the people who executed/);
    await expect(asActor(qm, async (tx) => (await import('../src/modules/approvals/service.js')).decideApproval(tx, qm, (await waitingFor(qm, q.id))!.step_id, { decision: 'approve', comment: null }))).rejects.toThrow(/comment/);
    await approve(qm, q.id);
    const done = await asActor(w.managerA, (tx) => getProtocol(tx, w.managerA, q.id));
    expect(done).toMatchObject({ status: 'approved', overall: 'pass' });
    // The tool is not qualified yet: an OQ is a stage on the way, a PQ or requalification qualifies it.
    expect((await asActor(w.managerA, (tx) => getAssetQualification(tx, w.managerA, tool))).state).toBe('not_qualified');
  });

  it('a named approver who took part is refused at execution; the IQ is approved by the named approver', async () => {
    const r = await asActor(w.managerA, (tx) => createProtocol(tx, w.managerA, { assetId: tool, protocolType: 'OQ', title: 'OQ with a named approver', approverUserId: w.techA.userId, steps: [{ step: 'Run', expected: 'Ok' }] }));
    const st = (await asActor(w.managerA, (tx) => getProtocol(tx, w.managerA, r.id))).steps[0];
    await asActor(w.techA, (tx) => recordResult(tx, w.techA, st.id, { actual: 'Ok', outcome: 'pass' }));
    await expect(asActor(w.managerA, (tx) => executeProtocol(tx, w.managerA, r.id, 'All good here.'))).rejects.toThrow(/named approver took part/);
    await asActor(w.managerA, (tx) => updateProtocol(tx, w.managerA, r.id, { approverUserId: qm2.userId }));
    await asActor(w.managerA, (tx) => executeProtocol(tx, w.managerA, r.id, 'All good here.'));
    expect(await waitingFor(qm, r.id)).toBeUndefined(); // addressed to qm2 only
    await approve(qm2, r.id);
    // The IQ from before is still waiting for a quality manager.
    await approve(qm, p.id);
    expect((await asActor(w.managerA, (tx) => getProtocol(tx, w.managerA, p.id))).status).toBe('approved');
  });

  it('a rejected protocol returns to draft with the reason in the history and can be executed again', async () => {
    const q = await runProtocol(w, w.managerA, tool, { title: 'OQ rejected first time' });
    await reject(qm, q.id, 'Attach the raw leak-up trace before I can approve.');
    const back = await asActor(w.managerA, (tx) => getProtocol(tx, w.managerA, q.id));
    expect(back).toMatchObject({ status: 'draft', overall: null, executed_at: null });
    const events = (await asActor(w.managerA, (tx) => getAssetQualification(tx, w.managerA, tool))).events.map((e: any) => e.summary);
    expect(events.some((s: string) => /returned to draft by the approver: Attach the raw leak-up trace/.test(s))).toBe(true);
    await asActor(w.managerA, (tx) => executeProtocol(tx, w.managerA, q.id, 'Trace attached; criteria met.'));
    await approve(qm, q.id);
    expect((await asActor(w.managerA, (tx) => getProtocol(tx, w.managerA, q.id))).status).toBe('approved');
  });
});

describe('qualifying a tool', () => {
  it('a PQ approved with a pass qualifies the tool and sets the requalification date from the interval', async () => {
    const q = await runProtocol(w, w.managerA, tool, { type: 'PQ', title: 'PQ: 25-wafer run', intervalMonths: 12 });
    await approve(qm, q.id);
    const s = await asActor(w.managerA, (tx) => getAssetQualification(tx, w.managerA, tool));
    expect(s).toMatchObject({ state: 'qualified', status: 'qualified' });
    const due = new Date(); due.setUTCFullYear(due.getUTCFullYear() + 1);
    expect(Math.abs(Date.parse(s.requalDueOn!) - due.getTime())).toBeLessThan(2 * 86_400_000);
    expect((await asActor(w.managerA, (tx) => getProtocol(tx, w.managerA, q.id))).requal_due_on).toBe(s.requalDueOn);
  });

  it('a protocol that failed leaves a qualified tool needing requalification', async () => {
    const q = await runProtocol(w, w.managerA, tool, { type: 'requalification', fail: true, title: 'Periodic requalification (failed leak-up)' });
    expect(q.overall).toBe('fail');
    await approve(qm, q.id);
    expect((await asActor(w.managerA, (tx) => getProtocol(tx, w.managerA, q.id))).status).toBe('failed');
    const s = await asActor(w.managerA, (tx) => getAssetQualification(tx, w.managerA, tool));
    expect(s).toMatchObject({ state: 'requalification_required', requiredReason: expect.stringMatching(/failed/) });
  });

  it('a declaration records existing qualification only for a tool never qualified here, with its basis', async () => {
    const t2 = (await asActor(w.admin, (tx) => createAsset(tx, w.admin, { facilityId: A, assetTag: 'DEP-2', name: 'Deposition tool' }))).id;
    await asActor(w.managerA, (tx) => switchOn(tx, w.managerA, t2, { requalifyAfterWork: false }));
    await expect(asActor(w.managerA, (tx) => declareQualified(tx, w.managerA, t2, { qualifiedOn: '2025-01-10', basis: 'old' }))).rejects.toThrow(/basis/);
    await expect(asActor(w.managerA, (tx) => declareQualified(tx, w.managerA, t2, { qualifiedOn: '2999-01-10', basis: 'Report QR-2024-17 from the vendor FAT' }))).rejects.toThrow(/future/);
    const s = await asActor(w.managerA, (tx) => declareQualified(tx, w.managerA, t2, { qualifiedOn: '2025-01-10', basis: 'Vendor report QR-2024-17 and our PQ of January 2025', requalDueOn: '2999-01-10' }));
    expect(s).toMatchObject({ state: 'qualified', requalifyAfterWork: false });
    await expect(asActor(w.managerA, (tx) => declareQualified(tx, w.managerA, t2, { qualifiedOn: '2025-01-10', basis: 'Vendor report QR-2024-17 again' }))).rejects.toThrow(/already qualified/);
    // A declaration cannot clear a tool that needs requalification.
    await expect(asActor(w.managerA, (tx) => declareQualified(tx, w.managerA, tool, { qualifiedOn: '2025-01-10', basis: 'Trust me, it is fine now' }))).rejects.toThrow(/only by an approved protocol/);
    await asActor(w.managerA, (tx) => switchOff(tx, w.managerA, t2, 'Moved to the research lab, out of scope'));
    expect((await asActor(w.managerA, (tx) => listQualification(tx, w.managerA))).map((r) => r.asset_tag)).toEqual(['ETCH-1']);
  });
});

describe('controlled documents and a protocol', () => {
  it('links an approved document, pinned to the version in force, and flags a later revision', async () => {
    const doc = await asActor(w.managerA, async (tx) => {
      const d = await createDocument(tx, w.managerA, { facilityId: A, docNumber: 'SOP-OQ-9', title: 'Etch chamber OQ procedure', docType: 'sop' });
      return { d, v: await addVersion(tx, w.managerA, blobs, d.id, { versionLabel: 'Rev A', fileName: 'oq.txt', mimeType: 'text/plain', content: Buffer.from('procedure'), extractedText: 'procedure' }) };
    });
    const p = await asActor(w.managerA, (tx) => createProtocol(tx, w.managerA, { assetId: tool, protocolType: 'OQ', title: 'OQ following SOP-OQ-9', steps: [{ step: 'As per SOP', expected: 'Per SOP' }] }));
    await expect(asActor(w.managerA, (tx) => linkProtocolDocument(tx, w.managerA, p.id, doc.d.id))).rejects.toThrow(/no approved version/);
    await asActor(w.admin, (tx) => approveVersion(tx, w.admin, doc.v.id));
    await asActor(w.managerA, (tx) => linkProtocolDocument(tx, w.managerA, p.id, doc.d.id, 'procedure'));
    let full = await asActor(w.managerA, (tx) => getProtocol(tx, w.managerA, p.id));
    expect(full.documents).toEqual([expect.objectContaining({ doc_number: 'SOP-OQ-9', pinned_label: 'Rev A', revised_since: false, link_role: 'procedure' })]);
    const v2 = await asActor(w.managerA, (tx) => addVersion(tx, w.managerA, blobs, doc.d.id, { versionLabel: 'Rev B', fileName: 'oq.txt', mimeType: 'text/plain', content: Buffer.from('procedure b'), changeSummary: 'Torque values changed after review', extractedText: 'b' }));
    await asActor(w.admin, (tx) => approveVersion(tx, w.admin, v2.id));
    full = await asActor(w.managerA, (tx) => getProtocol(tx, w.managerA, p.id));
    expect(full.documents[0]).toMatchObject({ pinned_label: 'Rev A', current_label: 'Rev B', revised_since: true });
    await asActor(w.managerA, (tx) => cancelProtocol(tx, w.managerA, p.id, 'superseded by a new plan'));
    expect((await asActor(w.managerA, (tx) => listProtocols(tx, w.managerA, { assetId: tool }))).some((x) => x.id === p.id)).toBe(false);
  });
});

describe('permissions and isolation', () => {
  it('a site-B user sees nothing of a site-A tool, and another company sees nothing at all', async () => {
    const siteB = await addUser(w, 'qB', [{ role: 'maintenance_manager', facility: B }]);
    expect(await asActor(siteB, (tx) => listQualification(tx, siteB))).toEqual([]);
    expect(await asActor(siteB, (tx) => listProtocols(tx, siteB))).toEqual([]);
    await expect(asActor(siteB, (tx) => getAssetQualification(tx, siteB, tool))).rejects.toThrow(/not found/);
    const [p] = await asActor(w.managerA, (tx) => listProtocols(tx, w.managerA, { assetId: tool }));
    await expect(asActor(siteB, (tx) => getProtocol(tx, siteB, p!.id))).rejects.toThrow(/not found/);
    expect(await asActor(other.managerA, (tx) => listQualification(tx, other.managerA))).toEqual([]);
    expect(await asActor(other.managerA, (tx) => listProtocols(tx, other.managerA))).toEqual([]);
    await expect(asActor(other.managerA, (tx) => getAssetQualification(tx, other.managerA, tool))).rejects.toThrow(/not found/);
    const rows = (await db().query('SELECT count(*)::int AS n FROM qualification_protocol WHERE tenant_id = $1', [other.tenantId])).rows[0].n;
    expect(rows).toBe(0);
  });

  it('a corporate reader (executive) can read but not write; viewers cannot execute', async () => {
    expect((await asActor(w.exec, (tx) => listQualification(tx, w.exec))).map((r) => r.asset_tag)).toEqual(['ETCH-1']);
    await expect(asActor(w.exec, (tx) => createProtocol(tx, w.exec, { assetId: tool, protocolType: 'OQ', title: 'Not allowed for readers' }))).rejects.toThrow(/qualification.manage/);
    await expect(asActor(w.qualityA, (tx) => switchOn(tx, w.qualityA, tool))).rejects.toThrow(/qualification.manage/);
  });

  it('the protocol history cannot be rewritten at the database level', async () => {
    await expect(db().query(`UPDATE qualification_event SET summary = 'edited' WHERE tenant_id = $1`, [w.tenantId])).rejects.toThrow(/cannot be changed or deleted/);
    await expect(db().query(`DELETE FROM equipment_note WHERE tenant_id = $1`, [w.tenantId])).resolves.toBeDefined(); // no notes yet: nothing to refuse
  });
});
