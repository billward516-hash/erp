import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { closePools } from '../src/platform/db/pool.js';
import { diffLines } from '../src/modules/documents/diff.js';
import type { World } from './fixtures.js';
import { makeWorld } from './fixtures.js';

/** Work instructions written in the app, photos, and comparing revisions (D-170). */
let app: FastifyInstance; let w: World;
beforeAll(async () => { app = buildApp(); w = await makeWorld('workinstr'); });
afterAll(async () => { await app.close(); await closePools(); });
const call = (token: string | undefined, method: string, url: string, payload?: unknown, headers: Record<string, string> = {}) =>
  app.inject({ method: method as any, url, headers: { authorization: `Bearer ${token}`, ...headers }, payload: payload as any });
// A 1x1 PNG.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const wi = (steps: any[], extra: object = {}) => ({ purpose: 'Deburr the cross-drilled ports.', hazards: [{ text: 'Sharp edges' }], ppe: ['Cut-resistant gloves', 'Safety glasses'], tools: ['Deburring brush'], steps, ...extra });

describe('diff', () => {
  it('finds added and removed lines and leaves the rest alone', () => {
    const d = diffLines(['a', 'b', 'c', 'd'], ['a', 'c', 'x', 'd']);
    expect(d.lines.map((l) => `${l.op === 'same' ? ' ' : l.op === 'add' ? '+' : '-'}${l.text}`)).toEqual([' a', '-b', ' c', '+x', ' d']);
    expect([d.added, d.removed]).toEqual([1, 1]);
    expect(diffLines(['same'], ['same'])).toMatchObject({ added: 0, removed: 0 });
  });
});

describe('work instructions in the app', () => {
  it('are written as steps with hazards, PPE, checkpoints and photos, released like any other revision, and compared', async () => {
    const d = (await call(w.tokens.managerA, 'POST', '/api/documents', { title: 'Deburr cross-drilled ports', docType: 'work_instruction', facilityId: w.facilities.A })).json();
    const photo = await call(w.tokens.managerA, 'POST', `/api/documents/${d.id}/media?fileName=port.png`, PNG, { 'content-type': 'image/png' });
    expect(photo.statusCode, photo.body).toBe(201);
    expect((await call(w.tokens.managerA, 'POST', `/api/documents/${d.id}/media?fileName=x.exe`, Buffer.from('MZ'), { 'content-type': 'application/octet-stream' })).statusCode).toBe(422);
    const a = await call(w.tokens.managerA, 'POST', `/api/documents/${d.id}/work-instruction`, { versionLabel: 'A', content: wi([
      { text: 'Brush each port for 5 seconds.', photos: [{ id: photo.json().id }] },
      { text: 'Inspect with the borescope.', checkpoint: { label: 'No burr visible at 10x', spec: 'none' } },
      { text: 'Blow out with filtered air.', caution: 'Hold the part away from your face.' }]) });
    expect(a.statusCode, a.body).toBe(201);
    // The photo's hash is recorded in the step; the file is stored as a normal version with its checksum and searchable text.
    const doc = (await call(w.tokens.managerA, 'GET', `/api/documents/${d.id}`)).json();
    expect(doc.versions[0]).toMatchObject({ status: 'draft', mime_type: 'application/vnd.erp.work-instruction+json', file_name: 'work-instruction.json' });
    const file = await call(w.tokens.managerA, 'GET', `/api/document-versions/${a.json().id}/download`);
    expect(JSON.parse(file.body).steps[0].photos[0]).toEqual({ id: photo.json().id, sha256: photo.json().sha256 });
    // Editing the open draft rewrites it (new checksum); a released one cannot be rewritten.
    const edited = await call(w.tokens.managerA, 'POST', `/api/documents/${d.id}/work-instruction`, { versionLabel: 'A', versionId: a.json().id, content: wi([{ text: 'Brush each port for 8 seconds.' }, { text: 'Blow out with filtered air.' }]) });
    expect(edited.statusCode).toBe(200);
    expect(edited.json().sha256).not.toBe(a.json().sha256);
    await call(w.tokens.admin, 'POST', `/api/document-versions/${a.json().id}/approve`, {});
    expect((await call(w.tokens.managerA, 'POST', `/api/documents/${d.id}/work-instruction`, { versionLabel: 'A', versionId: a.json().id, content: wi([{ text: 'Sneaky edit after release' }]) })).statusCode).toBe(409);
    // Photos are served to readers of the document.
    expect((await call(w.tokens.techA, 'GET', `/api/documents/${d.id}/media/${photo.json().id}`)).rawPayload.subarray(1, 4).toString()).toBe('PNG');
    // Revision B changes a step; the comparison names what changed.
    const b = await call(w.tokens.managerA, 'POST', `/api/documents/${d.id}/work-instruction`, { versionLabel: 'B', changeSummary: 'Longer brush time and a gloves reminder', content: wi([{ text: 'Brush each port for 10 seconds.' }, { text: 'Blow out with filtered air.' }], { ppe: ['Cut-resistant gloves'] }) });
    await call(w.tokens.admin, 'POST', `/api/document-versions/${b.json().id}/approve`, {});
    // The floor works to the revision in force only; people who may see earlier revisions can compare them.
    expect((await call(w.tokens.techA, 'GET', `/api/documents/${d.id}/compare?from=${a.json().id}&to=${b.json().id}`)).statusCode).toBe(404);
    const cmp = (await call(w.tokens.managerA, 'GET', `/api/documents/${d.id}/compare?from=${a.json().id}&to=${b.json().id}`)).json();
    expect(cmp).toMatchObject({ comparable: true, identical: false, added: 2, removed: 2 });
    expect(cmp.lines.filter((l: any) => l.op !== 'same').map((l: any) => `${l.op}:${l.text}`)).toEqual(expect.arrayContaining(['del:Step 1: Brush each port for 8 seconds.', 'add:Step 1: Brush each port for 10 seconds.', 'add:PPE: Cut-resistant gloves']));
    expect(cmp.answer).toMatch(/2 lines added and 2 removed from revision A to B/);
    expect((await call(w.tokens.managerA, 'GET', `/api/documents/${d.id}/compare?from=${a.json().id}&to=${a.json().id}`)).statusCode).toBe(422);
  });

  it('refuses steps that are not valid, photos from another document, and other kinds of document', async () => {
    const d = (await call(w.tokens.managerA, 'POST', '/api/documents', { title: 'Check torque', docType: 'work_instruction', facilityId: w.facilities.A })).json();
    const other = (await call(w.tokens.managerA, 'POST', '/api/documents', { title: 'Other WI', docType: 'work_instruction', facilityId: w.facilities.A })).json();
    const foreign = (await call(w.tokens.managerA, 'POST', `/api/documents/${other.id}/media?fileName=p.png`, PNG, { 'content-type': 'image/png' })).json();
    expect((await call(w.tokens.managerA, 'POST', `/api/documents/${d.id}/work-instruction`, { versionLabel: 'A', content: wi([]) })).statusCode).toBe(422);
    const stolen = await call(w.tokens.managerA, 'POST', `/api/documents/${d.id}/work-instruction`, { versionLabel: 'A', content: wi([{ text: 'Torque the bolts.', photos: [{ id: foreign.id }] }]) });
    expect(stolen.json().error.message).toMatch(/does not belong to this document/);
    const drawing = (await call(w.tokens.managerA, 'POST', '/api/documents', { title: 'A drawing', docType: 'drawing', facilityId: w.facilities.A })).json();
    expect((await call(w.tokens.managerA, 'POST', `/api/documents/${drawing.id}/work-instruction`, { versionLabel: 'A', content: wi([{ text: 'Not for drawings.' }]) })).json().error.message).toMatch(/only work instructions, SOPs/);
    expect((await call(w.tokens.techA, 'POST', `/api/documents/${d.id}/work-instruction`, { versionLabel: 'A', content: wi([{ text: 'Technicians cannot write documents.' }]) })).statusCode).toBe(403);
  });
});
