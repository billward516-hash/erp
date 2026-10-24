import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { asActor } from '../src/platform/auth/actor.js';
import { closePools, getAdminPool } from '../src/platform/db/pool.js';
import { forgetBilledColumn, getProjectFigures, listCostRates, setCostRate, costRateOverview } from '../src/modules/projects/costing.js';
import { addMember, addMilestone, addTask, saveSettings, updateProject } from '../src/modules/projects/service.js';
import { createReport, saveLine } from '../src/modules/expenses/service.js';
import { whatIsLate } from '../src/modules/late/service.js';
import { runReminders } from '../src/modules/notifications/reminders.js';
import { addDays, addEntry, decideTimesheet, getOrCreateTimesheet, submitTimesheet } from '../src/modules/time/service.js';
import type { ProjectWorld } from './projects-helpers.js';
import { W1, makeProjectWorld, mkProject } from './projects-helpers.js';

let app: FastifyInstance; let w: ProjectWorld;
beforeAll(async () => { app = buildApp(); w = await makeProjectWorld('pcost'); });
afterAll(async () => { await app.close(); await closePools(); });
const db = () => getAdminPool();
const get = async (who: string, url: string) => app.inject({ url, headers: { authorization: `Bearer ${w.tokens[who]}` } });

/** Books hours to a project on a week of the person's timesheet and gets the week approved (by pm, a supervisor). */
async function book(who: any, employeeId: string | undefined, week: string, entries: { day: number; hours: number; projectId: string; taskId?: string; billable?: boolean }[], approve = true) {
  const ts = await asActor(who, (tx) => getOrCreateTimesheet(tx, who, { weekStart: week, employeeId }));
  for (const e of entries) await asActor(who, (tx) => addEntry(tx, who, ts.id, { workDate: addDays(week, e.day), earningCode: 'REG', hours: e.hours, projectId: e.projectId, taskId: e.taskId, billable: e.billable }));
  if (approve) {
    await asActor(who, (tx) => submitTimesheet(tx, who, ts.id));
    await asActor(w.pm, (tx) => decideTimesheet(tx, w.pm, ts.id, { decision: 'approve' }));
  }
  return ts;
}
/** Every key at every depth. */
const keysOf = (v: unknown): string[] => (Array.isArray(v) ? v.flatMap(keysOf) : v && typeof v === 'object' ? Object.entries(v).flatMap(([k, x]) => [k, ...keysOf(x)]) : []);
const costKey = /cost|margin|hourly|amount_budget|amountBudget|^rates?$/i;

describe('cost rates', () => {
  it('resolve by effective date and are visible and editable only with the cost permission', async () => {
    const set = (who: any, employeeId: string, effectiveFrom: string, hourlyCost: number) => asActor(who, (tx) => setCostRate(tx, who, { employeeId, effectiveFrom, hourlyCost }));
    await expect(set(w.pm, w.techAEmployeeId, '2020-01-01', 50)).rejects.toThrow(/projects.see_cost/);
    await expect(asActor(w.pm, (tx) => listCostRates(tx, w.pm))).rejects.toThrow(/projects.see_cost/);
    await expect(asActor(w.pm, (tx) => costRateOverview(tx, w.pm))).rejects.toThrow(/projects.see_cost/);
    await expect(asActor(w.techA, (tx) => listCostRates(tx, w.techA))).rejects.toThrow();
    await set(w.fin, w.techAEmployeeId, '2020-01-01', 50);
    await set(w.fin, w.techAEmployeeId, addDays(W1, 2), 60);
    await set(w.fin, w.techAEmployeeId, '2020-01-01', 52); // same date: replaced, not duplicated
    await expect(set(w.fin, w.techAEmployeeId, 'soon', 1)).rejects.toThrow(/effective date/);
    await expect(set(w.fin, w.techAEmployeeId, '2021-01-01', -1)).rejects.toThrow(/zero or more/);
    const rates = await asActor(w.fin, (tx) => listCostRates(tx, w.fin, w.techAEmployeeId));
    expect(rates.map((r: any) => [r.effective_from, r.hourly_cost])).toEqual([[addDays(W1, 2), 60], ['2020-01-01', 52]]);
    // the audit trail records that a rate was set, never the figure
    const a = (await db().query(`SELECT data FROM audit_event WHERE action = 'projects.cost_rate_set' AND tenant_id = $1`, [w.tenantId])).rows;
    expect(a.length).toBe(3);
    expect(a.every((x: any) => !('hourlyCost' in x.data) && !('hourly_cost' in x.data))).toBe(true);
  });
});

describe('project figures', () => {
  let p: any; let design: any; let build: any;
  beforeAll(async () => {
    await setRates();
    p = await mkProject(w, { name: 'Cost project', hoursBudget: 100, amountBudget: 6000 }, w.admin);
    design = await asActor(w.pm, (tx) => addTask(tx, w.pm, p.id, { name: 'Design', hoursBudget: 40 }));
    build = await asActor(w.pm, (tx) => addTask(tx, w.pm, p.id, { name: 'Build', hoursBudget: 60 }));
    await asActor(w.admin, (tx) => import('../src/modules/projects/service.js').then((m) => m.updateTask(tx, w.admin, design.id, { amountBudget: 2000 })));
    await asActor(w.pm, (tx) => addMember(tx, w.pm, p.id, { employeeId: w.techAEmployeeId }));
    await asActor(w.pm, (tx) => addMember(tx, w.pm, p.id, { employeeId: w.tech2AEmployeeId }));
    // Rates: 50 an hour until two days into the week, 60 from then.
    await book(w.techA, undefined, W1, [{ day: 0, hours: 8, projectId: p.id, taskId: design.id }, { day: 3, hours: 4, projectId: p.id, taskId: build.id }, { day: 4, hours: 2, projectId: p.id, billable: false }]);
    // five more hours are still waiting for approval
    await book(w.tech2A, undefined, W1, [{ day: 1, hours: 5, projectId: p.id, taskId: build.id }], false);
    // an approved expense of 100 on the project
    const cat = (await db().query(`SELECT id FROM expense_category WHERE tenant_id = $1 AND code = 'SUPPLIES'`, [w.tenantId])).rows[0].id as string;
    const r = await asActor(w.techA, (tx) => createReport(tx, w.techA, { title: 'Project supplies' }));
    await asActor(w.techA, (tx) => saveLine(tx, w.techA, r.id, { spentOn: addDays(W1, 1), categoryId: cat, amount: 100, description: 'Workshop materials', projectId: p.id }));
    await db().query(`UPDATE expense_report SET status = 'approved' WHERE id = $1`, [r.id]);
  });
  async function setRates() { await asActor(w.fin, (tx) => setCostRate(tx, w.fin, { employeeId: w.techAEmployeeId, effectiveFrom: '2020-01-01', hourlyCost: 50 })); await asActor(w.fin, (tx) => setCostRate(tx, w.fin, { employeeId: w.techAEmployeeId, effectiveFrom: addDays(W1, 2), hourlyCost: 60 })); }

  it('computes budget against actual hours and cost with the rate in force on each day', async () => {
    const f: any = await asActor(w.fin, (tx) => getProjectFigures(tx, w.fin, p.id));
    expect(f.hours).toMatchObject({ budget: 100, actual: 14, remaining: 86, used: 0.14, waiting: 5, billable: 12, nonBillable: 2, billableShare: 0.86 });
    const d = f.tasks.find((t: any) => t.name === 'Design'); const b = f.tasks.find((t: any) => t.name === 'Build'); const n = f.tasks.find((t: any) => t.id === null);
    expect(d.hours).toEqual({ budget: 40, actual: 8, remaining: 32, used: 0.2 });
    expect(d.cost).toEqual({ budget: 2000, actual: 400, remaining: 1600, used: 0.2 }); // 8 h Monday at 50
    expect(b.hours.actual).toBe(4); expect(b.waitingHours).toBe(5);
    expect(b.cost.actual).toBe(240);       // 4 h Thursday at the new rate of 60
    expect(n.hours.actual).toBe(2); expect(n.cost.actual).toBe(120); // 2 h Friday at 60
    expect(f.cost).toMatchObject({ labor: 760, expenses: 100, total: 860, unratedHours: 0 });
    expect(f.cost.budget).toEqual({ budget: 6000, actual: 860, remaining: 5140, used: 0.14 });
    expect(f.billed).toBe(0);
    expect(f.margin).toEqual({ amount: -860, pct: null, basis: 'billed to date less cost to date' });
    expect(f.burn.hoursPerWeek).toBe(3.5);  // 14 approved hours in 28 days
    expect(f.burn.projectedFinish).toBe(addDays(f.asOf, 172)); // 86 h left at 0.5 h a day
    expect(f.warnings).toEqual([]);
    expect(f.people.map((x: any) => [x.name, x.hours, x.billableHours])).toEqual([['Priya Shah', 14, 12]]);
  });

  it('takes the budget from the tasks when the project has none, and counts hours without a rate separately', async () => {
    const q = await mkProject(w, { name: 'Task budgets only' });
    await asActor(w.pm, (tx) => addTask(tx, w.pm, q.id, { name: 'One', hoursBudget: 10 }));
    await asActor(w.pm, (tx) => addTask(tx, w.pm, q.id, { name: 'Two', hoursBudget: 5 }));
    await asActor(w.pm, (tx) => addMember(tx, w.pm, q.id, { employeeId: w.tech2AEmployeeId }));
    await book(w.tech2A, undefined, addDays(W1, -7), [{ day: 0, hours: 3, projectId: q.id }]);
    const f: any = await asActor(w.fin, (tx) => getProjectFigures(tx, w.fin, q.id));
    expect(f.hours).toMatchObject({ budget: 15, actual: 3, remaining: 12, used: 0.2 });
    expect(f.cost.labor).toBe(0); expect(f.cost.unratedHours).toBe(3); // tech2A has no cost rate
    expect(f.warnings.map((x: any) => x.code)).toContain('unrated');
  });

  it('warns near and over the budget and shows the projected margin on fixed price', async () => {
    const q = await mkProject(w, { name: 'Fixed price', billingType: 'fixed_price', contractAmount: 5000, hoursBudget: 20 });
    await asActor(w.pm, (tx) => addMember(tx, w.pm, q.id, { employeeId: w.techAEmployeeId }));
    await book(w.techA, undefined, addDays(W1, -14), [{ day: 0, hours: 18, projectId: q.id }]);
    const near: any = await asActor(w.fin, (tx) => getProjectFigures(tx, w.fin, q.id));
    expect(near.warnings.map((x: any) => x.code)).toEqual(['hours_alert']);
    expect(near.contractValue).toBe(5000);
    expect(near.cost.total).toBe(900); // 18 h at 50
    expect(near.projectedMargin).toMatchObject({ cost: 1000, amount: 4000, pct: 0.8 }); // 900 / 0.9 of hours = 1000 at the full budget
    await asActor(w.pm, (tx) => updateProject(tx, w.pm, q.id, { hoursBudget: 15 }));
    const over: any = await asActor(w.fin, (tx) => getProjectFigures(tx, w.fin, q.id));
    expect(over.warnings.map((x: any) => x.code)).toEqual(['hours_over']);
    expect(over.hours.remaining).toBe(-3);
  });

  it('reads what has been billed from invoice lines once they carry a project (slice P2 adds the column)', async () => {
    forgetBilledColumn();
    expect(((await asActor(w.fin, (tx) => getProjectFigures(tx, w.fin, p.id))) as any).billed).toBe(0);
    await db().query('ALTER TABLE customer_invoice_line ADD COLUMN IF NOT EXISTS project_id uuid');
    forgetBilledColumn();
    const inv = (await db().query(`INSERT INTO customer_invoice (tenant_id, facility_id, customer_id, created_by) VALUES ($1, $2, $3, $4) RETURNING id`,
      [w.tenantId, w.facilities.A, w.customerId, w.admin.userId])).rows[0].id;
    await db().query(`INSERT INTO customer_invoice_line (tenant_id, invoice_id, line_no, description, qty, unit_price, project_id) VALUES ($1, $2, 1, 'Hours', 10, 150, $3)`, [w.tenantId, inv, p.id]);
    await db().query(`UPDATE customer_invoice SET status = 'issued', number = 'T-1', invoice_date = current_date, due_date = current_date WHERE id = $1`, [inv]);
    const f: any = await asActor(w.fin, (tx) => getProjectFigures(tx, w.fin, p.id));
    expect(f.billed).toBe(1500);
    expect(f.margin).toMatchObject({ amount: 640, pct: 0.43 }); // 1500 - 860
  });
});

describe('cost privacy', () => {
  it('gives no cost, margin, rate or money budget to anyone without see-cost, from any endpoint', async () => {
    const proj = (await db().query(`SELECT id FROM project WHERE tenant_id = $1 AND name = 'Cost project'`, [w.tenantId])).rows[0].id as string;
    for (const who of ['pm', 'viewer', 'techA']) {
      for (const url of [`/api/projects/${proj}`, `/api/projects/${proj}/figures`, `/api/projects/${proj}/contract`, '/api/projects', `/api/timesheets/mine`]) {
        const res = await get(who, url);
        expect(res.statusCode, `${who} ${url}`).toBeLessThan(500);
        if (res.statusCode !== 200) continue;
        const bad = keysOf(res.json()).filter((k) => costKey.test(k) && k !== 'canSeeCost');
        expect(bad, `${who} ${url}`).toEqual([]);
      }
    }
    expect((await get('pm', '/api/employee-cost-rates')).statusCode).toBe(403);
    expect((await get('pm', '/api/employee-cost-rates?overview=1')).statusCode).toBe(403);
    expect((await get('viewer', '/api/employee-cost-rates')).statusCode).toBe(403);
    const asFin = (await get('fin', `/api/projects/${proj}/figures`)).json();
    expect(asFin.cost.total).toBe(860);
    expect((await get('fin', '/api/employee-cost-rates?overview=1')).statusCode).toBe(200);
  });

  it('gives no cost columns in the project reports, in any format, to anyone without see-cost', async () => {
    for (const who of ['pm', 'viewer']) {
      const json = await get(who, '/api/reports/project-status?status=all');
      expect(json.statusCode, who).toBe(200);
      const body = json.json();
      expect(body.rows.length).toBeGreaterThan(0);
      expect(keysOf([body.columns, body.rows, body.kpis]).filter((k) => costKey.test(k))).toEqual([]);
      expect(body.columns.map((c: any) => c.label).join()).not.toMatch(/cost|margin|billed/i);
      expect(body.kpis.map((k: any) => k.label).join()).not.toMatch(/cost|margin/i);
      const csv = await get(who, '/api/reports/project-status?status=all&format=csv');
      expect(csv.body.split('\n')[0]).not.toMatch(/cost|margin|billed/i);
      expect(csv.body).not.toMatch(/860|\b640\b/);
      const raw = await get(who, '/api/reports/project-status?status=all&format=csv&raw=1');
      expect(raw.body.split('\n')[0]).not.toMatch(/cost|margin|billed/i);
      const time = await get(who, '/api/reports/project-time');
      expect(keysOf(time.json()).filter((k) => costKey.test(k))).toEqual([]);
    }
    const fin = (await get('fin', '/api/reports/project-status?status=all')).json();
    expect(fin.columns.map((c: any) => c.key)).toEqual(expect.arrayContaining(['cost', 'billed', 'margin', 'margin_pct']));
    const row = fin.rows.find((r: any) => r.project.endsWith('Cost project'));
    expect(row).toMatchObject({ actual_hours: 14, budget_hours: 100, complete: 0.14, waiting_hours: 5, cost: 860, billed: 1500, margin: 640 });
    // every format works for people who may see cost too
    for (const f of ['csv', 'pdf', 'xlsx']) expect((await get('fin', `/api/reports/project-status?status=all&format=${f}`)).statusCode).toBe(200);
  });

  it('reports project time by person, task, project and month', async () => {
    for (const by of ['person', 'task', 'project', 'week', 'month']) {
      const r = await get('pm', `/api/reports/project-time?by=${by}&from=${addDays(W1, -60)}&to=${addDays(W1, 6)}`);
      expect(r.statusCode, by).toBe(200);
      expect(r.json().rows.length, by).toBeGreaterThan(0);
    }
    const byPerson = (await get('pm', `/api/reports/project-time?by=person&from=${W1}&to=${addDays(W1, 6)}`)).json();
    const priya = byPerson.rows.find((r: any) => r.group === 'Priya Shah');
    expect(priya).toMatchObject({ hours: 14, billable_hours: 12, non_billable_hours: 2 });
    expect(byPerson.rows.find((r: any) => r.group === 'Luis Ortega')).toMatchObject({ hours: 0, waiting_hours: 5 });
  });

  it('keeps projects and reports to the people who may see them', async () => {
    expect((await get('techA', '/api/reports/project-status')).statusCode).toBe(403);
  });
});

describe('alerts and what is late', () => {
  it('warns the owner once at the company threshold and once when over, and re-runs without repeating', async () => {
    const q = await mkProject(w, { name: 'Alert me', hoursBudget: 20 });
    await asActor(w.pm, (tx) => addMember(tx, w.pm, q.id, { employeeId: w.techAEmployeeId }));
    await book(w.techA, undefined, addDays(W1, -28), [{ day: 0, hours: 17, projectId: q.id }]);   // 85%: nothing yet
    const count = async (kind = 'reminder.project_budget') => Number((await db().query(`SELECT count(*) FROM notification WHERE tenant_id = $1 AND kind = $2 AND subject_id = $3`, [w.tenantId, kind, q.id])).rows[0].count);
    await runReminders(w.tenantId);
    expect(await count()).toBe(0);
    await book(w.techA, undefined, addDays(W1, -35), [{ day: 0, hours: 1.5, projectId: q.id }]); // 18.5 of 20 = 92.5%
    await runReminders(w.tenantId);
    expect(await count()).toBe(1);
    await runReminders(w.tenantId);
    expect(await count()).toBe(1);
    await book(w.techA, undefined, addDays(W1, -42), [{ day: 0, hours: 4, projectId: q.id }]); // 22.5 of 20: over
    await runReminders(w.tenantId);
    expect(await count()).toBe(2);
    const n = (await db().query(`SELECT user_id, title FROM notification WHERE tenant_id = $1 AND kind = 'reminder.project_budget' AND subject_id = $2 ORDER BY created_at`, [w.tenantId, q.id])).rows;
    expect(n.every((x: any) => x.user_id === w.pm.userId)).toBe(true);
    expect(n[1].title).toMatch(/over its hours budget/);
  });

  it('lets a company change the threshold (50 to 100) and switches the reminder off with the catalogue', async () => {
    await expect(asActor(w.viewer, (tx) => saveSettings(tx, w.viewer, { budgetAlertPct: 80 }))).rejects.toThrow();
    await expect(asActor(w.pm, (tx) => saveSettings(tx, w.pm, { budgetAlertPct: 40 }))).rejects.toThrow(/50 to 100/);
    const q = await mkProject(w, { name: 'Early warning', hoursBudget: 10 });
    await asActor(w.pm, (tx) => addMember(tx, w.pm, q.id, { employeeId: w.techAEmployeeId }));
    await book(w.techA, undefined, addDays(W1, -49), [{ day: 0, hours: 8, projectId: q.id }]); // 80%
    const count = async () => Number((await db().query(`SELECT count(*) FROM notification WHERE tenant_id = $1 AND kind = 'reminder.project_budget' AND subject_id = $2`, [w.tenantId, q.id])).rows[0].count);
    await runReminders(w.tenantId);
    expect(await count()).toBe(0);
    expect((await asActor(w.pm, (tx) => saveSettings(tx, w.pm, { budgetAlertPct: 80 }))).budgetAlertPct).toBe(80);
    await runReminders(w.tenantId);
    expect(await count()).toBe(1);
    await asActor(w.pm, (tx) => saveSettings(tx, w.pm, { budgetAlertPct: 90 }));
  });

  it('lists overdue milestones in What is late for people who may see the project', async () => {
    const q = await mkProject(w, { name: 'Late milestone', billingType: 'fixed_price', contractAmount: 8000 });
    await asActor(w.pm, (tx) => addMilestone(tx, w.pm, q.id, { name: 'Draft report', dueDate: '2020-02-01', percent: 25 }));
    const late: any = await asActor(w.pm, (tx) => whatIsLate(tx, w.pm));
    const s = late.sections.find((x: any) => x.key === 'project-milestones');
    expect(s.rows.find((r: any) => r.label.includes('Late milestone'))).toMatchObject({ amount: 2000, href: `/projects/${q.id}` });
    // a person who sees no projects gets no such section
    const none: any = await asActor(w.techA, (tx) => whatIsLate(tx, w.techA));
    expect(none.sections.find((x: any) => x.key === 'project-milestones')).toBeUndefined();
  });
});
