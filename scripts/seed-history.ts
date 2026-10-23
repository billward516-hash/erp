/**
 * Two years of operating history for load, integrity and performance checks (S44).
 *
 *   npm run seed            # builds the demo companies
 *   npm run seed:history    # adds Stonebridge Components: 2 plants, ~160 machines, two years of activity
 *
 * Stonebridge is a separate company, so the demo companies and the test suite are untouched. The history is
 * deterministic (a seeded generator), so two runs give the same shape. Money-moving records (invoices, payments, bills)
 * go through the real services so the books balance; high-volume telemetry (machine states, time, stock movements,
 * SPC points, production entries, work orders) is written in bulk with the dates a real year would have given it.
 * The audit trail is never backdated: it records what the services did while loading, in order, and stays verifiable.
 *
 * Options: --days=730 (history length), --scale=1 (volume multiplier; 0.1 for a quick trial).
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { asActor, loadActor } from '../src/platform/auth/actor.js';
import type { Actor } from '../src/platform/auth/actor.js';
import { closePools, getAdminPool } from '../src/platform/db/pool.js';
import { LocalBlobStore } from '../src/platform/storage/blob-store.js';
import { createUserWithToken, provisionTenant } from '../src/platform/tenancy/provision.js';
import { config } from '../src/config.js';
import { approveInvoice, captureInvoice, recordPayment as payBill } from '../src/modules/ap/service.js';
import { createInvoice, issueInvoice, recordPayment as receivePayment } from '../src/modules/ar/service.js';
import { setupBooks } from '../src/modules/books/service.js';
import { createCustomer } from '../src/modules/crm/service.js';
import { createSupplier } from '../src/modules/purchasing/service.js';
import { recordSubgroup } from '../src/modules/spc/service.js';
import { log } from './seed-lib.js';

const arg = (name: string, d: number) => { const a = process.argv.find((x) => x.startsWith(`--${name}=`)); return a ? Number(a.split('=')[1]) : d; };
const DAYS = arg('days', 730);
const SCALE = arg('scale', 1);
const DAY = 86_400_000;
const NOW = Date.now();
const START = new Date(new Date(NOW - DAYS * DAY).toISOString().slice(0, 10) + 'T00:00:00Z').getTime();
const iso = (ms: number) => new Date(ms).toISOString();
const dateOf = (ms: number) => iso(ms).slice(0, 10);

let seed = 20241024;
const rand = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
const between = (a: number, b: number) => a + rand() * (b - a);
const int = (a: number, b: number) => Math.floor(between(a, b + 1));
const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)]!;
const round = (n: number, p = 2) => Math.round(n * 10 ** p) / 10 ** p;
const chance = (p: number) => rand() < p;

/** Multi-row INSERT in chunks, so a million rows do not mean a million round trips. */
async function bulk(db: pg.Pool | pg.PoolClient, table: string, cols: string[], rows: unknown[][], tail = '', chunk = 2000) {
  for (let i = 0; i < rows.length; i += chunk) {
    const part = rows.slice(i, i + chunk);
    const params: unknown[] = [];
    const tuples = part.map((r) => `(${r.map((v) => { params.push(v); return `$${params.length}`; }).join(',')})`);
    await db.query(`INSERT INTO ${table} (${cols.join(',')}) VALUES ${tuples.join(',')} ${tail}`, params);
  }
}

const blobs = new LocalBlobStore(config.storageDir);
const db = getAdminPool();

if ((await db.query(`SELECT 1 FROM tenant WHERE slug = 'stonebridge'`)).rowCount) {
  log('Stonebridge already exists; run "npm run seed" first for a clean start.');
  await closePools();
  process.exit(0);
}
const t0 = Date.now();
const lap = (what: string) => log(`  ${what} (${((Date.now() - t0) / 1000).toFixed(0)}s)`);

// ── Company, people ───────────────────────────────────────────────────────────
log(`Stonebridge Components: ${DAYS} days of history (scale ${SCALE})`);
const t = await provisionTenant(db, { slug: 'stonebridge', name: 'Stonebridge Components', legalEntity: 'Stonebridge Components Inc.',
  facilities: [{ code: 'CLE', name: 'Cleveland Plant', timezone: 'America/New_York' }, { code: 'COL', name: 'Columbus Plant', timezone: 'America/New_York' }] });
const T = t.tenantId;
const FAC = [t.facilities.CLE!, t.facilities.COL!];
const tokens: Record<string, string> = {};

const FIRST = ['Alex', 'Blair', 'Casey', 'Drew', 'Eden', 'Finley', 'Gray', 'Harper', 'Indy', 'Jules', 'Kai', 'Lane', 'Morgan', 'Noel', 'Oak', 'Parker', 'Quinn', 'Reese', 'Sage', 'Tatum', 'Uma', 'Val', 'Wren', 'Xan', 'Yael', 'Zion'];
const LAST = ['Abbott', 'Baker', 'Chen', 'Diaz', 'Ellis', 'Foster', 'Garcia', 'Hughes', 'Ivanov', 'Jensen', 'Khan', 'Lopez', 'Moore', 'Nguyen', 'Ortiz', 'Patel', 'Reyes', 'Singh', 'Turner', 'Usher', 'Vega', 'Walker', 'Young', 'Zhao'];

const mk = async (label: string, email: string, name: string, employeeId: string | null, roles: { role: string; facility: string | null }[]) => {
  const u = await createUserWithToken(db, T, { email, displayName: name, employeeId, roles });
  tokens[`${label} (Stonebridge)`] = u.token;
  return (await loadActor(T, u.userId))!;
};

// Employees: 36 per plant, hired over the previous eight years.
type Emp = { id: string; facility: number; number: string; rate: number; tech: boolean };
const emps: Emp[] = [];
{
  const rows: unknown[][] = []; let n = 1000;
  for (let f = 0; f < 2; f++) for (let i = 0; i < Math.max(8, Math.round(36 * SCALE)); i++) {
    const id = (await db.query('SELECT gen_random_uuid() AS id')).rows[0].id as string;
    const num = `S${++n}`; const tech = i < Math.round(Math.max(8, 36 * SCALE) * 0.22);
    emps.push({ id, facility: f, number: num, rate: round(between(21, 46)), tech });
    rows.push([id, T, FAC[f], num, pick(FIRST), pick(LAST), tech ? 'Maintenance technician' : pick(['Machine operator', 'CNC machinist', 'Assembler', 'Inspector', 'Material handler']), 'active', dateOf(NOW - int(200, 3000) * DAY)]);
  }
  await bulk(db, 'employee', ['id', 'tenant_id', 'facility_id', 'employee_number', 'first_name', 'last_name', 'job_title', 'status', 'hire_date'], rows);
}
const techs = [0, 1].map((f) => emps.filter((e) => e.facility === f && e.tech));
const admin = await mk('morgan (admin)', 'morgan.ellis@stonebridge.example', 'Morgan Ellis', null, [{ role: 'admin', facility: null }]);
const mgr = [await mk('maint mgr CLE', 'maint.cle@stonebridge.example', 'Reese Foster', techs[0]![0]!.id, [{ role: 'maintenance_manager', facility: FAC[0]! }]),
  await mk('maint mgr COL', 'maint.col@stonebridge.example', 'Jules Ortiz', techs[1]![0]!.id, [{ role: 'maintenance_manager', facility: FAC[1]! }])];
const tech = await mk('technician CLE', 'tech.cle@stonebridge.example', 'Casey Nguyen', techs[0]![1]!.id, [{ role: 'technician', facility: FAC[0]! }]);
const sup = await mk('production supervisor CLE', 'sup.cle@stonebridge.example', 'Drew Patel', null, [{ role: 'production_supervisor', facility: FAC[0]! }]);
const books = await mk('bookkeeper', 'books@stonebridge.example', 'Val Turner', null, [{ role: 'bookkeeper', facility: null }, { role: 'buyer', facility: null }]);
const approver = await mk('finance approver', 'finance@stonebridge.example', 'Quinn Abbott', null, [{ role: 'finance_approver', facility: null }, { role: 'executive', facility: null }]);
const qual = await mk('quality manager', 'quality@stonebridge.example', 'Sage Khan', null, [{ role: 'quality_manager', facility: null }]);
const adminId = admin.userId;
lap(`${emps.length} employees, 7 users`);

// ── Machines ───────────────────────────────────────────────────────────────────
type Asset = { id: string; facility: number; tag: string; cls: string; crit: string; cost: number; downCost: number };
const assets: Asset[] = [];
{
  const CLASSES: [string, string, number, number][] = [['CNC lathe', 'LTH', 380_000, 1], ['Machining center', 'MCH', 520_000, 1], ['Press', 'PRS', 240_000, 2], ['Grinder', 'GRD', 150_000, 2],
    ['Conveyor', 'CNV', 60_000, 3], ['Compressor', 'CMP', 45_000, 2], ['Robot cell', 'ROB', 290_000, 1], ['Furnace', 'FUR', 210_000, 2], ['Wash line', 'WSH', 85_000, 3], ['Saw', 'SAW', 38_000, 3]];
  const rows: unknown[][] = [];
  const per = Math.max(10, Math.round(80 * SCALE));
  for (let f = 0; f < 2; f++) for (let i = 0; i < per; i++) {
    const [cls, code, cost, crit] = CLASSES[i % CLASSES.length]!;
    const id = (await db.query('SELECT gen_random_uuid() AS id')).rows[0].id as string;
    const tag = `${f ? 'COL' : 'CLE'}-${code}-${String(Math.floor(i / CLASSES.length) + 1).padStart(2, '0')}`;
    assets.push({ id, facility: f, tag, cls, crit: crit === 1 ? 'high' : crit === 2 ? 'medium' : 'low', cost, downCost: round(cost / 900) });
    rows.push([id, T, FAC[f], tag, `${cls} ${Math.floor(i / CLASSES.length) + 1}`, cls, pick(['Haas', 'Mazak', 'Okuma', 'Fanuc', 'Bosch', 'Atlas Copco', 'Trumpf']), dateOf(NOW - int(100, 3500) * DAY),
      crit === 1 ? 'high' : crit === 2 ? 'medium' : 'low', 'active', 'running', cost, 15, round(cost / 900)]);
  }
  await bulk(db, 'asset', ['id', 'tenant_id', 'facility_id', 'asset_tag', 'name', 'category', 'manufacturer', 'commissioned_on', 'criticality', 'lifecycle_status', 'operational_state', 'replacement_cost', 'expected_life_years', 'downtime_cost_per_hour'], rows);
}
lap(`${assets.length} machines`);

// ── Parts, storerooms, stock ───────────────────────────────────────────────────
type Part = { id: string; number: string; cost: number; consumable: boolean; fg: boolean };
const parts: Part[] = [];
{
  const KINDS: [string, boolean][] = [['Bearing', false], ['V-belt', false], ['Hydraulic filter', false], ['Contactor', false], ['Proximity sensor', false], ['Coolant', true], ['Cutting insert', true], ['Way oil', true],
    ['Grinding wheel', true], ['Gasket set', false], ['Solenoid valve', false], ['Fastener kit', false]];
  const rows: unknown[][] = [];
  const n = Math.max(40, Math.round(300 * SCALE));
  for (let i = 0; i < n; i++) {
    const [k, consumable] = KINDS[i % KINDS.length]!;
    const id = (await db.query('SELECT gen_random_uuid() AS id')).rows[0].id as string;
    const cost = round(between(2, 380));
    parts.push({ id, number: `SB-${String(10000 + i)}`, cost, consumable: consumable as boolean, fg: false });
    rows.push([id, T, `SB-${10000 + i}`, `${k} type ${Math.floor(i / KINDS.length) + 1}`, 'EA', cost, 'none']);
  }
  for (let i = 0; i < 12; i++) {
    const id = (await db.query('SELECT gen_random_uuid() AS id')).rows[0].id as string;
    parts.push({ id, number: `FG-${200 + i}`, cost: round(between(14, 90)), consumable: false, fg: true });
    rows.push([id, T, `FG-${200 + i}`, `Finished component ${200 + i}`, 'EA', parts.at(-1)!.cost, 'none']);
  }
  await bulk(db, 'part', ['id', 'tenant_id', 'part_number', 'description', 'uom', 'unit_cost', 'tracking'], rows);
}
const rm = parts.filter((p) => !p.fg);
const fgParts = parts.filter((p) => p.fg);
const locs: string[] = [];
for (let f = 0; f < 2; f++) {
  const id = (await db.query('SELECT gen_random_uuid() AS id')).rows[0].id as string;
  await db.query(`INSERT INTO stock_location (id, tenant_id, facility_id, code, name, kind) VALUES ($1, $2, $3, $4, 'Maintenance storeroom', 'storeroom')`, [id, T, FAC[f], f ? 'MRO-COL' : 'MRO-CLE']);
  locs.push(id);
}

/** Stock events are collected raw and replayed in time order at the end, so balance_after is exact and no balance goes negative. */
type StockEvent = { f: number; part: Part; type: string; qty: number; at: number; wo: string | null; ref: string | null; mo: string | null };
const stockEvents: StockEvent[] = [];
const stock = (f: number, part: Part, type: string, qty: number, at: number, extra: { wo?: string | null; ref?: string | null; mo?: string | null } = {}) => {
  stockEvents.push({ f, part, type, qty, at, wo: extra.wo ?? null, ref: extra.ref ?? null, mo: extra.mo ?? null });
};
const issueWithCover = (f: number, part: Part, qty: number, at: number, wo: string | null) => stock(f, part, 'issue', -qty, at, { wo });
for (let f = 0; f < 2; f++) for (const p of rm) stock(f, p, 'opening', int(5, 60), START, { ref: 'Opening balance' });
lap(`${parts.length} parts, 2 storerooms`);

// ── Work orders, labor, parts, machine downtime ───────────────────────────────
type Wo = { id: string; n: number; asset: Asset; type: string; start: number; end: number; downtimeStart: number | null };
const wos: Wo[] = [];
const woRows: unknown[][] = []; const laborRows: unknown[][] = []; const woPartRows: unknown[][] = [];
{
  const FAIL = ['Bearing failure', 'Hydraulic leak', 'Sensor fault', 'Belt wear', 'Coolant pump failure', 'Servo alarm', 'Contactor welded', 'Air leak'];
  let n = 0;
  for (const a of assets) {
    const f = a.facility; const mgrFor = mgr[f]!; void mgrFor;
    // Preventive work: monthly for critical, quarterly for the rest. Corrective: a few a year, more as the machine ages.
    const pmEvery = a.crit === 'high' ? 30 : a.crit === 'medium' ? 60 : 90;
    const events: { at: number; type: string }[] = [];
    for (let d = int(1, pmEvery); d < DAYS - 3; d += pmEvery) events.push({ at: START + d * DAY, type: 'preventive' });
    const failures = Math.round((a.crit === 'high' ? 7 : a.crit === 'medium' ? 5 : 3) * (DAYS / 365) * between(0.5, 1.5) * SCALE ** 0.3);
    for (let i = 0; i < failures; i++) events.push({ at: START + int(1, DAYS - 3) * DAY, type: 'corrective' });
    for (let i = 0; i < Math.round(DAYS / 180); i++) events.push({ at: START + int(1, DAYS - 3) * DAY, type: 'inspection' });
    for (const e of events.sort((x, y) => x.at - y.at)) {
      const id = (await db.query('SELECT gen_random_uuid() AS id')).rows[0].id as string;
      n++;
      const start = e.at + int(6, 14) * 3_600_000;
      const hours = e.type === 'corrective' ? round(between(1.5, 14)) : e.type === 'preventive' ? round(between(1, 4)) : round(between(0.5, 2));
      const end = start + hours * 3_600_000;
      const open = end > NOW - 2 * DAY;
      const status = open ? pick(['planned', 'scheduled', 'in_progress']) : chance(0.97) ? 'closed' : 'completed';
      const created = e.type === 'corrective' ? start - int(1, 8) * 3_600_000 : start - int(3, 14) * DAY;
      const crew = techs[f]!;
      const workers = crew.slice(0, 1).concat(chance(0.35) ? [pick(crew)] : []);
      woRows.push([id, T, FAC[f], `WO-${String(n).padStart(6, '0')}`, a.id, e.type, e.type === 'corrective' ? int(1, 3) : 3, `${e.type === 'corrective' ? pick(FAIL) : e.type === 'preventive' ? 'Scheduled PM' : 'Condition inspection'} — ${a.tag}`,
        status, iso(start + DAY), hours, open ? null : iso(start), open ? null : iso(end), open || status !== 'closed' ? null : iso(end + 3_600_000), open || status !== 'closed' ? null : iso(end + 3_600_000),
        e.type === 'corrective' ? pick(['BRG', 'HYD', 'ELE', 'PNE', 'MEC']) : null, 'native', iso(created), iso(open ? created : end)]);
      if (!open) {
        for (const w of workers) laborRows.push([T, id, w.id, dateOf(start), round(hours / workers.length), w.rate]);
        const nParts = e.type === 'corrective' ? int(0, 3) : e.type === 'preventive' ? int(0, 2) : 0;
        for (let i = 0; i < nParts; i++) {
          const p = pick(rm.filter((x) => !x.consumable)); const q = int(1, 3);
          woPartRows.push([T, id, p.id, q, q, p.cost, locs[f]]);
          issueWithCover(f, p, q, start + int(0, 3) * 3_600_000, id);
        }
      }
      wos.push({ id, n, asset: a, type: e.type, start, end: open ? NOW : end, downtimeStart: e.type === 'corrective' && !open ? start - int(0, 90) * 60_000 : e.type === 'preventive' && !open ? start : null });
    }
  }
}
// Consumables are drawn from the crib without a work order (what the demonstrated-consumption view reads).
for (let f = 0; f < 2; f++) for (const p of rm.filter((x) => x.consumable)) {
  const monthly = int(4, 40);
  for (let d = int(1, 20); d < DAYS; d += int(25, 35)) {
    const at = START + d * DAY + int(8, 16) * 3_600_000;
    if (at > NOW - DAY) break;
    issueWithCover(f, p, Math.max(1, Math.round(monthly * between(0.7, 1.3))), at, null);
  }
}
await bulk(db, 'work_order', ['id', 'tenant_id', 'facility_id', 'number', 'asset_id', 'wo_type', 'priority', 'title', 'status', 'due_at', 'estimated_labor_hours', 'started_at', 'completed_at', 'verified_at', 'closed_at', 'failure_code', 'origin', 'created_at', 'updated_at'],
  woRows.map((r) => [r[0], r[1], r[2], r[3], r[4], r[5], r[6], r[7], r[8], r[9], r[10], r[11], r[12], r[13], r[14], r[15], r[16], r[17], r[18]]));
await bulk(db, 'work_order_labor', ['tenant_id', 'work_order_id', 'employee_id', 'work_date', 'hours', 'hourly_rate'], laborRows);
await bulk(db, 'work_order_part', ['tenant_id', 'work_order_id', 'part_id', 'qty_planned', 'qty_used', 'unit_cost', 'location_id'], woPartRows);
await db.query(`UPDATE work_order SET verified_by = $2, completed_by = $2, closed_by = $2 WHERE tenant_id = $1 AND status = 'closed'`, [T, adminId]).catch(() => undefined);
await db.query(`INSERT INTO tenant_sequence (tenant_id, key, next_value) VALUES ($1, 'work_order', $2) ON CONFLICT (tenant_id, key) DO UPDATE SET next_value = $2`, [T, wos.length + 1]);
lap(`${wos.length} work orders, ${laborRows.length} labor lines, ${woPartRows.length} part lines`);

// ── Machine states: two years, per machine ─────────────────────────────────────
{
  const byAsset = new Map<string, Wo[]>();
  for (const w of wos) if (w.downtimeStart != null) (byAsset.get(w.asset.id) ?? byAsset.set(w.asset.id, []).get(w.asset.id)!).push(w);
  const rows: unknown[][] = [];
  const REASONS = ['mech_failure', 'electrical', 'changeover', 'no_material', 'no_operator', 'quality_hold'];
  const flush = async () => { await bulk(db, 'asset_state_event', ['tenant_id', 'facility_id', 'asset_id', 'state', 'reason_code', 'started_at', 'ended_at', 'source'], rows.splice(0), '', 4000); };
  for (const a of assets) {
    const down = (byAsset.get(a.id) ?? []).map((w) => ({ s: w.downtimeStart!, e: w.end, state: w.type === 'corrective' ? 'unplanned_downtime' : 'planned_downtime' })).sort((x, y) => x.s - y.s);
    // Merge any overlapping reservations so the timeline never overlaps itself.
    const res: typeof down = [];
    for (const d of down) { const last = res.at(-1); if (last && d.s < last.e) last.e = Math.max(last.e, d.e); else res.push({ ...d }); }
    const push = (state: string, s: number, e: number, reason: string | null = null) => { if (e - s >= 60_000) rows.push([T, FAC[a.facility], a.id, state, reason, iso(s), iso(e), 'import']); };
    for (let d = 0; d < DAYS; d++) {
      const day = START + d * DAY; const dow = new Date(day).getUTCDay();
      if (dow === 0 || (dow === 6 && a.crit !== 'high')) continue; // weekend: off
      const open = day + 6 * 3_600_000; const close = day + (a.crit === 'high' ? 22 : 14) * 3_600_000;
      if (close > NOW) break;
      let cursor = open;
      for (const r of res) {
        if (r.e <= open || r.s >= close) continue;
        const s = Math.max(r.s, open); const e = Math.min(r.e, close);
        if (s > cursor) { // running up to the stop, with a short idle somewhere in it
          const mid = cursor + (s - cursor) * between(0.3, 0.8);
          if (chance(0.5) && s - cursor > 3 * 3_600_000) { push('running', cursor, mid); push('idle', mid, mid + int(10, 45) * 60_000, pick(['changeover', 'no_material'])); push('running', mid + 45 * 60_000, s); }
          else push('running', cursor, s);
        }
        push(r.state, s, e, r.state === 'unplanned_downtime' ? pick(REASONS.slice(0, 2)) : null);
        cursor = Math.max(cursor, e);
      }
      if (cursor < close) {
        const rest = close - cursor;
        if (rest > 3 * 3_600_000 && chance(0.6)) {
          const mid = cursor + rest * between(0.3, 0.7);
          push('running', cursor, mid); push('idle', mid, mid + int(10, 50) * 60_000, pick(['changeover', 'no_material', 'no_operator'])); push('running', mid + 50 * 60_000 < close ? mid + 50 * 60_000 : close - 60_000, close);
        } else push('running', cursor, close);
      }
    }
    if (rows.length > 40_000) await flush();
  }
  await flush();
}
const stateCount = (await db.query('SELECT count(*)::int AS n FROM asset_state_event WHERE tenant_id = $1', [T])).rows[0].n;
lap(`${stateCount} machine state events`);

// ── Time and attendance: a timesheet per person per week ──────────────────────
{
  const ts: unknown[][] = []; const te: unknown[][] = [];
  const firstMonday = (() => { const d = new Date(START); const off = (d.getUTCDay() + 6) % 7; return START - off * DAY; })();
  for (const e of emps) {
    for (let w = firstMonday; w + 7 * DAY <= NOW - 7 * DAY; w += 7 * DAY) {
      const id = (await db.query('SELECT gen_random_uuid() AS id')).rows[0].id as string;
      ts.push([id, T, FAC[e.facility], e.id, dateOf(w), 'draft', adminId, iso(w + 5 * DAY + 17 * 3_600_000), adminId, iso(w + 6 * DAY + 9 * 3_600_000)]);
      for (let d = 0; d < 5; d++) {
        const worked = chance(0.03) ? 0 : 8;
        if (!worked) { te.push([T, id, dateOf(w + d * DAY), chance(0.5) ? 'PTO' : 'SICK', 8, 'manual', adminId, iso(w + d * DAY + 7 * 3_600_000)]); continue; }
        te.push([T, id, dateOf(w + d * DAY), 'REG', 8, 'manual', adminId, iso(w + d * DAY + 17 * 3_600_000)]);
        if (chance(0.12)) te.push([T, id, dateOf(w + d * DAY), 'OT', pick([1, 1.5, 2, 3]), 'manual', adminId, iso(w + d * DAY + 19 * 3_600_000)]);
      }
    }
  }
  await bulk(db, 'timesheet', ['id', 'tenant_id', 'facility_id', 'employee_id', 'week_start', 'status', 'submitted_by', 'submitted_at', 'decided_by', 'decided_at'], ts);
  await bulk(db, 'time_entry', ['tenant_id', 'timesheet_id', 'work_date', 'earning_code', 'hours', 'source', 'created_by', 'created_at'], te, '', 3000);
  await db.query(`UPDATE timesheet SET status = 'approved' WHERE tenant_id = $1 AND week_start < current_date - 21`, [T]);
  await db.query(`UPDATE timesheet SET status = 'submitted' WHERE tenant_id = $1 AND status = 'draft'`, [T]);
  lap(`${ts.length} timesheets, ${te.length} time entries`);
}

// ── Meters, deliveries, safety, quality ───────────────────────────────────────
{
  const rows: unknown[][] = [];
  for (const a of assets) { let v = int(0, 4000); for (let d = 7; d < DAYS; d += 14) { v += int(60, 200); rows.push([T, FAC[a.facility], a.id, 'hours', v, iso(START + d * DAY + 8 * 3_600_000), 'manual', adminId]); } }
  await bulk(db, 'asset_meter_reading', ['tenant_id', 'facility_id', 'asset_id', 'meter', 'value', 'read_at', 'source', 'recorded_by'], rows, '', 3000);
  lap(`${rows.length} meter readings`);
}
const sups: { id: string; terms: string }[] = [];
const custs: { id: string; terms: string }[] = [];
{
  const SUPN = ['Atlas Industrial Supply', 'Great Lakes Bearing', 'Midwest Hydraulics', 'Precision Tooling Co', 'Buckeye Electric', 'Lakeshore Fasteners', 'Summit Abrasives', 'Northcoast Lubricants', 'Ohio Valley Steel', 'Keystone Filtration',
    'Apex Controls', 'Cardinal Gaskets', 'Erie Cutting Tools', 'Heartland Pneumatics', 'Ironworks Castings', 'Linden Packaging', 'Maple Freight', 'Orion Calibration', 'Pioneer Chemical', 'Quarry Aggregates'];
  await asActor(books, async (tx) => {
    for (let i = 0; i < SUPN.length; i++) {
      const terms = pick(['Net 30', 'Net 45', 'Net 15', 'Net 30']);
      const s = await createSupplier(tx, books, { code: `V${String(i + 1).padStart(3, '0')}`, name: SUPN[i]!, paymentTerms: terms });
      sups.push({ id: s.id, terms });
    }
  });
  const CUSTN = ['Lakeshore Hydraulics', 'Buckeye Drivetrain', 'Great Lakes Pump', 'Midland Gearbox', 'Cardinal Motion', 'Summit Actuation', 'Erie Valve Works', 'Keystone Fluid Power', 'Heritage Compressors', 'Ironbridge Machinery',
    'Northcoast Turbines', 'Pioneer Axle', 'Apex Transmission', 'Linden Robotics', 'Orion Aerospace Parts'];
  await asActor(books, async (tx) => {
    for (let i = 0; i < CUSTN.length; i++) {
      const terms = pick(['Net 30', 'Net 45', 'Net 60', 'Net 30']);
      const c = await createCustomer(tx, books, { code: `C${String(i + 1).padStart(3, '0')}`, name: CUSTN[i]!, kind: 'customer', paymentTerms: terms });
      custs.push({ id: c.id, terms });
    }
  });
  const rows: unknown[][] = [];
  const n = Math.round(1600 * SCALE);
  for (let i = 0; i < n; i++) {
    const due = START + int(5, DAYS - 10) * DAY; const late = chance(0.18); const s = pick(sups); const p = pick(rm);
    const q = int(5, 100); const rej = chance(0.06) ? int(1, Math.max(1, Math.round(q * 0.1))) : 0;
    rows.push([T, FAC[int(0, 1)], s.id, `PO-H${String(i + 1).padStart(5, '0')}`, p.id, `${p.number} restock`, q, dateOf(due), dateOf(due + (late ? int(1, 9) : int(-2, 0)) * DAY), q - rej, rej, p.cost, 'history']);
  }
  await bulk(db, 'supplier_delivery_history', ['tenant_id', 'facility_id', 'supplier_id', 'reference', 'part_id', 'description', 'qty_ordered', 'due_on', 'received_on', 'qty_received', 'qty_rejected', 'unit_price', 'source_system'], rows);
  lap(`${rows.length} supplier deliveries, ${sups.length} suppliers, ${custs.length} customers`);
}
{
  const ncr: unknown[][] = []; const inc: unknown[][] = [];
  const nNcr = Math.round(420 * SCALE);
  for (let i = 0; i < nNcr; i++) {
    const at = START + int(1, DAYS - 20) * DAY + int(7, 16) * 3_600_000; const f = int(0, 1); const p = pick(fgParts);
    const sev = pick(['minor', 'minor', 'major', 'critical']); const closed = chance(0.93);
    ncr.push([T, FAC[f], `NCR-${String(i + 1).padStart(5, '0')}`, pick(['production', 'receiving', 'customer']), `${pick(['Out of tolerance', 'Surface defect', 'Wrong material', 'Burr on edge', 'Dimension drift'])} on ${p.number}`,
      'Found during inspection; segregated pending disposition.', sev, closed ? 'closed' : 'open', p.id, int(1, 80), adminId, iso(at), closed ? pick(['scrap', 'rework', 'use_as_is', 'return_to_supplier']) : null, closed ? round(between(40, 2400)) : null,
      closed ? iso(at + int(1, 12) * DAY) : null]);
  }
  const nInc = Math.round(70 * SCALE);
  for (let i = 0; i < nInc; i++) {
    const at = START + int(1, DAYS - 20) * DAY + int(6, 20) * 3_600_000; const f = int(0, 1); const rec = chance(0.2);
    inc.push([T, FAC[f], `INC-${String(i + 1).padStart(4, '0')}`, pick(['near_miss', 'near_miss', 'first_aid', 'injury', 'property_damage']), iso(at), pick(['Press line', 'Dock', 'Machine shop', 'Tool crib']),
      'Reported by the operator; area made safe.', 'closed', rec ? 'high' : 'low', rec, adminId, iso(at + 3_600_000), iso(at + int(2, 20) * DAY)]);
  }
  await bulk(db, 'nonconformance', ['tenant_id', 'facility_id', 'number', 'source', 'title', 'description', 'severity', 'status', 'part_id', 'qty', 'reported_by', 'created_at', 'disposition', 'cost', 'closed_at'], ncr);
  await bulk(db, 'safety_incident', ['tenant_id', 'facility_id', 'number', 'kind', 'occurred_at', 'location', 'description', 'status', 'severity', 'recordable', 'reported_by', 'created_at', 'closed_at'], inc);
  await db.query(`INSERT INTO tenant_sequence (tenant_id, key, next_value) VALUES ($1, 'ncr', $2), ($1, 'incident', $3) ON CONFLICT (tenant_id, key) DO UPDATE SET next_value = EXCLUDED.next_value`, [T, ncr.length + 1, inc.length + 1]);
  await db.query(`UPDATE nonconformance SET closed_by = $2, dispositioned_by = $2, dispositioned_at = closed_at WHERE tenant_id = $1 AND status = 'closed'`, [T, adminId]);
  lap(`${ncr.length} nonconformances, ${inc.length} safety reports`);
}

// ── Production: orders, entries, material, finished goods ─────────────────────
{
  const wcRows: { id: string; f: number }[] = [];
  for (let f = 0; f < 2; f++) for (const [code, name] of [['TURN', 'Turning'], ['MILL', 'Milling'], ['GRIND', 'Grinding'], ['ASSY', 'Assembly']]) {
    const id = (await db.query('SELECT gen_random_uuid() AS id')).rows[0].id as string;
    await db.query(`INSERT INTO work_center (id, tenant_id, facility_id, code, name, hours_per_week, units) VALUES ($1, $2, $3, $4, $5, 80, 3)`, [id, T, FAC[f], code, name]);
    wcRows.push({ id, f });
  }
  const revs = new Map<string, { id: string; ops: { id: string; wc: string; setup: number; run: number; no: number; name: string }[] }>();
  for (const p of fgParts) {
    const rid = (await db.query('SELECT gen_random_uuid() AS id')).rows[0].id as string;
    await db.query(`INSERT INTO product_revision (id, tenant_id, part_id, revision, status, created_by, released_by, released_at) VALUES ($1, $2, $3, 1, 'draft', $4, NULL, NULL)`, [rid, T, p.id, adminId]);
    const ops: { id: string; wc: string; setup: number; run: number; no: number; name: string }[] = [];
    const wcs = wcRows.filter((w) => w.f === 0).slice(0, 3);
    for (let i = 0; i < wcs.length; i++) {
      const oid = (await db.query('SELECT gen_random_uuid() AS id')).rows[0].id as string;
      const setup = int(20, 90); const run = round(between(0.5, 4));
      await db.query(`INSERT INTO product_operation (id, tenant_id, revision_id, op_no, work_center_id, description, setup_minutes, run_minutes_per_unit) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [oid, T, rid, (i + 1) * 10, wcs[i]!.id, ['Turn', 'Mill', 'Grind'][i], setup, run]);
      ops.push({ id: oid, wc: wcs[i]!.id, setup, run, no: (i + 1) * 10, name: ['Turn', 'Mill', 'Grind'][i]! });
    }
    await db.query(`UPDATE product_revision SET status = 'released', released_by = $2, released_at = $3 WHERE id = $1`, [rid, adminId, iso(START)]);
    revs.set(p.id, { id: rid, ops });
  }
  const orders: unknown[][] = []; const entries: unknown[][] = []; const mats: unknown[][] = []; const poOps: unknown[][] = [];
  const nOrders = Math.round(3200 * SCALE);
  const operators = emps.filter((e) => e.facility === 0 && !e.tech);
  for (let i = 0; i < nOrders; i++) {
    const p = pick(fgParts); const r = revs.get(p.id)!; const qty = pick([50, 100, 200, 250, 500]);
    const rel = START + int(1, DAYS - 6) * DAY + 7 * 3_600_000; const done = rel + int(1, 4) * DAY;
    const id = (await db.query('SELECT gen_random_uuid() AS id')).rows[0].id as string;
    const scrapRate = between(0.005, 0.04); let good = qty;
    orders.push([id, T, FAC[0], `MO-${String(i + 1).padStart(6, '0')}`, p.id, r.id, qty, 0, 'closed', dateOf(done), adminId, iso(rel - DAY), adminId, iso(rel), iso(done), adminId, iso(done)]);
    let t = rel;
    for (const op of r.ops) {
      const op1 = pick(operators); const asset = pick(assets.filter((a) => a.facility === 0));
      const scrap = Math.round(qty * scrapRate); good = Math.max(1, qty - scrap);
      const poId = randomUUID();
      poOps.push([poId, T, id, op.no, op.wc, op.name, op.setup, op.run, 'done', good, scrap, 0]);
      const setupEnd = t + op.setup * 60_000; const runEnd = setupEnd + qty * op.run * 60_000 * between(0.9, 1.25);
      entries.push([T, FAC[0], id, poId, op1.id, asset.id, 'setup', iso(t), iso(setupEnd), 0, 0, 0, null, adminId, iso(setupEnd)]);
      entries.push([T, FAC[0], id, poId, op1.id, asset.id, 'run', iso(setupEnd), iso(runEnd), good, scrap, 0, scrap ? pick(['tool_wear', 'setup', 'material']) : null, adminId, iso(runEnd)]);
      t = runEnd + 30 * 60_000;
    }
    orders[orders.length - 1]![7] = good;
    const mat = pick(rm.filter((x) => !x.consumable));
    mats.push([T, id, 1, mat.id, 1, qty, qty]);
    stock(0, mat, 'issue', -Math.min(qty, int(2, 20)), rel + 3_600_000, { mo: id });
    stock(0, p, 'production_receipt', good, done, { ref: `MO-${String(i + 1).padStart(6, '0')}`, mo: id });
  }
  await bulk(db, 'production_order', ['id', 'tenant_id', 'facility_id', 'number', 'part_id', 'revision_id', 'qty', 'qty_received', 'status', 'due_date', 'created_by', 'created_at', 'released_by', 'released_at', 'completed_at', 'closed_by', 'closed_at'], orders);
  await bulk(db, 'production_operation', ['id', 'tenant_id', 'order_id', 'op_no', 'work_center_id', 'description', 'setup_minutes', 'run_minutes_per_unit', 'status', 'qty_good', 'qty_scrap', 'qty_rework'], poOps);
  await bulk(db, 'production_entry', ['tenant_id', 'facility_id', 'order_id', 'operation_id', 'employee_id', 'asset_id', 'kind', 'started_at', 'ended_at', 'qty_good', 'qty_scrap', 'qty_rework', 'scrap_reason', 'recorded_by', 'created_at'], entries, '', 2500);
  await bulk(db, 'production_material', ['tenant_id', 'order_id', 'line_no', 'part_id', 'qty_per', 'qty_required', 'qty_issued'], mats);
  await db.query(`INSERT INTO tenant_sequence (tenant_id, key, next_value) VALUES ($1, 'mo', $2) ON CONFLICT (tenant_id, key) DO UPDATE SET next_value = $2`, [T, orders.length + 1]);
  lap(`${orders.length} production orders, ${entries.length} production entries`);
}

// ── Stock ledger: replay every movement in time order ────────────────────────
{
  stockEvents.sort((x, y) => x.at - y.at);
  const bal = new Map<string, number>(); const rows: unknown[][] = [];
  const row = (e: StockEvent, type: string, qty: number, at: number, ref: string | null) => {
    const k = `${locs[e.f]}:${e.part.id}`; const after = round((bal.get(k) ?? 0) + qty, 3); bal.set(k, after);
    rows.push([T, FAC[e.f], locs[e.f], e.part.id, type, qty, e.part.cost, after, type === 'issue' ? e.wo : null, ref, adminId, iso(at), e.mo]);
  };
  for (const e of stockEvents) {
    const k = `${locs[e.f]}:${e.part.id}`;
    if (e.qty < 0 && (bal.get(k) ?? 0) + e.qty < 0) row(e, 'receipt', Math.ceil(-e.qty * 3 + int(5, 40)), Math.max(START, e.at - 3_600_000), 'PO restock');
    row(e, e.type, e.qty, e.at, e.ref);
  }
  await bulk(db, 'inventory_txn', ['tenant_id', 'facility_id', 'location_id', 'part_id', 'txn_type', 'qty', 'unit_cost', 'balance_after', 'work_order_id', 'reference', 'created_by', 'created_at', 'production_order_id'], rows, '', 3000);
  await bulk(db, 'inventory_balance', ['tenant_id', 'facility_id', 'location_id', 'part_id', 'qty_on_hand', 'reorder_point', 'reorder_qty'],
    [...bal.entries()].map(([k, q]) => { const [loc, part] = k.split(':'); return [T, FAC[locs.indexOf(loc!)], loc, part, q, int(5, 20), int(10, 40)]; }));
  lap(`${rows.length} stock movements, ${bal.size} balances`);
}

// ── SPC: a subgroup every shift for twelve characteristics ────────────────────
{
  const chars: { id: string; nominal: number; sd: number; f: number }[] = [];
  for (let i = 0; i < 12; i++) {
    const id = (await db.query('SELECT gen_random_uuid() AS id')).rows[0].id as string;
    const nominal = pick([10, 25, 12.7, 50, 6.35]); const tol = nominal * 0.004;
    await db.query(`INSERT INTO spc_characteristic (id, tenant_id, facility_id, code, name, unit, nominal, lsl, usl, subgroup_size, frequency, created_by, chart_type) VALUES ($1, $2, $3, $4, $5, 'mm', $6, $7, $8, 5, 'each shift', $9, 'variables')`,
      [id, T, FAC[i % 2], `SPC-${i + 1}`, `${pick(['Bore', 'OD', 'Length', 'Flatness', 'Thickness'])} ${i + 1}`, nominal, round(nominal - tol, 4), round(nominal + tol, 4), adminId]);
    chars.push({ id, nominal, sd: tol / 4, f: i % 2 });
  }
  const rows: unknown[][] = [];
  for (const c of chars) {
    let drift = 0;
    for (let d = 0; d < DAYS - 45; d++) { // the last 45 days go through the service so signals are raised for real
      const day = START + d * DAY; const dow = new Date(day).getUTCDay(); if (dow === 0 || dow === 6) continue;
      if (d % 60 === 0) drift = 0; drift += between(-0.02, 0.025) * c.sd;
      for (const h of [7, 11, 15, 19]) {
        const mean = c.nominal + drift + (chance(0.004) ? 3 * c.sd : 0);
        const vals = Array.from({ length: 5 }, () => round(mean + (rand() + rand() + rand() - 1.5) * 2 * c.sd, 4));
        rows.push([T, FAC[c.f], c.id, iso(day + h * 3_600_000), vals, 'import', adminId, iso(day + h * 3_600_000)]);
      }
    }
  }
  await bulk(db, 'spc_subgroup', ['tenant_id', 'facility_id', 'characteristic_id', 'measured_at', 'vals', 'source', 'recorded_by', 'created_at'], rows, '', 3000);
  let live = 0;
  for (const c of chars) {
    for (let d = DAYS - 45; d < DAYS; d++) {
      const day = START + d * DAY; const dow = new Date(day).getUTCDay(); if (dow === 0 || dow === 6 || day > NOW - 3_600_000 * 20) continue;
      for (const h of [7, 11, 15, 19]) {
        const mean = c.nominal + (d % 20 === 0 ? 2.8 * c.sd : 0);
        const vals = Array.from({ length: 5 }, () => round(mean + (rand() + rand() + rand() - 1.5) * 2 * c.sd, 4));
        await asActor(qual, (tx) => recordSubgroup(tx, qual, c.id, { values: vals, measuredAt: new Date(day + h * 3_600_000), source: 'import' }));
        live++;
      }
    }
  }
  lap(`${rows.length + live} SPC subgroups (${live} through the service)`);
}

// ── Money: invoices and payments, bills and payments, through the books ───────
{
  await asActor(books, (tx) => setupBooks(tx, books, { startDate: dateOf(START), bankName: 'Operating account', bankLast4: '8841', openingBalance: 750_000 }));
  const nInv = Math.round(DAYS * 3.2 * SCALE); const nBill = Math.round(DAYS * 2.4 * SCALE);
  const ITEMS = ['Precision housing', 'Machined shaft', 'Gear blank', 'Valve body', 'Bracket assembly', 'Bearing sleeve', 'Manifold block', 'Flange'];
  let paid = 0; let done = 0;
  for (let i = 0; i < nInv; i++) {
    const c = pick(custs); const day = START + Math.floor((i / nInv) * (DAYS - 70)) * DAY; const date = dateOf(day);
    const lines = Array.from({ length: int(1, 4) }, () => ({ description: pick(ITEMS), qty: pick([25, 50, 100, 250, 500]), unitPrice: round(between(6, 85)) }));
    try {
      const inv = await asActor(books, async (tx) => {
        const x = await createInvoice(tx, books, { facilityId: FAC[int(0, 1)], customerId: c.id, lines, paymentTerms: c.terms });
        await issueInvoice(tx, books, blobs, x.id, { invoiceDate: date });
        return x;
      });
      const total = round(lines.reduce((s, l) => s + l.qty * l.unitPrice, 0));
      const terms = Number(/(\d+)/.exec(c.terms)?.[1] ?? 30);
      if (chance(0.88)) {
        const payDay = day + (terms + int(-8, 25)) * DAY;
        if (payDay < NOW - DAY) {
          await asActor(books, (tx) => receivePayment(tx, books, { customerId: c.id, receivedOn: dateOf(payDay), amount: total, method: pick(['ach', 'check', 'wire']), reference: `R${i}`, allocations: [{ invoiceId: inv.id, amount: total }] }));
          paid++;
        }
      }
      done++;
    } catch (e) { if (done === 0) throw e; }
    if (i % 300 === 299) lap(`  ${i + 1} of ${nInv} invoices`);
  }
  lap(`${done} invoices, ${paid} paid`);
  let bills = 0; let billsPaid = 0;
  const ACCT = ['maintenance_expense', 'supplies_expense', 'utilities_expense', 'inventory', 'other_expense'];
  for (let i = 0; i < nBill; i++) {
    const s = pick(sups); const day = START + Math.floor((i / nBill) * (DAYS - 60)) * DAY; const date = dateOf(day);
    const lines = Array.from({ length: int(1, 3) }, () => ({ description: pick(['Parts and supplies', 'Freight', 'Service call', 'Tooling', 'Calibration', 'Utilities']), qty: int(1, 12), unitPrice: round(between(15, 900)), accountKey: pick(ACCT) }));
    try {
      const b = await asActor(books, (tx) => captureInvoice(tx, books, null, { supplierId: s.id, facilityId: FAC[int(0, 1)], invoiceNumber: `INV-${100000 + i}`, invoiceDate: date, lines }));
      await asActor(approver, (tx) => approveInvoice(tx, approver, b.id, { varianceNote: 'Recurring supplier bill, no purchase order' }));
      bills++;
      const total = round(lines.reduce((x, l) => x + l.qty * l.unitPrice, 0));
      const payDay = day + (Number(/(\d+)/.exec(s.terms)?.[1] ?? 30) + int(-5, 8)) * DAY;
      if (chance(0.92) && payDay < NOW - DAY) { await asActor(books, (tx) => payBill(tx, books, b.id, { paidOn: dateOf(payDay), amount: total, reference: `ACH-${i}` })); billsPaid++; }
    } catch (e) { if (bills === 0) throw e; }
    if (i % 300 === 299) lap(`  ${i + 1} of ${nBill} bills`);
  }
  lap(`${bills} bills, ${billsPaid} paid`);
}

await mkdir(config.storageDir, { recursive: true });
const tokenFile = path.join(config.storageDir, 'dev-tokens.json');
const existing = await readFile(tokenFile, 'utf8').then((s) => JSON.parse(s)).catch(() => ({}));
await writeFile(tokenFile, JSON.stringify({ ...existing, ...tokens }, null, 2));
const totals = (await db.query(`SELECT (SELECT count(*) FROM asset WHERE tenant_id = $1) assets, (SELECT count(*) FROM work_order WHERE tenant_id = $1) work_orders, (SELECT count(*) FROM asset_state_event WHERE tenant_id = $1) state_events,
  (SELECT count(*) FROM inventory_txn WHERE tenant_id = $1) stock_movements, (SELECT count(*) FROM time_entry WHERE tenant_id = $1) time_entries, (SELECT count(*) FROM spc_subgroup WHERE tenant_id = $1) spc_subgroups,
  (SELECT count(*) FROM production_entry WHERE tenant_id = $1) production_entries, (SELECT count(*) FROM customer_invoice WHERE tenant_id = $1) invoices, (SELECT count(*) FROM supplier_invoice WHERE tenant_id = $1) bills,
  (SELECT count(*) FROM journal_line WHERE tenant_id = $1) journal_lines, (SELECT count(*) FROM audit_event WHERE tenant_id = $1) audit_events`, [T])).rows[0];
log('\nStonebridge totals:', totals);
log(`done in ${((Date.now() - t0) / 60_000).toFixed(1)} minutes; tokens added to ${tokenFile}`);
await closePools();
