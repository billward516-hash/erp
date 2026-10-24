import type { Tx } from '../../platform/db/tx.js';
import { many } from '../../platform/db/tx.js';
import { notify, usersWithPermission } from '../../platform/notify/notify.js';
import { REMINDER_BY_KEY } from '../reminders/catalogue.js';
import { retainerReminders } from '../retainers/service.js';
import { getSettings, loadRates, money } from './rates.js';
import { collect } from './sources.js';

type Sweep = { on: (k: string) => boolean; lead: (k: string) => number; period: (k: string) => string };
const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const daysBetween = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);

/** Approved, billable, unheld, rated work dated before the cutoff, by project: what the reminder and What is late both report. */
export async function staleUnbilled(tx: Tx, facilityIds: string[], cutoff: string, today: string) {
  const c = await collect(tx, { facilityIds, customerId: null, projectId: null, from: null, to: cutoff }, await getSettings(tx), await loadRates(tx), today);
  return c.items.filter((i) => !i.held && !i.blocked && i.kind !== 'percent' && i.date <= cutoff);
}

/** The daily sweep's service-company reminders (SC-009): unbilled work, retainer renewals, failed retainer invoices. */
export async function serviceReminders(tx: Tx, tenantId: string, today: string, R: Sweep) {
  const out = { unbilled_time: 0, retainer_renewal: 0, retainer_failed: 0 };
  if (R.on('unbilled_time')) {
    const lead = R.lead('unbilled_time');
    const cutoff = addDays(today, -lead);
    for (const f of await many(tx, 'SELECT id, code FROM facility')) {
      const stale = await staleUnbilled(tx, [f.id], cutoff, today);
      if (!stale.length) continue;
      const value = money(stale.reduce((s, i) => s + i.listAmount, 0));
      const oldest = stale.reduce((m, i) => (i.date < m ? i.date : m), stale[0]!.date);
      out.unbilled_time += await notify(tx, tenantId, await usersWithPermission(tx, 'billing.manage', f.id), { kind: 'reminder.unbilled_time',
        title: `${stale.length} approved item${stale.length === 1 ? '' : 's'} at ${f.code} waiting more than ${lead} days to be billed, ${value.toFixed(2)} USD`,
        body: `The oldest is from ${oldest}. Start a billing run for the customer, or hold what should not be billed yet.`, link: '/billing?tab=unbilled', dedupeKey: `unbilled:${f.id}:${R.period('unbilled_time')}` });
    }
  }
  const r = await retainerReminders(tx, tenantId, today, R);
  out.retainer_renewal = r.renewals; out.retainer_failed = r.failed;
  return out;
}

/** What is late (billing): the same stale work, one row per project, with the project owner. */
export async function lateUnbilled(tx: Tx, facilityIds: string[], today: string) {
  const lead = REMINDER_BY_KEY.get('unbilled_time')!.lead!.default;
  const cutoff = addDays(today, -lead);
  const stale = await staleUnbilled(tx, facilityIds, cutoff, today);
  const by = new Map<string, { projectId: string; number: string; name: string; n: number; value: number; oldest: string }>();
  for (const i of stale) {
    if (!i.projectId) continue;
    const g = by.get(i.projectId) ?? { projectId: i.projectId, number: i.projectNumber ?? '', name: i.projectName ?? '', n: 0, value: 0, oldest: i.date };
    g.n++; g.value = money(g.value + i.listAmount); if (i.date < g.oldest) g.oldest = i.date;
    by.set(i.projectId, g);
  }
  if (!by.size) return [];
  const meta = await many(tx, `SELECT p.id, c.name AS customer, u.display_name AS owner FROM project p LEFT JOIN customer c ON c.id = p.customer_id LEFT JOIN app_user u ON u.id = p.owner_user_id WHERE p.id = ANY ($1)`, [[...by.keys()]]);
  const m = new Map(meta.map((x) => [x.id as string, x]));
  return [...by.values()].map((g) => ({ label: `${g.number} · ${m.get(g.projectId)?.customer ?? 'Customer'}`, detail: `${g.n} approved item${g.n === 1 ? '' : 's'} not yet billed, oldest ${g.oldest}`, owner: (m.get(g.projectId)?.owner as string | null) ?? null,
    daysLate: Math.max(0, daysBetween(g.oldest, today) - lead), amount: g.value, href: '/billing?tab=unbilled' })).sort((a, b) => b.daysLate - a.daysLate);
}
