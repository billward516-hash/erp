import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { asActor, loadActor } from '../src/platform/auth/actor.js';
import type { Actor } from '../src/platform/auth/actor.js';
import { closePools, getAdminPool } from '../src/platform/db/pool.js';
import { createUserWithToken } from '../src/platform/tenancy/provision.js';
import { createAsset } from '../src/modules/assets/service.js';
import { addLabor, assignTechnician, createWorkOrder, transitionWorkOrder } from '../src/modules/maintenance/service.js';
import { getReport } from '../src/modules/reporting/registry.js';
import {
  addEntry, addDays, createPayrollExport, decideTimesheet, getOrCreateTimesheet, getTimesheet, payrollPreview, removeEntry, reopenTimesheet,
  setEarningCode, submitTimesheet, teamWeek, weekStartOf,
} from '../src/modules/time/service.js';
import type { World } from './fixtures.js';
import { makeWorld } from './fixtures.js';

let w: World;
let payroll: Actor;
let woId: string;
// The last complete week and the one before it, relative to today, so the report covers them.
const W1 = addDays(weekStartOf(new Date().toISOString().slice(0, 10)), -7);
const W0 = addDays(W1, -7);
const open = (who: Actor, weekStart: string, employeeId?: string) => asActor(who, (tx) => getOrCreateTimesheet(tx, who, { weekStart, employeeId }));
const view = (who: Actor, id: string) => asActor(who, (tx) => getTimesheet(tx, who, id));

beforeAll(async () => {
  w = await makeWorld('time');
  const u = await createUserWithToken(getAdminPool(), w.tenantId, { email: `payroll-${Date.now()}@t.example`, displayName: 'Payroll', roles: [{ role: 'payroll_admin', facility: null }] });
  payroll = (await loadActor(w.tenantId, u.userId))!;
  const asset = await asActor(w.managerA, (tx) => createAsset(tx, w.managerA, { facilityId: w.facilities.A!, assetTag: 'LTH-1', name: 'Lathe' }));
  woId = (await asActor(w.managerA, async (tx) => {
    const wo = await createWorkOrder(tx, w.managerA, { assetId: asset.id, title: 'Replace chuck jaws' });
    await assignTechnician(tx, w.managerA, wo.id, w.techAEmployeeId, 'lead');
    return wo;
  })).id;
  await asActor(w.techA, async (tx) => {
    await transitionWorkOrder(tx, w.techA, woId, { to: 'in_progress' });
    await addLabor(tx, w.techA, woId, { workDate: addDays(W1, 1), hours: 3 });
  });
});
afterAll(closePools);

describe('timesheets', () => {
  let sheet: any;

  it('weeks start on Monday', () => {
    expect([weekStartOf('2026-10-21'), weekStartOf('2026-10-19'), weekStartOf('2026-10-25')]).toEqual(['2026-10-19', '2026-10-19', '2026-10-19']);
  });

  it('a draft shows work-order hours live; other time is added by the employee', async () => {
    sheet = await open(w.techA, addDays(W1, 3));
    expect(sheet.week_start).toBe(W1);
    await asActor(w.techA, async (tx) => {
      await addEntry(tx, w.techA, sheet.id, { workDate: W1, earningCode: 'REG', hours: 8, note: 'LOTO refresher and shop meeting' });
      await addEntry(tx, w.techA, sheet.id, { workDate: addDays(W1, 1), earningCode: 'REG', hours: 5 });
      await addEntry(tx, w.techA, sheet.id, { workDate: addDays(W1, 2), earningCode: 'PTO', hours: 8 });
    });
    await expect(asActor(w.techA, (tx) => addEntry(tx, w.techA, sheet.id, { workDate: addDays(W1, 7), earningCode: 'REG', hours: 1 }))).rejects.toThrow(/outside this week/);
    await expect(asActor(w.techA, (tx) => addEntry(tx, w.techA, sheet.id, { workDate: W1, earningCode: 'BONUS', hours: 1 }))).rejects.toThrow(/unknown earning code/);
    const v = await view(w.techA, sheet.id);
    expect(v).toMatchObject({ total: 24, worked: 16, workOrderHours: 3, warnings: [] });
    expect(v.entries.find((e: any) => e.source === 'work_order')).toMatchObject({ earning_code: 'REG', hours: 3, work_order_id: woId });
    expect(v.byCode).toEqual([{ code: 'PTO', label: 'Paid time off', hours: 8 }, { code: 'REG', label: 'Regular hours', hours: 16 }]);
  });

  it('only the employee and their supervisors can see a timesheet', async () => {
    await expect(view(w.tech2A, sheet.id)).rejects.toThrow(/timesheet/);
    await expect(view(w.operatorB, sheet.id)).rejects.toThrow();
    expect((await view(w.managerA, sheet.id)).employee_number).toBe('E100');
  });

  it('submitting freezes the week: work-order hours are copied in and no more labor can be booked to it', async () => {
    await asActor(w.techA, (tx) => submitTimesheet(tx, w.techA, sheet.id));
    const v = await view(w.techA, sheet.id);
    expect(v.entries.filter((e: any) => e.source === 'work_order')).toHaveLength(1);
    await expect(asActor(w.techA, (tx) => addLabor(tx, w.techA, woId, { workDate: addDays(W1, 3), hours: 1 }))).rejects.toThrow(/timesheet for the week of .* is submitted/);
    await expect(asActor(w.techA, (tx) => addEntry(tx, w.techA, sheet.id, { workDate: W1, earningCode: 'REG', hours: 1 }))).rejects.toThrow(/submitted/);
  });

  it('a supervisor approves or rejects (with a reason); approved weeks are frozen in the database', async () => {
    await expect(asActor(w.techA, (tx) => decideTimesheet(tx, w.techA, sheet.id, { decision: 'approve' }))).rejects.toThrow(/time.approve/);
    await expect(asActor(w.managerA, (tx) => decideTimesheet(tx, w.managerA, sheet.id, { decision: 'reject' }))).rejects.toThrow(/what needs fixing/);
    await asActor(w.managerA, (tx) => decideTimesheet(tx, w.managerA, sheet.id, { decision: 'reject', comment: 'Tuesday: 5 h shop time plus 3 h on the WO is 8; was it 5 total?' }));
    // A week sent back counts manual time plus live work-order hours once (8 + 5 + 8 + 3), not the submitted copy twice.
    expect((await asActor(w.managerA, (tx) => teamWeek(tx, w.managerA, W1))).find((t) => t.employee_number === 'E100')).toMatchObject({ status: 'rejected', hours: 24 });
    // Rejected: editable again, and work-order hours are live again.
    const entry = (await view(w.techA, sheet.id)).entries.find((e: any) => e.source === 'manual' && e.hours === 5);
    await asActor(w.techA, async (tx) => {
      await removeEntry(tx, w.techA, entry.id);
      await addEntry(tx, w.techA, sheet.id, { workDate: addDays(W1, 1), earningCode: 'REG', hours: 2 });
      await submitTimesheet(tx, w.techA, sheet.id);
    });
    await asActor(w.managerA, (tx) => decideTimesheet(tx, w.managerA, sheet.id, { decision: 'approve' }));
    expect((await view(w.techA, sheet.id))).toMatchObject({ status: 'approved', total: 21 });
    await expect(getAdminPool().query(`DELETE FROM time_entry WHERE timesheet_id = $1`, [sheet.id])).rejects.toThrow(/timesheet is approved/);
  });

  it('an approver can reopen an approved week that has not gone to payroll', async () => {
    await asActor(w.managerA, (tx) => reopenTimesheet(tx, w.managerA, sheet.id, 'Forgot the Friday call-in'));
    await asActor(w.techA, async (tx) => {
      await addEntry(tx, w.techA, sheet.id, { workDate: addDays(W1, 4), earningCode: 'REG', hours: 2, note: 'Call-in, compressor alarm' });
      await submitTimesheet(tx, w.techA, sheet.id);
    });
    await asActor(w.managerA, (tx) => decideTimesheet(tx, w.managerA, sheet.id, { decision: 'approve' }));
  });

  it('time entered on someone\'s behalf needs a second approver; long weeks are flagged for overtime review', async () => {
    const s2 = await open(w.managerA, W1, w.tech2AEmployeeId);
    await asActor(w.managerA, async (tx) => {
      for (let d = 0; d < 5; d++) await addEntry(tx, w.managerA, s2.id, { workDate: addDays(W1, d), earningCode: 'REG', hours: d === 4 ? 10 : 9, note: 'from paper timecard' });
      await submitTimesheet(tx, w.managerA, s2.id);
    });
    const v = await view(w.managerA, s2.id);
    expect(v.warnings).toEqual([expect.stringMatching(/46 worked hours this week, over 40/)]);
    await expect(asActor(w.managerA, (tx) => decideTimesheet(tx, w.managerA, s2.id, { decision: 'approve' }))).rejects.toThrow(/another approver/);
    await asActor(w.dualA, (tx) => decideTimesheet(tx, w.dualA, s2.id, { decision: 'approve' }));
    const team = await asActor(w.managerA, (tx) => teamWeek(tx, w.managerA, W1));
    expect(team.map((t) => [t.employee_number, t.status, t.hours])).toEqual([['E101', 'approved', 46], ['E100', 'approved', 23]]); // by last name
  });
});

describe('payroll export', () => {
  it('previews what is ready, exports approved weeks with mapped codes, and freezes them', async () => {
    await asActor(payroll, (tx) => setEarningCode(tx, payroll, 'PTO', { externalCode: 'VAC' }));
    const p = await asActor(payroll, (tx) => payrollPreview(tx, payroll, { from: W0, to: W1 }));
    expect(p.ready).toHaveLength(2);
    expect(p.notReady.map((n: any) => [n.week_start, n.employee_number, n.status])).toEqual([[W0, 'E100', 'not_started'], [W0, 'E101', 'not_started']]);
    await expect(asActor(w.managerA, (tx) => payrollPreview(tx, w.managerA, { from: W0, to: W1 }))).rejects.toThrow(/time.export/);
    const ex = await asActor(payroll, (tx) => createPayrollExport(tx, payroll, { from: W0, to: W1, layout: 'summary' }));
    expect(ex).toMatchObject({ timesheets: 2, notReady: 2, row_count: 3 });
    const csv = (await getAdminPool().query('SELECT content FROM payroll_export WHERE id = $1', [ex.id])).rows[0].content;
    expect(csv).toContain(`E100,Shah,Priya,A,${W1},REG,15`);
    expect(csv).toContain(`E100,Shah,Priya,A,${W1},VAC,8`);
    expect(csv).toContain(`E101,Ortega,Luis,A,${W1},REG,46`);
    const sheet = await asActor(w.techA, (tx) => getOrCreateTimesheet(tx, w.techA, { weekStart: W1 }));
    expect(sheet.status).toBe('exported');
    await expect(asActor(w.managerA, (tx) => reopenTimesheet(tx, w.managerA, sheet.id, 'late correction'))).rejects.toThrow(/already with payroll/);
    await expect(asActor(payroll, (tx) => createPayrollExport(tx, payroll, { from: W0, to: W1 }))).rejects.toThrow(/no approved timesheets/);
  });

  it('the time report shows completion, wrench time and overtime-review weeks', async () => {
    const def = getReport('labor-time')!;
    const r = await asActor(w.managerA, (tx) => def.run(tx, w.managerA, def.params.parse({ weeks: 2 })));
    expect(r.kpis.find((k) => k.label === 'Timesheets approved')).toMatchObject({ value: 0.5, note: '2 of 4' });
    expect(r.kpis.find((k) => k.label === 'Overtime review')!.value).toBe(1);
    const priya = r.rows.find((x) => x.employee_number === 'E100')!;
    expect(priya).toMatchObject({ worked: 15, leave: 8, wo_hours: 3, wrench_time: 0.2, missing_weeks: 1 });
  });
});
