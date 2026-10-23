/**
 * Load test against a running server on a database that holds two years of history (npm run seed && npm run seed:history).
 *
 *   PORT=3015 npm start     (in another shell)
 *   npx tsx scripts/load-test.ts [--url http://localhost:3015] [--users 25] [--seconds 60] [--writes 0.05]
 *
 * Simulated users each run a think-time loop (no think time between requests = worst case, default 0.3 s): mostly reads
 * of the lists, reports and pages people open, a few creating work orders. Reports p50/p95/p99 per endpoint and overall,
 * throughput, error count, and the server's own metrics. Exits non-zero if any request returned 5xx or p95 exceeds --budget-ms.
 */
import { readFile } from 'node:fs/promises';

const arg = (n: string, d: string) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : d; };
const URL_ = arg('url', 'http://localhost:3015');
const USERS = Number(arg('users', '25'));
const SECONDS = Number(arg('seconds', '60'));
const THINK = Number(arg('think-ms', '300'));
const WRITES = Number(arg('writes', '0.05'));
const BUDGET = Number(arg('budget-ms', '1500'));
const tokens: Record<string, string> = JSON.parse(await readFile('.storage/dev-tokens.json', 'utf8'));
const who = Object.entries(tokens).filter(([k]) => k.includes('(Stonebridge)')).map(([, v]) => v);
if (!who.length) { console.error('no Stonebridge tokens; run npm run seed:history first'); process.exit(2); }

const get = async (t: string, p: string) => { const r = await fetch(URL_ + p, { headers: { authorization: `Bearer ${t}` } }); return { status: r.status, body: r.ok ? await r.json().catch(() => null) : null }; };
const admin = who[0]!;
const sample = {
  asset: (await get(admin, '/api/assets?limit=50')).body,
  part: (await get(admin, '/api/parts?limit=50')).body,
};
const rows = (b: any) => (Array.isArray(b) ? b : b?.rows ?? b?.items ?? []);
const assets = rows(sample.asset), parts = rows(sample.part);
if (!assets.length) { console.error('no assets found'); process.exit(2); }
const to = new Date().toISOString().slice(0, 10), from = new Date(Date.now() - 365 * 864e5).toISOString().slice(0, 10);
const reports = rows((await get(admin, '/api/reports')).body).map((r: any) => r.id).filter(Boolean);

const reads: [string, () => string, number][] = [
  ['assets list', () => '/api/assets?limit=200', 6], ['asset detail', () => `/api/assets/${assets[Math.floor(Math.random() * assets.length)].id}`, 8],
  ['work orders list', () => '/api/work-orders?limit=200', 10], ['work orders search', () => '/api/work-orders?status=closed&q=bearing', 3],
  ['parts list', () => '/api/parts?limit=200', 5], ['inventory ledger', () => `/api/inventory/ledger?partId=${parts[Math.floor(Math.random() * Math.max(1, parts.length))]?.id}&limit=200`, 3],
  ['customer invoices', () => '/api/customer-invoices?limit=200', 3], ['trial balance', () => '/api/books/trial-balance', 2], ['balance sheet', () => '/api/books/balance-sheet', 2],
  ['profit and loss', () => `/api/books/profit-and-loss?from=${from}&to=${to}`, 2], ['global search', () => '/api/search?q=bearing', 6], ['notifications', () => '/api/notifications', 10],
  ['me', () => '/api/me', 10], ['report', () => `/api/reports/${reports[Math.floor(Math.random() * reports.length)]}?from=${from}&to=${to}`, 6],
];
const totalW = reads.reduce((s, r) => s + r[2], 0);
const lat = new Map<string, number[]>(); const errors = new Map<string, number>();
const record = (name: string, ms: number, status: number) => { (lat.get(name) ?? lat.set(name, []).get(name)!).push(ms); if (status >= 500 || status === 0) errors.set(name, (errors.get(name) ?? 0) + 1); };

const stopAt = Date.now() + SECONDS * 1000;
async function user(i: number) {
  const t = who[i % who.length]!;
  while (Date.now() < stopAt) {
    const t0 = performance.now(); let name: string; let status = 0;
    try {
      if (Math.random() < WRITES) {
        name = 'create work order';
        const r = await fetch(`${URL_}/api/work-orders`, { method: 'POST', headers: { authorization: `Bearer ${t}`, 'content-type': 'application/json' },
          body: JSON.stringify({ assetId: assets[Math.floor(Math.random() * assets.length)].id, title: `load test ${i}-${Date.now()}`, priority: 3 }) });
        status = r.status; await r.arrayBuffer();
      } else {
        let x = Math.random() * totalW; const pick = reads.find((r) => (x -= r[2]) < 0) ?? reads[0]!; name = pick[0];
        const r = await fetch(URL_ + pick[1](), { headers: { authorization: `Bearer ${t}` } }); status = r.status; await r.arrayBuffer();
      }
    } catch { name = 'network'; }
    record(name!, performance.now() - t0, status);
    if (THINK) await new Promise((r) => setTimeout(r, THINK * (0.5 + Math.random())));
  }
}
console.log(`${USERS} users for ${SECONDS}s against ${URL_} (think ${THINK} ms, ${(WRITES * 100).toFixed(0)}% writes)`);
const started = Date.now();
await Promise.all(Array.from({ length: USERS }, (_, i) => user(i)));
const elapsed = (Date.now() - started) / 1000;
const pct = (a: number[], p: number) => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(s.length * p))] ?? 0; };
const all = [...lat.values()].flat();
console.log('\nendpoint'.padEnd(24) + 'n'.padStart(7) + 'p50'.padStart(8) + 'p95'.padStart(8) + 'p99'.padStart(8) + 'max'.padStart(8) + '  5xx');
for (const [k, v] of [...lat].sort((a, b) => pct(b[1], 0.95) - pct(a[1], 0.95))) {
  console.log(k.padEnd(24) + String(v.length).padStart(7) + pct(v, .5).toFixed(0).padStart(8) + pct(v, .95).toFixed(0).padStart(8) + pct(v, .99).toFixed(0).padStart(8) + Math.max(...v).toFixed(0).padStart(8) + `  ${errors.get(k) ?? 0}`);
}
const errs = [...errors.values()].reduce((s, n) => s + n, 0);
console.log(`\nALL`.padEnd(24) + String(all.length).padStart(7) + pct(all, .5).toFixed(0).padStart(8) + pct(all, .95).toFixed(0).padStart(8) + pct(all, .99).toFixed(0).padStart(8));
console.log(`throughput ${(all.length / elapsed).toFixed(1)} req/s over ${elapsed.toFixed(0)} s; server errors ${errs}`);
process.exit(errs > 0 || pct(all, .95) > BUDGET ? 1 : 0);
