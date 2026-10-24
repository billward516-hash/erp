/**
 * Operator tool: what companies asked for in the fit interview that the product does not serve yet (held on purpose).
 * Reads every company's stored interview result, counts each held need, and lists the companies behind it. Read-only.
 *
 *   npx tsx scripts/fit-demand.ts [--json]
 *
 * Use it as the evidence when deciding whether to build a held capability (for example projects and hourly billing for
 * professional services). Company names are shown; answers beyond the held needs are not.
 */
import { closePools, getAdminPool } from '../src/platform/db/pool.js';

const rows = (await getAdminPool().query(`SELECT t.name, f.result, f.updated_at FROM fit_interview f JOIN tenant t ON t.id = f.tenant_id ORDER BY t.name`)).rows;
const by = new Map<string, { label: string; note: string; companies: string[] }>();
for (const r of rows) for (const u of (r.result?.unmet ?? []) as { key: string; label: string; note: string }[]) {
  const e = by.get(u.key) ?? { label: u.label, note: u.note, companies: [] };
  e.companies.push(r.name); by.set(u.key, e);
}
const out = [...by.entries()].map(([key, e]) => ({ key, ...e, count: e.companies.length })).sort((x, y) => y.count - x.count);
if (process.argv.includes('--json')) console.log(JSON.stringify({ interviews: rows.length, held: out }, null, 2));
else {
  console.log(`${rows.length} company interview(s) on file.\n`);
  if (!out.length) console.log('No held needs recorded yet.');
  for (const e of out) console.log(`${String(e.count).padStart(3)}  ${e.label}\n     ${e.companies.join(', ')}\n     ${e.note}\n`);
}
await closePools();
