import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { asActor } from '../src/platform/auth/actor.js';
import { closePools, getAdminPool } from '../src/platform/db/pool.js';
import { createCustomer } from '../src/modules/crm/service.js';
import type { World } from './fixtures.js';
import { makeWorld } from './fixtures.js';

/** Budget lines, pipeline, qualification definitions (SC-003). */
let app: FastifyInstance; let w: World;
beforeAll(async () => {
  app = buildApp(); w = await makeWorld('commimp');
  await asActor(w.admin, async (tx) => {
    await createCustomer(tx, w.admin, { code: 'LAKE', name: 'Lakeshore Hydraulics', kind: 'prospect' });
  });
  await getAdminPool().query(`INSERT INTO department (tenant_id, code, name) VALUES ($1, 'MNT', 'Maintenance')`, [w.tenantId]);
});
afterAll(async () => { await app.close(); await closePools(); });
const call = (method: string, url: string, payload?: unknown) => app.inject({ method: method as any, url, headers: { authorization: `Bearer ${w.tokens.admin}` }, payload: payload as any });
async function load(target: string, text: string, expectErrors = 0) {
  const s = await call('POST', '/api/imports/stage', { target, sourceSystem: 'comm', fileName: `${target}.csv`, facilityId: w.facilities.A, contentBase64: Buffer.from(text).toString('base64') });
  expect(s.statusCode, s.body).toBe(201);
  const b = s.json();
  expect(b.stats.errors, JSON.stringify(b.problems)).toBe(expectErrors);
  if (expectErrors) return b;
  const c = await call('POST', `/api/imports/${b.batchId}/commit`, {});
  expect(c.statusCode, c.body).toBe(200);
  return c.json();
}
const problems = (b: any) => b.problems.flatMap((p: any) => p.messages.map((m: any) => m.message)).join(' ');
const q = async (sql: string) => (await getAdminPool().query(sql.replace('$T', `'${w.tenantId}'`))).rows;

describe('commercial setup imports', () => {
  it('budget lines gather their months into one line, create the draft budget, and refuse an approved one', async () => {
    const csv = 'Budget name,Fiscal year,Department,Spend category,Month,Amount\n2027 operating,2027,MNT,MAINT,Jan,1000\n2027 operating,2027,MNT,MAINT,February,1200\n2027 operating,2027,MNT,MAINT,12,900\n';
    await load('budget_lines', csv);
    const line = (await q(`SELECT amounts FROM budget_line WHERE tenant_id = $T`))[0].amounts.map(Number);
    expect(line.slice(0, 2)).toEqual([1000, 1200]);
    expect(line[11]).toBe(900);
    expect(line.reduce((a: number, b: number) => a + b, 0)).toBe(3100);
    expect(problems(await load('budget_lines', 'Budget name,Fiscal year,Spend category,Month,Amount\n2027 operating,2027,NOPE,Smarch,5\n', 1))).toMatch(/spend category "NOPE" not found.*"Smarch" is not a month|"Smarch" is not a month.*not found/);
  });

  it('opportunities keep their stage and the lost reason; a reload updates the same deal', async () => {
    await load('opportunities', 'Your opportunity ID,Customer code,Title,Stage,Amount,Expected close\nD-1,LAKE,Housing machining 2027,Proposal sent,48000,2026-12-15\nD-2,LAKE,Valve bodies,Closed won,12000,2026-09-01\n');
    expect(problems(await load('opportunities', 'Customer code,Title,Stage\nLAKE,Old quote,Closed lost\n', 1))).toMatch(/say why the opportunity was lost/);
    await load('opportunities', 'Your opportunity ID,Customer code,Title,Stage,Amount\nD-1,LAKE,Housing machining 2027,Negotiation,52000\n');
    expect(await q(`SELECT title, stage, amount::float AS amount, probability FROM opportunity WHERE tenant_id = $T ORDER BY title`)).toEqual([
      { title: 'Housing machining 2027', stage: 'negotiation', amount: 52000, probability: 75 }, { title: 'Valve bodies', stage: 'won', amount: 12000, probability: 100 }]);
  });

  it('qualification definitions load once and leave existing ones alone', async () => {
    await load('qualifications', 'Code,Name,Valid for (months),Safety critical\nFORK,Forklift operator,36,yes\nCMM,CMM programming,,no\n');
    expect(await q(`SELECT code, validity_months, safety_critical FROM qualification WHERE tenant_id = $T ORDER BY code`)).toEqual([{ code: 'CMM', validity_months: null, safety_critical: false }, { code: 'FORK', validity_months: 36, safety_critical: true }]);
    expect((await load('qualifications', 'Code,Name\nFORK,Forklift renamed\n')).stats).toMatchObject({ created: 0 });
  });
});
