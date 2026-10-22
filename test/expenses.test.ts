import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { asActor } from '../src/platform/auth/actor.js';
import { createDelegation, myApprovalQueue } from '../src/platform/approvals/engine.js';
import { closePools, getAdminPool } from '../src/platform/db/pool.js';
import { decideApproval } from '../src/modules/approvals/service.js';
import { checkLines, lineReady } from '../src/modules/expenses/policy-check.js';
import {
  approvalRoute, attachReceipt, createReport, getReport, listReports, markPaid, reviseReport, saveLine, saveRule, setDepartmentHead, submitReport, withdrawReport,
} from '../src/modules/expenses/service.js';
import { expenseRules, saveExpenseCategory, saveExpensePolicy } from '../src/modules/policies/service.js';
import type { World } from './fixtures.js';
import { makeWorld } from './fixtures.js';

const db = () => getAdminPool();
let w: World;
let cats: Record<string, any>;
let dept: string;
const day = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
const blobs = { put: async (_t: string, c: Buffer) => ({ key: `k-${c.length}-${Math.random()}`, sha256: 'x' }), get: async () => Buffer.from('r') } as any;

describe('policy checks (pure)', () => {
  const C = (id: string, extra: object = {}) => ({ id, code: id.toUpperCase(), name: id, kind: 'amount' as const, limit_per_item: null, limit_per_day: null, receipt_required_over: null, needs_attendees: false, active: true, ...extra });
  const categories = [C('lodging', { limit_per_item: 200 }), C('meals', { limit_per_day: 75 }), C('bizmeal', { needs_attendees: true }), C('mileage', { kind: 'mileage' }), C('other', { code: 'OTHER' })];
  const policy = { receipt_required_over: 25, mileage_rate: null, submit_within_days: 60 };
  const L = (line_no: number, x: object) => ({ line_no, spent_on: '2026-10-10', category_id: 'meals', merchant: null, description: null, amount: 10, miles: null, attendees: null, explanation: null, has_receipt: true, ...x });
  it('blocks what cannot be approved and flags exceptions to explain', () => {
    const f = checkLines([
      L(1, { category_id: 'lodging', amount: 240, has_receipt: false }),
      L(2, { amount: 50 }), L(3, { amount: 40 }),
      L(4, { category_id: 'bizmeal', amount: 90 }),
      L(5, { category_id: 'mileage', amount: 0, miles: 40 }),
      L(6, { category_id: 'other', spent_on: '2026-12-01' }),
      L(7, { spent_on: '2026-07-01', merchant: 'Diner', amount: 12 }), L(8, { spent_on: '2026-07-01', merchant: 'diner ', amount: 12 }),
    ], categories, policy, '2026-10-20');
    const codes = (n: number) => f.get(n)!.map((x) => `${x.severity}:${x.code}`);
    expect(codes(1)).toEqual(['explain:receipt', 'explain:over_item']);
    expect(f.get(1)![1]!.message).toBe('$40.00 over the $200.00 limit per expense for lodging');
    expect(codes(2)).toEqual(['explain:over_day']);
    expect(f.get(3)![0]!.message).toBe('meals on 2026-10-10 total $90.00, over the $75.00 daily limit');
    expect(codes(4)).toEqual(['block:attendees']);
    expect(codes(5)).toEqual(['block:mileage_rate', 'block:trip']);
    expect(codes(6)).toEqual(['block:future', 'block:describe']);
    expect(codes(7)).toEqual(['explain:late', 'explain:duplicate']);
    expect(lineReady(f.get(1)!, null)).toBe(false);
    expect(lineReady(f.get(1)!, 'Hotel lost the folio; card statement attached')).toBe(true);
    expect(lineReady(f.get(4)!, 'Lunch with customer')).toBe(false);
  });
  it('catches the same expense claimed on an earlier report', () => {
    const f = checkLines([L(1, { merchant: 'Hertz', amount: 180, category_id: 'other', description: 'car' })], categories, policy, '2026-10-20',
      [{ report_number: 'EXP-000004', spent_on: '2026-10-10', amount: 180, merchant: 'HERTZ' }]);
    expect(f.get(1)!.map((x) => x.message)).toEqual(['looks like the same expense on EXP-000004']);
  });
});

beforeAll(async () => {
  w = await makeWorld('exp');
  dept = (await db().query(`INSERT INTO department (tenant_id, facility_id, code, name) VALUES ($1, $2, 'MNT', 'Maintenance') RETURNING id`, [w.tenantId, w.facilities.A])).rows[0].id;
  await db().query('UPDATE employee SET department_id = $2 WHERE id = $1', [w.techAEmployeeId, dept]);
  await asActor(w.admin, (tx) => setDepartmentHead(tx, w.admin, dept, w.managerA.userId));
  await asActor(w.admin, (tx) => saveExpensePolicy(tx, w.admin, { receiptRequiredOver: 25, mileageRate: 0.7, submitWithinDays: 60 }));
  const r = await asActor(w.admin, (tx) => expenseRules(tx));
  cats = Object.fromEntries(r.categories.map((c: any) => [c.code, c]));
  const l = cats.LODGING;
  await asActor(w.admin, (tx) => saveExpenseCategory(tx, w.admin, { id: l.id, code: 'LODGING', name: l.name, kind: 'amount', accountKey: l.account_key, limitPerItem: 200 }));
});
afterAll(closePools);

describe('an expense report from claim to reimbursement', () => {
  let rep: any;
  it('routes to the department head in person, then finance over $500', async () => {
    rep = await asActor(w.techA, (tx) => createReport(tx, w.techA, { title: 'Pump training, Columbus', purpose: 'Vendor training on the Grundfos line' }));
    expect(rep).toMatchObject({ facility_id: w.facilities.A, department_id: dept, status: 'draft', number: expect.stringMatching(/^EXP-\d{6}$/) });
    const hotel = await asActor(w.techA, (tx) => saveLine(tx, w.techA, rep.id, { spentOn: day(-3), categoryId: cats.LODGING.id, merchant: 'Hilton Columbus', amount: 240 }));
    await asActor(w.techA, (tx) => saveLine(tx, w.techA, rep.id, { spentOn: day(-3), categoryId: cats.MILEAGE.id, miles: 142, description: 'Dayton to Columbus and back' }));
    const meal = await asActor(w.techA, (tx) => saveLine(tx, w.techA, rep.id, { spentOn: day(-3), categoryId: cats.BIZMEAL.id, merchant: 'Lindey\'s', amount: 96 }));
    await asActor(w.techA, (tx) => saveLine(tx, w.techA, rep.id, { spentOn: day(-2), categoryId: cats.TRAINING.id, merchant: 'Grundfos', amount: 250, description: 'Course fee' }));
    let g = await asActor(w.techA, (tx) => getReport(tx, w.techA, rep.id));
    expect(g.lines.find((l: any) => l.category_code === 'MILEAGE')).toMatchObject({ amount: 99.4, rate: 0.7 });
    expect(g.total).toBe(685.4);
    expect(g.route.map((s: any) => s.steps.map((x: any) => x.label))).toEqual([['Manager approval: managerA (head of Maintenance)'], ['Finance review']]);
    await expect(asActor(w.techA, (tx) => submitReport(tx, w.techA, rep.id))).rejects.toThrow(/line 1: receipt required over \$25.00.*; \$40.00 over the \$200.00 limit.*\(add an explanation\)/);
    await asActor(w.techA, (tx) => attachReceipt(tx, w.techA, blobs, hotel.id, { fileName: 'folio.pdf', mime: 'application/pdf', content: Buffer.from('%PDF') }));
    await asActor(w.techA, (tx) => saveLine(tx, w.techA, rep.id, { id: hotel.id, spentOn: day(-3), categoryId: cats.LODGING.id, merchant: 'Hilton Columbus', amount: 240, explanation: 'Only hotel with rooms near the training center' }));
    await expect(asActor(w.techA, (tx) => submitReport(tx, w.techA, rep.id))).rejects.toThrow(/line 3: Business meals with guests: list who attended/);
    await asActor(w.techA, (tx) => attachReceipt(tx, w.techA, blobs, meal.id, { fileName: 'meal.jpg', mime: 'image/jpeg', content: Buffer.from('jpg') }));
    await asActor(w.techA, (tx) => saveLine(tx, w.techA, rep.id, { id: meal.id, spentOn: day(-3), categoryId: cats.BIZMEAL.id, merchant: 'Lindey\'s', amount: 96, attendees: 'J. Park (Grundfos trainer): course follow-up' }));
    g = await asActor(w.techA, (tx) => getReport(tx, w.techA, rep.id));
    // The training fee has no receipt yet.
    expect(g.lines.find((l: any) => l.category_code === 'TRAINING').findings.map((f: any) => f.code)).toEqual(['receipt']);
    const fee = g.lines.find((l: any) => l.category_code === 'TRAINING');
    await asActor(w.techA, (tx) => attachReceipt(tx, w.techA, blobs, fee.id, { fileName: 'fee.pdf', mime: 'application/pdf', content: Buffer.from('%PDF-1') }));
    expect(await asActor(w.techA, (tx) => submitReport(tx, w.techA, rep.id))).toMatchObject({ total: 685.4 });
    // Lines are frozen once submitted (database guard).
    await expect(db().query(`UPDATE expense_line SET amount = 1 WHERE report_id = $1`, [rep.id])).rejects.toThrow(/only while the report is a draft/);
  });

  it('only the department head (or their delegate) signs the first step; outsiders cannot read the report', async () => {
    const q = await asActor(w.managerA, (tx) => myApprovalQueue(tx, w.managerA));
    const step = q.find((s) => s.subject_id === rep.id)!;
    expect(step.label).toMatch(/head of Maintenance/);
    // Another maintenance manager-type role cannot sign a personal step.
    await expect(asActor(w.dualA, (tx) => decideApproval(tx, w.dualA, step.step_id, { decision: 'approve' }))).rejects.toThrow(/this step is for managerA/);
    await expect(asActor(w.tech2A, (tx) => getReport(tx, w.tech2A, rep.id))).rejects.toThrow(/expenses.view_all/);
    // While managerA is away, tech2A signs on their behalf.
    await asActor(w.managerA, (tx) => createDelegation(tx, w.managerA, { delegateUserId: w.tech2A.userId, startsOn: day(0), endsOn: day(5), reason: 'Vacation' }));
    expect((await asActor(w.tech2A, (tx) => myApprovalQueue(tx, w.tech2A))).map((s) => s.subject_id)).toContain(rep.id);
    await asActor(w.tech2A, (tx) => decideApproval(tx, w.tech2A, step.step_id, { decision: 'approve' }));
    const g = await asActor(w.tech2A, (tx) => getReport(tx, w.tech2A, rep.id)); // an approver can now read it
    expect(g.approvals[0].steps[0]).toMatchObject({ decided_by: 'tech2A', on_behalf_of: 'managerA' });
  });

  it('finance approves; the report goes to accounting and is reimbursed by someone other than the claimant', async () => {
    const step = (await asActor(w.finance, (tx) => myApprovalQueue(tx, w.finance))).find((s) => s.subject_id === rep.id)!;
    await asActor(w.finance, (tx) => decideApproval(tx, w.finance, step.step_id, { decision: 'approve' }));
    const ev = (await db().query(`SELECT topic, payload FROM outbox_event WHERE aggregate_id = $1`, [rep.id])).rows;
    expect(ev.map((e) => e.topic)).toEqual(['expense.report.approved']);
    expect(ev[0].payload).toMatchObject({ kind: 'expense_report', invoiceNumber: rep.number, total: 685.4, supplier: { name: 'techA' } });
    expect(ev[0].payload.lines.map((l: any) => l.accountKey)).toEqual(['travel_expense', 'travel_expense', 'meals_entertainment', 'training_expense']);
    await expect(asActor(w.techA, (tx) => markPaid(tx, w.techA, rep.id, { paidOn: day(0), method: 'payroll' }))).rejects.toThrow(/expenses.manage/);
    await asActor(w.finance, (tx) => markPaid(tx, w.finance, rep.id, { paidOn: day(0), method: 'payroll', reference: 'Payroll run 2026-21' }));
    expect((await asActor(w.techA, (tx) => getReport(tx, w.techA, rep.id))).status).toBe('paid');
    expect((await db().query(`SELECT title FROM notification WHERE user_id = $1 AND kind = 'expense.paid'`, [w.techA.userId])).rows[0].title).toBe(`Reimbursed: ${rep.number} (Pump training, Columbus)`);
    expect((await asActor(w.finance, (tx) => listReports(tx, w.finance, { scope: 'all' }))).map((r) => r.number)).toContain(rep.number);
  });

  it('withdraw, reject and revise; rules by department and amount', async () => {
    const r2 = await asActor(w.techA, (tx) => createReport(tx, w.techA, { title: 'Parking' }));
    await asActor(w.techA, (tx) => saveLine(tx, w.techA, r2.id, { spentOn: day(-1), categoryId: cats.PARKING.id, merchant: 'Garage', amount: 18 }));
    await asActor(w.techA, (tx) => submitReport(tx, w.techA, r2.id));
    await asActor(w.techA, (tx) => withdrawReport(tx, w.techA, r2.id));
    expect((await asActor(w.techA, (tx) => getReport(tx, w.techA, r2.id))).revision).toBe(2);
    await asActor(w.techA, (tx) => submitReport(tx, w.techA, r2.id));
    const step = (await asActor(w.managerA, (tx) => myApprovalQueue(tx, w.managerA))).find((s) => s.subject_id === r2.id)!;
    await asActor(w.managerA, (tx) => decideApproval(tx, w.managerA, step.step_id, { decision: 'reject', comment: 'Parking is covered by the plant pass' }));
    expect((await asActor(w.techA, (tx) => getReport(tx, w.techA, r2.id))).status).toBe('rejected');
    await asActor(w.techA, (tx) => reviseReport(tx, w.techA, r2.id));
    // A department rule: Maintenance reports over $100 also need the maintenance manager role.
    await asActor(w.admin, (tx) => saveRule(tx, w.admin, { departmentId: dept, minAmount: 100, stage: 2, approver: 'role', roleKey: 'maintenance_manager', label: 'Maintenance budget owner' }));
    const route = (total: number) => asActor(w.admin, (tx) => approvalRoute(tx, { facility_id: w.facilities.A!, department_id: dept, user_id: w.techA.userId }, total));
    expect((await route(50)).map((s) => s.steps.map((x) => x.label))).toEqual([['Manager approval: managerA (head of Maintenance)']]);
    expect((await route(600)).map((s) => s.steps.map((x) => x.label).sort())).toEqual([['Manager approval: managerA (head of Maintenance)'], ['Finance review', 'Maintenance budget owner']]);
    // The head claiming their own expenses goes to the rule's role instead.
    expect((await asActor(w.admin, (tx) => approvalRoute(tx, { facility_id: w.facilities.A!, department_id: dept, user_id: w.managerA.userId }, 50))).map((s) => s.steps.map((x) => [x.roleKey, x.label])))
      .toEqual([[['operations_manager', 'Manager approval (no department head available)']]]);
  });
});
