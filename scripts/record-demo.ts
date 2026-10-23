/**
 * Records a clickable preview. Signs in as a few sample people against a seeded server, visits every page in their sidebar,
 * every tab, and the first few records of every list, and saves each successful JSON answer from GET /api/... so the web app
 * can replay them with no server (`npm run demo:build`). Nothing is submitted.
 *
 *   BASE_URL=http://localhost:3018 npx tsx scripts/record-demo.ts   (against a freshly seeded server)
 * Writes web/demo/demo-data.json
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { chromium, type Page } from 'playwright';

const BASE = process.env.BASE_URL ?? 'http://localhost:3018';
const ROWS = Number(process.env.ROWS ?? 4);
const tokens: Record<string, string> = JSON.parse(await readFile('.storage/dev-tokens.json', 'utf8'));
const PERSONAS: { id: string; prefix: string; label: string; blurb: string }[] = [
  { id: 'admin', prefix: 'dana', label: 'Administrator', blurb: 'Dana, administrator at a machining company: every area' },
  { id: 'tech', prefix: 'priya', label: 'Technician', blurb: 'Priya, maintenance technician: her work orders and day' },
  { id: 'service', prefix: 'dee', label: 'Service dispatcher', blurb: 'Dee, dispatcher at an HVAC service company: field service' },
  { id: 'lite', prefix: 'kai', label: 'Lite owner', blurb: 'Kai, owner of a small company on the Lite edition' },
];
const token = (prefix: string) => Object.entries(tokens).find(([k]) => k.startsWith(prefix))![1];
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? '/opt/pw-browsers/chromium' }).catch(() => chromium.launch());
const out: Record<string, { label: string; blurb: string; data: Record<string, { s: number; b: unknown }> }> = {};

async function settle(page: Page) { await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => undefined); }

for (const p of PERSONAS) {
  const data: Record<string, { s: number; b: unknown }> = {};
  const ctx = await browser.newContext({ viewport: { width: 1360, height: 900 } });
  const page = await ctx.newPage();
  page.on('response', async (r) => {
    const url = new URL(r.url());
    if (!url.pathname.startsWith('/api/') || r.request().method() !== 'GET') return;
    const ct = r.headers()['content-type'] ?? '';
    if (!ct.includes('json')) return;
    const key = url.pathname + url.search;
    try { data[key] = { s: r.status(), b: await r.json() }; } catch { /* body gone */ }
  });
  await page.goto(BASE);
  await page.evaluate((t) => sessionStorage.setItem('erp.token', t), token(p.prefix));
  await page.goto(BASE);
  await page.waitForSelector('nav[aria-label="Main"]');
  const links = await page.locator('nav[aria-label="Main"] a[href]').evaluateAll((as) => [...new Set(as.map((a) => (a as HTMLAnchorElement).getAttribute('href')!))]);
  const rowSel = 'table tbody tr.clickable, table tbody tr[tabindex="0"]';
  async function openRows(from: string) {
    const n = Math.min(ROWS, await page.locator(rowSel).count());
    for (let i = 0; i < n; i++) {
      const row = page.locator(rowSel).nth(i);
      if (!(await row.isVisible().catch(() => false))) continue;
      const before = page.url();
      await row.click({ timeout: 5000 }).catch(() => undefined);
      await page.waitForURL((u) => u.toString() !== before, { timeout: 2500 }).catch(() => undefined);
      await settle(page);
      if (page.url() !== before) { await page.goBack(); await settle(page); }
    }
  }
  for (const href of links) {
    await page.goto(`${BASE}${href}`); await settle(page);
    const tabNames = await page.locator('[role="tablist"] [role="tab"]').allInnerTexts();
    if (!tabNames.length) await openRows(href);
    for (const name of tabNames) {
      const t = page.locator('[role="tablist"] [role="tab"]', { hasText: name.trim() }).first();
      if (!(await t.isVisible().catch(() => false))) continue;
      await t.click({ timeout: 5000 }).catch(() => undefined); await settle(page);
      await openRows(href);
    }
  }
  await ctx.close();
  out[p.id] = { label: p.label, blurb: p.blurb, data };
  console.log(`${p.id}: ${Object.keys(data).length} answers, ${(JSON.stringify(data).length / 1e6).toFixed(1)} MB`);
}
await browser.close();
await mkdir('web/demo', { recursive: true });
await writeFile('web/demo/demo-data.json', JSON.stringify(out));
console.log('saved web/demo/demo-data.json');
