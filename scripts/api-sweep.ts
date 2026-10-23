/**
 * API sweep: calls every route the server registers, as several kinds of user, with unknown ids and empty or
 * malformed bodies, and fails on any server error (5xx). A route should answer bad input with a clear 4xx, never crash.
 * Run against a disposable seeded server (it may create records where empty input is valid).
 *
 *   BASE_URL=http://localhost:3011 npx tsx scripts/api-sweep.ts
 */
import { readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const BASE = process.env.BASE_URL ?? 'http://localhost:3011';
const tokens: Record<string, string> = JSON.parse(await readFile('.storage/dev-tokens.json', 'utf8'));
const pick = (prefix: string) => Object.entries(tokens).find(([k]) => k.startsWith(prefix));
const who = ['dana', 'priya', 'kai', 'sam', 'lena'].map(pick).filter(Boolean) as [string, string][];

// Every route in the source: app.<method>('<path>' in each routes file; most are under /api.
const routes: { method: string; path: string }[] = [];
async function scan(dir: string) {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) await scan(p);
    else if (e.name.endsWith('.ts')) {
      const src = await readFile(p, 'utf8');
      for (const m of src.matchAll(/app\.(get|post|put|patch|delete)\('([^']+)'/g)) {
        const raw = m[2]!;
        const full = raw.startsWith('/api/') || raw.startsWith('/auth/') || raw.startsWith('/public/') || ['/health', '/ready', '/metrics'].includes(raw) ? raw : `/api${raw}`;
        routes.push({ method: m[1]!.toUpperCase(), path: full });
      }
    }
  }
}
await scan('src');
const UUID = '00000000-0000-4000-8000-000000000000';
const fill = (p: string) => p.replace(/:([a-zA-Z]+)/g, (_, name: string) => (/id$/i.test(name) ? UUID : name === 'key' ? 'leasing' : name === 'type' ? 'fmea' : name === 'category' ? 'emails' : 'x'));

type Finding = { user: string; method: string; path: string; status: number; body: string };
const findings: Finding[] = [];
let calls = 0;
const statuses = new Map<number, number>();
const bodies = (m: string) => (m === 'GET' || m === 'DELETE' ? [undefined] : [{}, { id: 'not-a-uuid', amount: 'NaN', date: '31/31/2020' }]);
for (const [label, token] of who) {
  for (const r of routes) {
    for (const body of bodies(r.method)) {
      const res = await fetch(`${BASE}${fill(r.path)}`, {
        method: r.method, headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined, redirect: 'manual',
      }).catch((e) => ({ status: 599, text: async () => String(e) }) as unknown as Response);
      calls++;
      statuses.set(res.status, (statuses.get(res.status) ?? 0) + 1);
      if (res.status >= 500) findings.push({ user: label.split(' ')[0]!, method: r.method, path: r.path, status: res.status, body: (await res.text()).slice(0, 200) });
    }
  }
}
const summary = `${routes.length} routes · ${who.length} users · ${calls} calls · statuses ${[...statuses].sort((a, b) => a[0] - b[0]).map(([s, n]) => `${s}×${n}`).join(' ')} · ${findings.length} server error(s)`;
await writeFile('.storage/api-sweep.json', JSON.stringify({ summary, findings }, null, 2));
console.log(summary);
const seen = new Set<string>();
for (const f of findings) { const k = `${f.method} ${f.path}`; if (seen.has(k)) continue; seen.add(k); console.log(`- ${f.status} ${k} (${f.user}): ${f.body}`); }
process.exit(findings.length ? 1 : 0);
