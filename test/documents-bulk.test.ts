import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { closePools, getAdminPool } from '../src/platform/db/pool.js';
import { zip as createZip } from '../src/platform/http/zip.js';
import { readZip } from '../src/platform/http/zip-read.js';
import type { World } from './fixtures.js';
import { makeWorld } from './fixtures.js';

/** Bulk document load from a zip with an index sheet (SC-003). */
let app: FastifyInstance; let w: World;
beforeAll(async () => { app = buildApp(); w = await makeWorld('docbulk'); });
afterAll(async () => { await app.close(); await closePools(); });
const post = (token: string, zip: Buffer, query = '') => app.inject({ method: 'POST', url: `/api/documents/bulk${query}`, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/zip' }, payload: zip });
const zipOf = (files: Record<string, string>) => createZip(Object.entries(files).map(([name, text]) => ({ name, data: Buffer.from(text) })));

describe('zip reader', () => {
  it('reads what the writer wrote and refuses unsafe paths and non-zips', () => {
    const z = zipOf({ 'a/b.txt': 'hello', 'c.txt': 'world' });
    expect(readZip(z).map((e) => [e.name, e.content.toString()])).toEqual([['a/b.txt', 'hello'], ['c.txt', 'world']]);
    expect(() => readZip(Buffer.from('not a zip at all, definitely'))).toThrow(/not a zip/);
    expect(() => readZip(zipOf({ '../evil.txt': 'x' }))).toThrow(/unsafe path/);
  });
});

describe('bulk documents', () => {
  const index = 'File,Title,Type,Document number,Revision,Effective date,Folder,Site\n'
    + 'sop-clean-A.txt,Housekeeping,SOP,SOP-100,A,2024-01-10,Safety/General,\n'
    + 'sop-clean-B.txt,Housekeeping,SOP,SOP-100,B,2025-06-01,Safety/General,\n'
    + 'wi-deburr.txt,Deburr ports,Work instruction,WI-7,1,2025-02-02,,A\n';
  const files = { 'index.csv': index, 'sop-clean-A.txt': 'sweep daily', 'sop-clean-B.txt': 'sweep daily and log it', 'wi-deburr.txt': 'deburr with the 400 stone' };

  it('checks first: problems stop the load and name the row', async () => {
    const bad = await post(w.tokens.admin!, zipOf({ 'index.csv': 'File,Title,Type\nmissing.pdf,Thing,SOP\nx.txt,Other,Spaceship\n', 'x.txt': 'x' }));
    expect(bad.statusCode, bad.body).toBe(200);
    const r = bad.json();
    expect(r.committed).toBe(false);
    expect(r.stats.errors).toBe(2);
    expect(r.rows.flatMap((x: any) => x.problems).join(' ')).toMatch(/file "missing.pdf" is not in the zip.*unknown type "Spaceship"/);
    expect((await post(w.tokens.admin!, zipOf({ 'x.txt': 'x' }))).statusCode).toBe(422);
    expect((await post(w.tokens.techA!, zipOf(files))).statusCode).toBe(403);
  });

  it('loads revisions as released: the newest in force, the earlier superseded; a second load adds nothing', async () => {
    const dry = (await post(w.tokens.admin!, zipOf(files), '?dryRun=1')).json();
    expect(dry).toMatchObject({ committed: false, stats: { total: 3, new: 3, errors: 0 } });
    expect((await getAdminPool().query('SELECT count(*)::int AS n FROM document WHERE tenant_id = $1', [w.tenantId])).rows[0].n).toBe(0);
    const r = await post(w.tokens.admin!, zipOf(files), '?fileName=legacy-docs.zip');
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json()).toMatchObject({ committed: true, stats: { created: 3, documents: 2 } });
    const docs = (await getAdminPool().query(`SELECT d.doc_number, d.facility_id, f.name AS folder, cv.version_label AS current, (SELECT count(*)::int FROM document_version v WHERE v.document_id = d.id) AS versions,
        (SELECT status FROM document_version v WHERE v.document_id = d.id AND v.revision = 1) AS first_status
      FROM document d LEFT JOIN document_folder f ON f.id = d.folder_id LEFT JOIN document_version cv ON cv.id = d.current_version_id WHERE d.tenant_id = $1 ORDER BY d.doc_number`, [w.tenantId])).rows;
    expect(docs).toEqual([{ doc_number: 'SOP-100', facility_id: null, folder: 'General', current: 'B', versions: 2, first_status: 'superseded' },
      { doc_number: 'WI-7', facility_id: w.facilities.A, folder: null, current: '1', versions: 1, first_status: 'approved' }]);
    expect((await post(w.tokens.admin!, zipOf(files))).json()).toMatchObject({ committed: true, stats: { created: 0, unchanged: 3 } });
    expect((await getAdminPool().query('SELECT count(*)::int AS n FROM document_version WHERE tenant_id = $1', [w.tenantId])).rows[0].n).toBe(3);
    // The file is the one uploaded, and opening it is logged like any other.
    const v = (await getAdminPool().query(`SELECT id FROM document_version WHERE tenant_id = $1 AND version_label = 'B'`, [w.tenantId])).rows[0].id;
    const dl = await app.inject({ method: 'GET', url: `/api/document-versions/${v}/download`, headers: { authorization: `Bearer ${w.tokens.admin}` } });
    expect(dl.statusCode).toBe(200);
    expect(dl.body).toBe('sweep daily and log it');
    // The import is on the books for the implementation plan.
    expect((await getAdminPool().query(`SELECT stats FROM import_batch WHERE tenant_id = $1 AND target = 'documents'`, [w.tenantId])).rows.length).toBe(2);
  });
});
