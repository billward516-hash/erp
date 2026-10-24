import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { closePools, getAdminPool } from '../src/platform/db/pool.js';
import { QUESTIONS, askable, evaluate } from '../src/modules/fit/interview.js';
import type { World } from './fixtures.js';
import { makeWorld } from './fixtures.js';

/** The fit interview, gentle suggestions and personal display settings (SC-004). */
let app: FastifyInstance; let w: World;
const db = () => getAdminPool();
beforeAll(async () => { app = buildApp(); w = await makeWorld('fit'); });
afterAll(async () => { await app.close(); await closePools(); });
const call = (token: string | undefined, method: string, url: string, payload?: unknown) => app.inject({ method: method as any, url, headers: { authorization: `Bearer ${token}` }, payload: payload as any });

describe('the interview engine', () => {
  it('recommends features from what the business does, with plain reasons', () => {
    const r = evaluate({ business: ['makes'], sites: '1', people: '11-50', own_equipment: true, stock: true, buys: true, sells_quotes: true, certs: ['iso9001'], books: false });
    const keys = r.show.map((x) => x.feature);
    expect(keys).toEqual(expect.arrayContaining(['assets', 'work_orders', 'storerooms', 'purchasing', 'sales', 'production', 'quality', 'capa', 'changes']));
    expect(keys).not.toContain('field_service'); expect(keys).not.toContain('leasing');
    expect(r.show.find((x) => x.feature === 'capa')!.why).toMatch(/Corrective action/);
    expect(r.depth).toBe('standard'); expect(r.steps).toEqual(expect.arrayContaining(['boms', 'parts', 'suppliers']));
    expect(r.maybe.map((x) => x.feature)).toContain('payables'); // no built-in books chosen: bills can go to accounting software
  });
  it('says what is not a fit, and a small office gets a small plan', () => {
    const food = evaluate({ business: ['food'], sites: '2-3', people: '11-50', stock: true, tracked: true });
    expect(food.notFit.join(' ')).toMatch(/Recipe costing and menu management are not included/);
    expect(food.show.map((x) => x.feature)).toEqual(expect.arrayContaining(['safety', 'visits']));
    const office = evaluate({ business: ['office'], sites: '1', people: '1-10', books: true, expenses: true });
    expect(office.depth).toBe('guided'); expect(office.notFit.join(' ')).toMatch(/payroll calculation or tax filing/);
    expect(evaluate({ business: ['makes'], sites: '10+', people: '200+', certs: ['iatf'] }).depth).toBe('full');
  });
});

describe('the interview over the API', () => {
  it('is for administrators; answers are checked, can be resumed, and branches drop answers no longer asked', async () => {
    expect((await call(w.tokens.techA, 'GET', '/api/fit-interview')).statusCode).toBe(403);
    const first = (await call(w.tokens.admin, 'GET', '/api/fit-interview')).json();
    expect(first.result).toBeNull(); expect(first.questions[0].id).toBe('business');
    expect((await call(w.tokens.admin, 'PUT', '/api/fit-interview', { business: ['nonsense'] })).statusCode).toBe(422);
    expect((await call(w.tokens.admin, 'PUT', '/api/fit-interview', { stock: 'yes' })).statusCode).toBe(422);
    expect((await call(w.tokens.admin, 'PUT', '/api/fit-interview', { nope: true })).statusCode).toBe(422);
    const a = (await call(w.tokens.admin, 'PUT', '/api/fit-interview', { business: ['makes', 'services'], sites: '1', people: '11-50', contracts: true, stock: true, tracked: true })).json();
    expect(a.result.show.map((x: any) => x.feature)).toContain('field_service');
    expect(a.questions.map((q: any) => q.id)).toContain('contracts');
    const b = (await call(w.tokens.admin, 'PUT', '/api/fit-interview', { business: ['makes'] })).json();
    expect(b.answers.contracts).toBeUndefined(); expect(b.questions.map((q: any) => q.id)).not.toContain('contracts');
    expect(b.result.show.map((x: any) => x.feature)).not.toContain('field_service');
  });
  it('applying hides what was not recommended (reversibly) and leaves the rest', async () => {
    await call(w.tokens.admin, 'PUT', '/api/fit-interview', { business: ['office'], books: true });
    const r = await call(w.tokens.admin, 'POST', '/api/fit-interview/apply');
    expect(r.statusCode, r.body).toBe(200); expect(r.json().hidden).toBeGreaterThan(5);
    const f = (await call(w.tokens.admin, 'GET', '/api/features')).json();
    const byKey = (k: string) => (f.features ?? f).find((x: any) => x.key === k);
    expect(byKey('production').mode).toBe('off'); expect(byKey('books').mode).toBe('all');
  });
});

describe('gentle suggestions', () => {
  it('appear for an administrator only, once, and stay until dismissed; a dismissed one stays away; a week passes between cards', async () => {
    const w2 = await makeWorld('fit2');
    expect((await call(w2.tokens.admin, 'GET', '/api/suggestions/next')).json()).toBeNull(); // nothing noticed yet
    // Five parts issued with no reorder point
    for (let i = 0; i < 5; i++) {
      const p = (await db().query(`INSERT INTO part (tenant_id, part_number, description) VALUES ($1, $2, 'x') RETURNING id`, [w2.tenantId, `P-${i}`])).rows[0].id;
      const l = (await db().query(`INSERT INTO stock_location (tenant_id, facility_id, code, name) VALUES ($1, $2, $3, 'S') RETURNING id`, [w2.tenantId, w2.facilities.A, `L-${i}`])).rows[0].id;
      await db().query(`INSERT INTO inventory_balance (tenant_id, facility_id, location_id, part_id, qty_on_hand) VALUES ($1, $2, $3, $4, 10)`, [w2.tenantId, w2.facilities.A, l, p]);
      await db().query(`INSERT INTO inventory_txn (tenant_id, facility_id, location_id, part_id, txn_type, qty, balance_after, created_by) VALUES ($1, $2, $3, $4, 'issue', -1, 9, $5)`, [w2.tenantId, w2.facilities.A, l, p, w2.admin.userId]);
    }
    expect((await call(w2.tokens.managerA, 'GET', '/api/suggestions/next')).json()).toBeNull(); // not an administrator
    const c = (await call(w2.tokens.admin, 'GET', '/api/suggestions/next')).json();
    expect(c).toMatchObject({ key: 'reorder_points', link: '/inventory' }); expect(c.evidence).toMatch(/5 parts issued/);
    expect((await call(w2.tokens.admin, 'GET', '/api/suggestions/next')).json().id).toBe(c.id); // it stays
    expect((await call(w2.tokens.admin, 'POST', `/api/suggestions/${c.id}/dismiss`, {})).statusCode).toBe(204);
    expect((await call(w2.tokens.admin, 'GET', '/api/suggestions/next')).json()).toBeNull(); // not another within the week
    await db().query(`UPDATE suggestion_log SET shown_at = now() - interval '8 days' WHERE id = $1`, [c.id]);
    expect((await call(w2.tokens.admin, 'GET', '/api/suggestions/next')).json()).toBeNull(); // dismissed: this one stays away for 90 days, and nothing else applies
    expect((await call(w2.tokens.admin, 'GET', '/api/suggestions/history')).json()).toHaveLength(1);
  });
  it('can be switched off for the company and for a person', async () => {
    const w3 = await makeWorld('fit3');
    await db().query(`INSERT INTO customer (tenant_id, code, name) VALUES ($1, 'C', 'Cust')`, [w3.tenantId]);
    for (let i = 0; i < 3; i++) await db().query(`INSERT INTO quote (tenant_id, facility_id, number, customer_id, title, status, valid_until, created_by) SELECT $1, $2, $3, c.id, 'q', 'sent', current_date - 3, $4 FROM (SELECT id FROM customer WHERE tenant_id = $1 LIMIT 1) c`, [w3.tenantId, w3.facilities.A, `Q-${i}`, w3.admin.userId]);
    expect((await call(w3.tokens.admin, 'PUT', '/api/my-preferences', { suggestions: false })).json().suggestions).toBe(false);
    expect((await call(w3.tokens.admin, 'GET', '/api/suggestions/next')).json()).toBeNull();
    await call(w3.tokens.admin, 'PUT', '/api/my-preferences', { suggestions: true });
    expect((await call(w3.tokens.admin, 'GET', '/api/suggestions/next')).json()).toMatchObject({ key: 'quote_expiry' });
    expect((await call(w3.tokens.admin, 'PUT', '/api/suggestions/settings', { enabled: false })).json()).toEqual({ enabled: false });
    await db().query('DELETE FROM suggestion_log WHERE tenant_id = $1', [w3.tenantId]);
    expect((await call(w3.tokens.admin, 'GET', '/api/suggestions/next')).json()).toBeNull();
  });
});

describe('how I like to work', () => {
  it('stores display settings per person with checked values', async () => {
    expect((await call(w.tokens.techA, 'GET', '/api/my-preferences')).json()).toMatchObject({ density: 'normal', textSize: 'normal', highContrast: false });
    const r = await call(w.tokens.techA, 'PUT', '/api/my-preferences', { density: 'compact', textSize: 'large', highContrast: true, defaultView: 'table' });
    expect(r.json()).toMatchObject({ density: 'compact', textSize: 'large', highContrast: true, defaultView: 'table', reducedMotion: false });
    expect((await call(w.tokens.techA, 'PUT', '/api/my-preferences', { density: 'huge' })).statusCode).toBe(422);
    expect((await call(w.tokens.tech2A, 'GET', '/api/my-preferences')).json().density).toBe('normal'); // someone else's are untouched
  });
});

describe('the business case diagnosis (version 2)', () => {
  it('asks many questions in sections, and a given business sees only the ones that apply', () => {
    expect(QUESTIONS.length).toBeGreaterThanOrEqual(60);
    expect(QUESTIONS[0]!.id).toBe('business');
    expect(new Set(QUESTIONS.map((q) => q.section)).size).toBeGreaterThanOrEqual(10);
    const sections = QUESTIONS.map((q) => q.section!); // sections are contiguous: a heading never repeats
    expect(sections.filter((s2, i) => s2 !== sections[i - 1]).length).toBe(new Set(sections).size);
    const maker = askable({ business: ['makes'] }).length, pro = askable({ business: ['professional'] }).length;
    expect(maker).toBeGreaterThan(30); expect(pro).toBeLessThan(QUESTIONS.length); expect(askable({ business: ['professional'] }).some((q) => q.id === 'bill_hours')).toBe(true);
    expect(askable({ business: ['makes'] }).some((q) => q.id === 'bill_hours')).toBe(false);
  });
  it('records what a professional-services firm wants and we have not built, without recommending operations features', () => {
    const r = evaluate({ business: ['professional'], sites: '1', people: '11-50', revenue: ['time_materials', 'retainers'], bill_hours: true, projects: true, utilization: true, retainers: true, client_portal: true, tickets: true, books: true, time: true, expenses: true });
    expect(r.unmet.map((u) => u.key)).toEqual(expect.arrayContaining(['hourly_billing', 'projects', 'utilization', 'recurring_billing', 'client_portal', 'ticketing']));
    expect(r.notFit.join(' ')).toMatch(/Professional-services work is held/);
    const keys = r.show.map((x) => x.feature);
    expect(keys).toEqual(expect.arrayContaining(['time', 'expenses', 'books'])); expect(keys).not.toContain('production'); expect(keys).not.toContain('work_orders');
  });
  it('turns the company’s own numbers into exposure lines with the arithmetic shown, and no invented savings', () => {
    const r = evaluate({ business: ['makes'], own_equipment: true, stock: true, num_downtime_hours: 20, num_downtime_cost: 1500, num_paperwork_hours: 40, num_loaded_rate: 50, audits: 'yearly', num_audit_days: 10, num_scrap: 90000, num_inventory: 400000, pains: ['billing', 'breakdowns'], num_revenue: 3650000, num_invoice_days: 12 });
    const bc = r.businessCase!;
    const line = (k: string) => bc.lines.find((l) => l.key === k)!;
    expect(line('downtime').amount).toBe(20 * 1500 * 12); expect(line('paperwork').amount).toBe(40 * 50 * 52); expect(line('audit').amount).toBe(10 * 8 * 50);
    expect(line('scrap').amount).toBe(90000); expect(line('unbilled').amount).toBe(Math.round((3650000 / 365) * 12)); expect(line('unbilled').kind).toBe('cash tied up');
    expect(bc.yearlyTotal).toBe(360000 + 104000 + 4000 + 90000); expect(bc.cashTotal).toBe(400000 + 120000); expect(bc.tenPercent).toBe(Math.round(bc.yearlyTotal * 0.1));
    expect(bc.note).toMatch(/not a forecast of savings/);
    expect(evaluate({ business: ['makes'] }).businessCase).toBeNull();
    expect(r.measures.map((m) => m.where).join(' ')).toMatch(/Reliability/);
  });
  it('flags readiness in plain words', () => {
    const weak = evaluate({ business: ['makes'], champion: false, admin_capacity: 'none', data_state: 'none', blockers: ['data'], timeline: '3', sites: '4-10' });
    expect(weak.readiness.level).toBe('needs groundwork'); expect(weak.readiness.flags.map((f) => f.text).join(' ')).toMatch(/No named owner/);
    const strong = evaluate({ business: ['makes'], champion: true, admin_capacity: 'dedicated', data_state: 'clean', sso: true });
    expect(strong.readiness.level).toBe('ready');
  });
  it('accepts numbers and text through the API within their limits', async () => {
    const put = (payload: unknown) => call(w.tokens.admin, 'PUT', '/api/fit-interview', payload);
    expect((await put({ business: ['makes'], own_equipment: true, num_downtime_hours: 12 })).statusCode).toBe(200);
    expect((await put({ num_downtime_hours: -3 })).statusCode).toBeGreaterThanOrEqual(400);
    expect((await put({ num_downtime_hours: 'many' })).statusCode).toBeGreaterThanOrEqual(400);
    expect((await put({ success_text: 'x'.repeat(501) })).statusCode).toBeGreaterThanOrEqual(400);
    const ok = await put({ success_text: 'Audits take two days, not two weeks.' });
    expect(ok.statusCode).toBe(200); expect(ok.json().result.success).toMatch(/two days/);
  });
});
