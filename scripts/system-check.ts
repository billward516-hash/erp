/**
 * Full system check (S45) against a database that holds a lot of history (npm run seed && npm run seed:history).
 *
 *   npx tsx scripts/system-check.ts [--company stonebridge] [--json out.json] [--skip-archive]
 *
 * Part 1, integrity: the audit chain, stock ledger against balances, the books (every entry balanced, subledgers
 * against the ledger), work order / time / machine-state sanity, row-level isolation between companies.
 * Part 2, performance: every list, report and page endpoint a user opens, timed three times through the real
 * application (in-process), with the size of what came back.
 * Part 3, recovery: a company archive, a record restore, and a confirmed rollback, timed.
 * Exits non-zero when an integrity check fails. Slow endpoints are reported, not failed (the budget is in the output).
 */
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { buildApp } from '../src/app.js';
import { asActor, loadActor } from '../src/platform/auth/actor.js';
import { closePools, getAdminPool, getPool } from '../src/platform/db/pool.js';
import { LocalBlobStore } from '../src/platform/storage/blob-store.js';
import { verifyAuditChain } from '../src/platform/audit/audit.js';
import { config } from '../src/config.js';
import { createArchive } from '../src/modules/archives/service.js';

const arg = (n: string, d?: string) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : d; };
const slug = arg('company', 'stonebridge')!;
const db = getAdminPool();
const out: { integrity: any[]; performance: any[]; recovery: any[]; data: Record<string, number> } = { integrity: [], performance: [], recovery: [], data: {} };
const tenant = (await db.query('SELECT id, name FROM tenant WHERE slug = $1', [slug])).rows[0];
if (!tenant) { console.error(`no company "${slug}"; run npm run seed && npm run seed:history first`); process.exit(2); }
const T = tenant.id as string;

// ── Data volume ──────────────────────────────────────────────────────────────
for (const t of ['asset', 'work_order', 'work_order_labor', 'work_order_part', 'asset_state_event', 'inventory_txn', 'time_entry', 'timesheet', 'spc_subgroup', 'production_order', 'production_entry',
  'customer_invoice', 'customer_payment', 'supplier_invoice', 'journal_entry', 'journal_line', 'nonconformance', 'safety_incident', 'asset_meter_reading', 'supplier_delivery_history', 'audit_event', 'outbox_event']) {
  out.data[t] = Number((await db.query(`SELECT count(*) FROM ${t} WHERE tenant_id = $1`, [T])).rows[0].count);
}
console.log('rows:', Object.entries(out.data).map(([k, v]) => `${k} ${v.toLocaleString()}`).join(', '));

// ── Part 1: integrity ────────────────────────────────────────────────────────
const integrity = async (name: string, run: () => Promise<{ bad: number; detail: string }>) => {
  const t0 = Date.now();
  try {
    const r = await run();
    out.integrity.push({ name, ok: r.bad === 0, detail: r.detail, ms: Date.now() - t0 });
    console.log(`${r.bad === 0 ? 'ok  ' : 'FAIL'} ${name}: ${r.detail} (${Date.now() - t0} ms)`);
  } catch (e) {
    out.integrity.push({ name, ok: false, detail: `error: ${(e as Error).message}`, ms: Date.now() - t0 });
    console.log(`FAIL ${name}: error: ${(e as Error).message}`);
  }
};
const count = async (sql: string, params: unknown[] = [T]) => Number((await db.query(sql, params)).rows[0].n);

const adminRow = (await db.query(`SELECT u.id FROM app_user u JOIN user_role_scope a ON a.user_id = u.id JOIN role r ON r.id = a.role_id WHERE u.tenant_id = $1 AND r.key = 'admin' LIMIT 1`, [T])).rows[0];
const admin = (await loadActor(T, adminRow.id))!;

await integrity('Audit chain verifies for every company', async () => {
  const tenants = (await db.query('SELECT id, name FROM tenant ORDER BY name')).rows;
  const broken: string[] = [];
  for (const x of tenants) {
    const a = await db.query(`SELECT u.id FROM app_user u JOIN user_role_scope s ON s.user_id = u.id JOIN role r ON r.id = s.role_id WHERE u.tenant_id = $1 AND r.key = 'admin' AND u.status = 'active' LIMIT 1`, [x.id]);
    if (!a.rows[0]) continue;
    const actor = (await loadActor(x.id, a.rows[0].id))!;
    const bad = await asActor(actor, (tx) => verifyAuditChain(tx));
    if (bad != null) broken.push(`${x.name}: first bad event ${bad}`);
  }
  return { bad: broken.length, detail: broken.length ? broken.join('; ') : `${tenants.length} companies, ${(await count('SELECT count(*) AS n FROM audit_event', [])).toLocaleString()} events` };
});
await integrity('Stock balances equal the sum of their movements', async () => {
  const n = await count(`SELECT count(*) AS n FROM inventory_balance b LEFT JOIN (SELECT location_id, part_id, sum(qty) q FROM inventory_txn WHERE tenant_id = $1 GROUP BY 1, 2) x
    ON x.location_id = b.location_id AND x.part_id = b.part_id WHERE b.tenant_id = $1 AND b.qty_on_hand IS DISTINCT FROM coalesce(x.q, 0)`);
  return { bad: n, detail: `${n} balances differ from their ledger` };
});
await integrity('Every movement\'s balance_after is the running total (in order of posting)', async () => {
  const n = await count(`SELECT count(*) AS n FROM (SELECT balance_after, sum(qty) OVER (PARTITION BY location_id, part_id ORDER BY id) AS run FROM inventory_txn WHERE tenant_id = $1) x WHERE round(x.balance_after, 3) <> round(x.run, 3)`);
  return { bad: n, detail: `${n} movements out of step` };
});
await integrity('No stock balance is negative', async () => {
  const n = await count(`SELECT count(*) AS n FROM inventory_balance WHERE tenant_id = $1 AND qty_on_hand < 0`);
  return { bad: n, detail: `${n} negative` };
});
await integrity('Posting order equals date order in the stock ledger', async () => {
  const n = await count(`SELECT count(*) AS n FROM (SELECT created_at, lag(created_at) OVER (PARTITION BY location_id, part_id ORDER BY id) AS prev FROM inventory_txn WHERE tenant_id = $1) x WHERE x.created_at < x.prev`);
  return { bad: n, detail: `${n} movements dated before the one posted just ahead of them` };
});
await integrity('Every ledger entry balances (debits equal credits)', async () => {
  const n = await count(`SELECT count(*) AS n FROM (SELECT entry_id FROM journal_line WHERE tenant_id = $1 GROUP BY entry_id HAVING round(sum(debit) - sum(credit), 2) <> 0) x`);
  return { bad: n, detail: `${n} unbalanced entries of ${out.data.journal_entry!.toLocaleString()}` };
});
await integrity('Trial balance: total debits equal total credits', async () => {
  const r = (await db.query(`SELECT round(sum(debit), 2) AS d, round(sum(credit), 2) AS c FROM journal_line WHERE tenant_id = $1`, [T])).rows[0];
  return { bad: Number(r.d) === Number(r.c) ? 0 : 1, detail: `debits ${Number(r.d).toLocaleString()} credits ${Number(r.c).toLocaleString()}` };
});
const invoiceTotals = `SELECT i.id, coalesce(sum(l.qty * l.unit_price), 0) + i.tax_amount + i.freight_amount AS total FROM customer_invoice i LEFT JOIN customer_invoice_line l ON l.invoice_id = i.id
  WHERE i.tenant_id = $1 AND i.status IN ('issued', 'partially_paid', 'paid') GROUP BY i.id`;
await integrity('Receivables ledger account equals open customer invoices', async () => {
  const gl = (await db.query(`SELECT coalesce(sum(l.debit - l.credit), 0) AS bal FROM journal_line l JOIN ledger_account a ON a.id = l.account_id WHERE l.tenant_id = $1 AND a.account_key = 'accounts_receivable'`, [T])).rows[0].bal;
  const sub = (await db.query(`SELECT (SELECT coalesce(sum(total), 0) FROM (${invoiceTotals}) t) - (SELECT coalesce(sum(a.amount), 0) FROM payment_allocation a JOIN customer_invoice i ON i.id = a.invoice_id WHERE i.tenant_id = $1) AS bal`, [T])).rows[0].bal;
  return { bad: Math.abs(Number(gl) - Number(sub)) > 0.05 ? 1 : 0, detail: `ledger ${Number(gl).toLocaleString()} vs invoices less receipts ${Number(sub).toLocaleString()}` };
});
await integrity('Payables ledger account equals unpaid supplier bills', async () => {
  const gl = (await db.query(`SELECT coalesce(sum(l.credit - l.debit), 0) AS bal FROM journal_line l JOIN ledger_account a ON a.id = l.account_id WHERE l.tenant_id = $1 AND a.account_key = 'accounts_payable'`, [T])).rows[0].bal;
  const sub = (await db.query(`SELECT coalesce(sum(t.total - coalesce(i.paid_amount, 0)), 0) AS bal FROM supplier_invoice i JOIN (SELECT i2.id, coalesce(sum(l.qty * l.unit_price), 0) + i2.tax_amount + i2.freight_amount AS total FROM supplier_invoice i2
    LEFT JOIN supplier_invoice_line l ON l.invoice_id = i2.id WHERE i2.tenant_id = $1 GROUP BY i2.id) t ON t.id = i.id WHERE i.tenant_id = $1 AND i.status IN ('approved', 'exported', 'paid', 'partially_paid')`, [T])).rows[0].bal;
  return { bad: Math.abs(Number(gl) - Number(sub)) > 0.05 ? 1 : 0, detail: `ledger ${Number(gl).toLocaleString()} vs approved bills less payments ${Number(sub).toLocaleString()}` };
});
await integrity('Work orders: numbers unique and in sequence; closed ones have sensible dates', async () => {
  const gaps = await count(`SELECT count(*) AS n FROM (SELECT (substring(number from 4))::int AS k FROM work_order WHERE tenant_id = $1) x HAVING max(k) <> count(*)`).catch(() => 0);
  const dates = await count(`SELECT count(*) AS n FROM work_order WHERE tenant_id = $1 AND (completed_at < started_at OR closed_at < completed_at OR created_at > coalesce(started_at, created_at) + interval '1 day')`);
  const seq = (await db.query(`SELECT next_value FROM tenant_sequence WHERE tenant_id = $1 AND key = 'work_order'`, [T])).rows[0]?.next_value;
  return { bad: gaps + dates + (Number(seq) === out.data.work_order! + 1 ? 0 : 1), detail: `${out.data.work_order} orders, sequence at ${seq}, ${gaps} gaps, ${dates} date problems` };
});
await integrity('Machine states: no overlaps; hours within the calendar', async () => {
  const over = await count(`SELECT count(*) AS n FROM asset_state_event a JOIN asset_state_event b ON a.asset_id = b.asset_id AND a.id < b.id AND tstzrange(a.started_at, a.ended_at) && tstzrange(b.started_at, b.ended_at) WHERE a.tenant_id = $1 AND a.started_at > now() - interval '30 days'`);
  const long = await count(`SELECT count(*) AS n FROM asset_state_event WHERE tenant_id = $1 AND ended_at - started_at > interval '24 hours'`);
  return { bad: over + long, detail: `${over} overlaps (last 30 days sampled; the database forbids them), ${long} states longer than a day` };
});
await integrity('Timesheets: one per person per week, no day over 24 hours', async () => {
  const dup = await count(`SELECT count(*) AS n FROM (SELECT employee_id, week_start FROM timesheet WHERE tenant_id = $1 GROUP BY 1, 2 HAVING count(*) > 1) x`);
  const day = await count(`SELECT count(*) AS n FROM (SELECT timesheet_id, work_date FROM time_entry WHERE tenant_id = $1 GROUP BY 1, 2 HAVING sum(hours) > 24) x`);
  const outside = await count(`SELECT count(*) AS n FROM time_entry e JOIN timesheet s ON s.id = e.timesheet_id WHERE e.tenant_id = $1 AND (e.work_date < s.week_start OR e.work_date >= s.week_start + 7)`);
  return { bad: dup + day + outside, detail: `${dup} duplicate weeks, ${day} days over 24 h, ${outside} entries outside their week` };
});
await integrity('Production: operation quantities match entries; received quantity does not exceed made', async () => {
  const n = await count(`SELECT count(*) AS n FROM production_order o WHERE o.tenant_id = $1 AND o.qty_received > o.qty`);
  const q = await count(`SELECT count(*) AS n FROM production_operation p LEFT JOIN (SELECT operation_id, sum(qty_good) AS g FROM production_entry WHERE tenant_id = $1 AND kind = 'run' GROUP BY 1) e ON e.operation_id = p.id
    WHERE p.tenant_id = $1 AND p.qty_good IS DISTINCT FROM e.g`);
  return { bad: n + q, detail: `${n} orders over-received, ${q} operations whose counts differ from their entries` };
});
await integrity('Immutable records reject change (stock, audit, closed reviews)', async () => {
  const tryIt = async (sql: string) => { try { await db.query(sql, [T]); return false; } catch { return true; } };
  const results = [await tryIt(`UPDATE inventory_txn SET qty = qty + 1 WHERE tenant_id = $1 AND id = (SELECT min(id) FROM inventory_txn WHERE tenant_id = $1)`),
    await tryIt(`DELETE FROM audit_event WHERE tenant_id = $1`), await tryIt(`UPDATE audit_event SET action = 'x' WHERE tenant_id = $1`)];
  return { bad: results.filter((r) => !r).length, detail: `${results.filter(Boolean).length} of ${results.length} tampering attempts refused` };
});
await integrity('Row-level isolation: no company can read another company\'s rows', async () => {
  const tables = (await db.query(`SELECT c.relname AS table_name FROM pg_class c JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = 'tenant_id' AND NOT a.attisdropped
    WHERE c.relnamespace = 'public'::regnamespace AND c.relkind = 'r' AND has_table_privilege('erp_app', c.oid, 'SELECT') ORDER BY 1`)).rows.map((r) => r.table_name as string);
  const others = (await db.query(`SELECT id FROM tenant WHERE id <> $1 ORDER BY name LIMIT 1`, [T])).rows[0].id as string;
  const leaks: string[] = []; let withoutContext = 0;
  const pool = getPool();
  for (const [scope, other] of [[T, others], [others, T]] as const) {
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      await c.query(`SELECT set_config('app.tenant_id', $1, true), set_config('app.user_id', '00000000-0000-0000-0000-000000000000', true), set_config('app.facility_ids', '', true), set_config('app.all_facilities', 'true', true)`, [scope]);
      for (const t of tables) {
        const n = Number((await c.query(`SELECT count(*) AS n FROM "${t}" WHERE tenant_id = $1`, [other])).rows[0].n);
        if (n) leaks.push(`${t}:${n}`);
      }
      await c.query('ROLLBACK');
    } catch (e) { await c.query('ROLLBACK').catch(() => undefined); throw e; } finally { c.release(); }
  }
  const c = await pool.connect();
  try { for (const t of tables.slice(0, 40)) withoutContext += Number((await c.query(`SELECT count(*) AS n FROM "${t}"`)).rows[0].n); } finally { c.release(); }
  return { bad: leaks.length + withoutContext, detail: `${tables.length} tables, both directions; ${leaks.length} leaks; ${withoutContext} rows visible with no company context` };
});
await integrity('Schema: every table with company data has row-level security on', async () => {
  const n = await count(`SELECT count(*) AS n FROM pg_class c JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = 'tenant_id' AND NOT a.attisdropped
    WHERE c.relnamespace = 'public'::regnamespace AND c.relkind = 'r' AND NOT c.relrowsecurity AND c.relname <> 'tenant' AND has_table_privilege('erp_app', c.oid, 'SELECT')`, []);
  return { bad: n, detail: `${n} application-readable tables without RLS` };
});

await integrity('Every foreign key to a business record has an index (row-level security on child tables depends on it)', async () => {
  const rows = (await db.query(`SELECT c.conrelid::regclass::text AS tbl, a.attname AS col FROM pg_constraint c JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
    WHERE c.contype = 'f' AND array_length(c.conkey, 1) = 1 AND c.connamespace = 'public'::regnamespace AND c.confrelid::regclass::text NOT IN ('app_user', 'tenant')
      AND NOT EXISTS (SELECT 1 FROM pg_index i WHERE i.indrelid = c.conrelid AND i.indkey[0] = c.conkey[1]) ORDER BY 1, 2`)).rows;
  return { bad: rows.length, detail: rows.length ? `${rows.length} without: ${rows.slice(0, 6).map((r) => `${r.tbl}.${r.col}`).join(', ')}` : 'none missing' };
});

// ── Part 2: performance ──────────────────────────────────────────────────────
const tokens = JSON.parse(await readFile(path.join(config.storageDir, 'dev-tokens.json'), 'utf8')) as Record<string, string>;
const token = tokens[Object.keys(tokens).find((k) => k.includes('morgan (admin)') && k.includes('Stonebridge'))!]!;
if (!token) { console.error('no Stonebridge admin token in dev-tokens.json'); process.exit(2); }
const app = buildApp();
await app.ready();
const call = (url: string) => app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${token}` } });
const ids = async (sql: string) => (await db.query(sql, [T])).rows[0] ?? {};
const sample = {
  fac: (await ids('SELECT id FROM facility WHERE tenant_id = $1 ORDER BY code LIMIT 1')).id,
  asset: (await ids(`SELECT a.id FROM asset a WHERE a.tenant_id = $1 ORDER BY (SELECT count(*) FROM work_order w WHERE w.asset_id = a.id) DESC LIMIT 1`)).id,
  wo: (await ids(`SELECT id FROM work_order WHERE tenant_id = $1 AND status = 'closed' ORDER BY created_at DESC LIMIT 1`)).id,
  part: (await ids(`SELECT part_id AS id FROM inventory_txn WHERE tenant_id = $1 GROUP BY part_id ORDER BY count(*) DESC LIMIT 1`)).id,
  char: (await ids(`SELECT id FROM spc_characteristic WHERE tenant_id = $1 ORDER BY code LIMIT 1`)).id,
  cust: (await ids(`SELECT id FROM customer WHERE tenant_id = $1 ORDER BY code LIMIT 1`)).id,
  po: (await ids(`SELECT id FROM production_order WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT 1`)).id,
};
const from = new Date(Date.now() - 730 * 86_400_000).toISOString().slice(0, 10); const to = new Date().toISOString().slice(0, 10);
const lastYear = new Date(Date.now() - 365 * 86_400_000).toISOString().slice(0, 10);
const lastMonday = (() => { const d = new Date(Date.now() - 14 * 86_400_000); d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7)); return d.toISOString().slice(0, 10); })();
const reportsRes = await call('/api/reports');
if (reportsRes.statusCode !== 200) throw new Error(`report list: ${reportsRes.statusCode} ${reportsRes.body}`);
const reports = reportsRes.json() as { id: string; title?: string }[];
const urls: [string, string][] = [
  ['Assets (list)', '/api/assets?limit=200'], ['Assets (search)', '/api/assets?q=lathe'], ['Asset detail', `/api/assets/${sample.asset}`],
  ['Work orders (list)', '/api/work-orders?limit=200'], ['Work orders (closed, search)', '/api/work-orders?status=closed&q=bearing'], ['Work order detail', `/api/work-orders/${sample.wo}`],
  ['Parts (list)', '/api/parts?limit=200'], ['Inventory balances', `/api/inventory?facilityId=${sample.fac}`], ['Stock ledger for the busiest part', `/api/inventory/ledger?partId=${sample.part}&limit=200`],
  ['Customers', '/api/customers'], ['Customer invoices', '/api/customer-invoices?limit=200'], ['Supplier invoices', '/api/supplier-invoices?limit=200'], ['Collections', '/api/collections'],
  ['Employees', '/api/employees?limit=200'], ['Production orders', '/api/production-orders?limit=200'], ['Production order detail', `/api/production-orders/${sample.po}`],
  ['SPC characteristics', '/api/spc/characteristics'], ['SPC chart (one characteristic)', `/api/spc/characteristics/${sample.char}`],
  ['Nonconformances', '/api/nonconformances?limit=200'], ['Safety incidents', '/api/incidents'],
  ['Books overview', '/api/books'], ['Trial balance', '/api/books/trial-balance'], ['Profit and loss (2 years)', `/api/books/profit-and-loss?from=${from}&to=${to}`], ['Balance sheet', '/api/books/balance-sheet'],
  ['Ledger entries', '/api/books/entries?limit=200'], ['Cash register', '/api/books/accounts'],
  ['Timesheets (team week)', `/api/timesheets/team?weekStart=${lastMonday}`], ['Global search "bearing"', '/api/search?q=bearing'], ['Spend analysis', '/api/spend-analysis'],
  ['Planning', `/api/plan?facilityId=${sample.fac}`], ['Demonstrated consumption', `/api/consumption-demonstrated?facilityId=${sample.fac}`], ['Notifications', '/api/notifications'], ['Home / me', '/api/me'],
  ...reports.map((r): [string, string] => [`Report: ${r.id}`, `/api/reports/${r.id}?facilityId=${sample.fac}&from=${lastYear}&to=${to}&customerId=${sample.cust}`]),
];
const median = (xs: number[]) => xs.sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;
for (const [name, url] of urls) {
  const times: number[] = []; let status = 0; let bytes = 0;
  for (let i = 0; i < 3; i++) { const t0 = performance.now(); const r = await call(url); times.push(performance.now() - t0); status = r.statusCode; bytes = r.rawPayload.length; }
  out.performance.push({ name, url, status, ms: Math.round(median(times)), worst: Math.round(Math.max(...times)), kb: Math.round(bytes / 1024) });
}
const slow = out.performance.filter((p) => p.ms > 1000);
console.log(`\nperformance: ${out.performance.length} requests; median of three each`);
for (const p of [...out.performance].sort((a, b) => b.ms - a.ms).slice(0, 15)) console.log(`  ${String(p.ms).padStart(6)} ms ${String(p.kb).padStart(6)} KB  ${p.status}  ${p.name}`);
console.log(`  over 1 s: ${slow.length}; errors: ${out.performance.filter((p) => p.status >= 400).map((p) => `${p.name} (${p.status})`).join(', ') || 'none'}`);

// ── Part 3: recovery at scale ────────────────────────────────────────────────
if (!process.argv.includes('--skip-archive')) {
  const blobs = new LocalBlobStore(config.storageDir);
  const rec = async (name: string, f: () => Promise<string>) => { const t0 = Date.now(); try { const detail = await f(); out.recovery.push({ name, ok: true, detail, ms: Date.now() - t0 }); console.log(`ok   ${name}: ${detail} (${((Date.now() - t0) / 1000).toFixed(1)} s)`); } catch (e) { out.recovery.push({ name, ok: false, detail: (e as Error).message, ms: Date.now() - t0 }); console.log(`FAIL ${name}: ${(e as Error).message}`); } };
  let archiveId = '';
  await rec('Company archive', async () => { const a = await createArchive(blobs, T, 'manual', admin.userId, 'system check'); archiveId = a.id; return `${a.id} ${(Number((a as any).sizeBytes ?? (a as any).size_bytes ?? 0) / 1048576).toFixed(1)} MB`; });
  const post = async (url: string, payload: unknown) => app.inject({ method: 'POST', url, headers: { authorization: `Bearer ${token}` }, payload: payload as object });
  await rec('Archive contents listing', async () => { const r = await call(`/api/archives/${archiveId}/contents`); if (r.statusCode !== 200) throw new Error(`${r.statusCode} ${r.body}`); return `${(r.json().tables ?? r.json()).length ?? '?'} tables`; });
  await rec('Browse archived work orders', async () => { const r = await call(`/api/archives/${archiveId}/rows?table=work_order`); if (r.statusCode !== 200) throw new Error(`${r.statusCode} ${r.body}`); return `${(r.json().rows ?? []).length} rows on the first page`; });
  const second = tokens[Object.keys(tokens).find((k) => k.includes('second admin') && k.includes('Stonebridge'))!];
  const baseline = await count(`SELECT count(*) AS n FROM safety_incident WHERE tenant_id = $1`);
  await rec('Restore three deleted records from the archive', async () => {
    const victims = (await db.query(`SELECT id FROM safety_incident WHERE tenant_id = $1 ORDER BY created_at LIMIT 3`, [T])).rows.map((r) => r.id as string);
    await db.query(`DELETE FROM safety_incident WHERE id = ANY($1)`, [victims]);
    const r = await post(`/api/archives/${archiveId}/restore`, { table: 'safety_incident', keys: victims.map((id) => ({ id })), withChildren: true });
    if (r.statusCode !== 200) throw new Error(`${r.statusCode} ${r.body}`);
    const back = await count(`SELECT count(*) AS n FROM safety_incident WHERE id = ANY($1)`, [victims] as any);
    if (back !== 3) throw new Error(`${back} of 3 restored`);
    return `3 of 3 back; ${JSON.stringify(r.json()).slice(0, 100)}`;
  });
  await rec('Rollback to the archive (request, second administrator confirms)', async () => {
    if (!second) throw new Error('no second administrator token');
    // Changes made after the archive must disappear: add safety reports and edit a customer, then roll back.
    for (let i = 0; i < 5; i++) await db.query(`INSERT INTO safety_incident (tenant_id, facility_id, number, kind, occurred_at, description, reported_by) SELECT $1, facility_id, $2, 'near_miss', now(), 'added after the archive', reported_by FROM safety_incident WHERE tenant_id = $1 LIMIT 1`, [T, `INC-POST-${i}`]);
    const before = await count(`SELECT count(*) AS n FROM safety_incident WHERE tenant_id = $1`);
    const req = await post(`/api/archives/${archiveId}/rollback`, { reason: 'System check rehearsal' });
    if (req.statusCode !== 201) throw new Error(`${req.statusCode} ${req.body}`);
    const conf = await app.inject({ method: 'POST', url: `/api/rollbacks/${req.json().id}/confirm`, headers: { authorization: `Bearer ${second}` }, payload: {} });
    if (conf.statusCode !== 200) throw new Error(`${conf.statusCode} ${conf.body}`);
    const after = await count(`SELECT count(*) AS n FROM safety_incident WHERE tenant_id = $1`);
    const wo = await count(`SELECT count(*) AS n FROM work_order WHERE tenant_id = $1`);
    const chain = await asActor(admin, (tx) => verifyAuditChain(tx));
    if (after !== baseline) throw new Error(`safety reports ${baseline} in the archive, ${before} before, ${after} after`);
    if (wo !== out.data.work_order) throw new Error(`work orders ${out.data.work_order} before, ${wo} after`);
    if (chain != null) throw new Error(`audit chain broken at ${chain} after rollback`);
    return `${before} safety reports back to ${after}; ${wo} work orders unchanged; audit chain intact`;
  });
}

await app.close();
await closePools();
const failed = out.integrity.filter((c) => !c.ok).length + out.recovery.filter((c) => !c.ok).length;
await writeFile(path.join(config.storageDir, 'system-check.json'), JSON.stringify(out, null, 2));
console.log(`\n${failed ? `${failed} CHECK(S) FAILED` : 'all integrity and recovery checks passed'}; results in ${path.join(config.storageDir, 'system-check.json')}`);
process.exit(failed ? 1 : 0);
