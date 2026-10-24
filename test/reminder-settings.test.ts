import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { asActor } from '../src/platform/auth/actor.js';
import { closePools, getAdminPool } from '../src/platform/db/pool.js';
import { REMINDERS } from '../src/modules/reminders/catalogue.js';
import { listReminders, setReminder, setReminderEditors } from '../src/modules/reminders/settings.js';
import { runReminders } from '../src/modules/notifications/reminders.js';
import { createAsset } from '../src/modules/assets/service.js';
import type { World } from './fixtures.js';
import { makeWorld } from './fixtures.js';

/** Reminder settings (D-153). */
let app: FastifyInstance; let w: World;
const db = () => getAdminPool();
const TODAY = '2027-03-10'; // a Wednesday
const plus = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const sent = async (kind: string) => Number((await db().query('SELECT count(*)::int AS n FROM notification WHERE tenant_id = $1 AND kind = $2', [w.tenantId, `reminder.${kind}`])).rows[0].n);
const set = (key: string, v: { enabled?: boolean; leadDays?: number | null; repeat?: 'daily' | 'weekly' | 'once' }, who = w.admin) => {
  const d = REMINDERS.find((r) => r.key === key)!;
  return asActor(who, (tx) => setReminder(tx, who, key, { enabled: v.enabled ?? true, leadDays: v.leadDays ?? d.lead?.default ?? null, repeat: v.repeat ?? d.repeat }));
};

beforeAll(async () => {
  app = buildApp();
  w = await makeWorld('remset');
});
afterAll(async () => { await app.close(); await closePools(); });

describe('the catalogue', () => {
  it('lists every reminder the sweep sends, and every one it checks', () => {
    const src = ['src/modules/notifications/reminders.ts', 'src/modules/chemicals/alerts.ts'].map((f) => readFileSync(f, 'utf8')).join('\n');
    const keys = new Set(REMINDERS.map((r) => r.key));
    const used = new Set([...src.matchAll(/add\('([a-z_]+)'/g), ...src.matchAll(/R\.(?:on|lead|period)\('([a-z_]+)'\)/g)].map((m) => m[1]!));
    expect([...used].filter((k) => !keys.has(k))).toEqual([]);
    expect([...keys].filter((k) => !used.has(k))).toEqual([]);
    expect(REMINDERS.length).toBeGreaterThanOrEqual(33);
    for (const r of REMINDERS) {
      expect(r.repeats).toContain(r.repeat);
      if (r.lead) { expect(r.when.includes('{lead}')).toBe(true); expect(r.lead.default).toBeGreaterThanOrEqual(r.lead.min); expect(r.lead.default).toBeLessThanOrEqual(r.lead.max); }
    }
  });
});

describe('who may change a reminder', () => {
  it('administrators see and change all; managers of an area only theirs; others none', async () => {
    const all = await asActor(w.admin, (tx) => listReminders(tx, w.admin));
    expect(all.reminders).toHaveLength(REMINDERS.length);
    expect(all.reminders.every((r) => r.canEdit)).toBe(true);
    const q = await asActor(w.qualityA, (tx) => listReminders(tx, w.qualityA));
    expect(q.admin).toBe(false);
    expect(q.reminders.map((r) => r.key)).toEqual(expect.arrayContaining(['calibration_due', 'action_overdue', 'audit_planned']));
    expect(q.reminders.map((r) => r.key)).not.toContain('po_late');
    expect((await app.inject({ method: 'GET', url: '/api/reminder-settings', headers: { authorization: `Bearer ${w.tokens.techA}` } })).statusCode).toBe(403);
    expect((await app.inject({ method: 'GET', url: '/api/me', headers: { authorization: `Bearer ${w.tokens.qualityA}` } })).json().remindersEditable).toBe(true);
    expect((await app.inject({ method: 'GET', url: '/api/me', headers: { authorization: `Bearer ${w.tokens.techA}` } })).json().remindersEditable).toBe(false);
    await set('calibration_due', { leadDays: 21 }, w.qualityA);
    await expect(set('po_late', { repeat: 'daily' }, w.qualityA)).rejects.toThrow(/purchasing.manage/);
  });

  it('an administrator can hand a reminder to chosen roles instead', async () => {
    await asActor(w.admin, (tx) => setReminderEditors(tx, w.admin, 'calibration_due', ['ehs_reviewer']));
    await expect(set('calibration_due', { leadDays: 30 }, w.qualityA)).rejects.toThrow(/ehs_reviewer/);
    await set('calibration_due', { leadDays: 30 }, w.ehsA);
    await expect(asActor(w.qualityA, (tx) => setReminderEditors(tx, w.qualityA, 'calibration_due', null))).rejects.toThrow(/tenant.admin/);
    await asActor(w.admin, (tx) => setReminderEditors(tx, w.admin, 'calibration_due', null));
    await set('calibration_due', { leadDays: 14 }, w.qualityA);
    const n = Number((await db().query(`SELECT count(*)::int AS n FROM audit_event WHERE tenant_id = $1 AND action IN ('reminder.setting_set', 'reminder.editors_set')`, [w.tenantId])).rows[0].n);
    expect(n).toBe(5);
  });

  it('keeps settings within the catalogue’s limits', async () => {
    await expect(set('training_due', { leadDays: 400 })).rejects.toThrow(/0 to 90 days/);
    await expect(set('timesheet_missing', { repeat: 'daily' })).rejects.toThrow(/can repeat weekly/);
  });
});

describe('the sweep follows the settings', () => {
  it('a reminder turned off is not sent, and comes back when turned on', async () => {
    await db().query(`INSERT INTO budget (tenant_id, fiscal_year, name, start_month, created_by) VALUES ($1, 2027, 'FY27', 4, $2)`, [w.tenantId, w.admin.userId]);
    // FY2027 starts April 2026, so FY2028 starts 2027-04-01: 22 days after TODAY, inside the default 60.
    await set('budget_due', { enabled: false });
    await runReminders(w.tenantId, TODAY);
    expect(await sent('budget_due')).toBe(0);
    await set('budget_due', { enabled: true });
    await runReminders(w.tenantId, TODAY);
    expect(await sent('budget_due')).toBeGreaterThan(0);
  });

  it('the lead decides how far ahead, and repeat how often', async () => {
    await db().query(`INSERT INTO external_credential (tenant_id, employee_id, name, issuer, expires_on, recorded_by) VALUES ($1, $2, 'Forklift licence', 'State board', $3, $4)`,
      [w.tenantId, w.techAEmployeeId, plus(TODAY, 60), w.admin.userId]);
    await runReminders(w.tenantId, TODAY);
    expect(await sent('credential_expiring')).toBe(0); // 60 days away, default lead 30
    await set('credential_expiring', { leadDays: 90, repeat: 'weekly' });
    await runReminders(w.tenantId, TODAY);
    const weekly = await sent('credential_expiring');
    expect(weekly).toBeGreaterThan(0); // the holder and training administrators
    await runReminders(w.tenantId, plus(TODAY, 1)); // same week: not repeated
    expect(await sent('credential_expiring')).toBe(weekly);
    await set('credential_expiring', { leadDays: 90, repeat: 'daily' });
    await runReminders(w.tenantId, plus(TODAY, 2));
    expect(await sent('credential_expiring')).toBe(weekly * 2);
  });

  it('stops while its feature is off for everyone', async () => {
    const asset = await asActor(w.admin, (tx) => createAsset(tx, w.admin, { facilityId: w.facilities.A!, assetTag: 'PRESS-7', name: 'Press', warrantyExpiresOn: plus(TODAY, 30) }));
    await asActor(w.admin, async (tx) => (await import('../src/modules/features/service.js')).setFeature(tx, w.admin, 'assets', { mode: 'off' }));
    await runReminders(w.tenantId, TODAY);
    expect(await sent('warranty_expiring')).toBe(0);
    await asActor(w.admin, async (tx) => (await import('../src/modules/features/service.js')).setFeature(tx, w.admin, 'assets', { mode: 'all' }));
    (await import('../src/platform/features.js')).forgetFeatures();
    await runReminders(w.tenantId, TODAY);
    expect(await sent('warranty_expiring')).toBeGreaterThan(0);
    expect(asset).toBeTruthy();
  });
});

describe('reminders that did not exist before', () => {
  it('contractor insurance, audits coming up', async () => {
    await db().query(`INSERT INTO supplier (tenant_id, code, name, trades, insurance_expires_on) VALUES ($1, 'SPARKY', 'Sparky Electric', '{electrical}', $2)`, [w.tenantId, plus(TODAY, 10)]);
    await db().query(`INSERT INTO quality_audit (tenant_id, facility_id, number, title, scope, planned_on, lead_auditor_id, created_by) VALUES ($1, $2, 'AUD-9', 'Receiving', 'ISO 9001 8.4', $3, $4, $4)`,
      [w.tenantId, w.facilities.A, plus(TODAY, 5), w.qualityA.userId]);
    await runReminders(w.tenantId, TODAY);
    expect(await sent('insurance_expiring')).toBeGreaterThan(0);
    expect(await sent('audit_planned')).toBe(1);
  });
});
