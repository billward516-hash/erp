/**
 * UI crawl: signs in as every demo user and visits every page in their sidebar, every tab on it, and the first record
 * in each list, without submitting anything. Fails on any page error, console error, server error (5xx) or unexpected
 * refusal (401, 403, 404) while doing so. Complements the scripted smoke test, which drives specific workflows.
 *
 *   BASE_URL=http://localhost:3011 npx tsx scripts/ui-crawl.ts   (against a freshly seeded server)
 */
import { readFile, writeFile } from 'node:fs/promises';
import { chromium, type Page } from 'playwright';

const BASE = process.env.BASE_URL ?? 'http://localhost:3011';
const tokens: Record<string, string> = JSON.parse(await readFile('.storage/dev-tokens.json', 'utf8'));
const only = process.env.ONLY_USERS?.split(',');
// Tokens labelled "no sign-in" belong to service identities with no user behind them; they cannot open the app.
const users = Object.keys(tokens).filter((k) => !/no sign-in/i.test(k) && (!only || only.some((o) => k.startsWith(o))));

type Issue = { user: string; where: string; what: string };
const issues: Issue[] = [];
let visited = 0; let tabs = 0; let details = 0;
const summary = () => `${users.length} users · ${visited} page visits · ${tabs} tabs · ${details} records opened · ${issues.length} issue(s)`;

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? '/opt/pw-browsers/chromium' }).catch(() => chromium.launch());

for (const user of users) {
  try { await crawl(user); } catch (e) { issues.push({ user, where: 'crawl', what: `crawler stopped: ${(e as Error).message.split('\n')[0]}` }); }
  await report();
}
await browser.close();

async function crawl(user: string) {
  const context = await browser.newContext({ viewport: { width: 1360, height: 900 } });
  const page = await context.newPage();
  let where = 'sign-in';
  page.on('pageerror', (e) => issues.push({ user, where, what: `page error: ${e.message}` }));
  page.on('console', (m) => { if (m.type() === 'error' && !/status of 4\d\d|Failed to load resource/.test(m.text())) issues.push({ user, where, what: `console: ${m.text().slice(0, 300)}` }); });
  page.on('response', (r) => {
    const url = r.url();
    if (!url.startsWith(BASE)) return;
    const s = r.status();
    if (s >= 500) issues.push({ user, where, what: `${s} from ${r.request().method()} ${url.slice(BASE.length)}` });
    else if ([401, 403, 404].includes(s) && url.includes('/api/')) issues.push({ user, where, what: `${s} from ${r.request().method()} ${url.slice(BASE.length)}` });
  });
  await page.goto(BASE);
  await page.click('summary:has-text("Development sign-in")');
  await page.fill('#token', tokens[user]!);
  await page.click('button:has-text("Sign in with token")');
  await page.waitForSelector('nav[aria-label="Main"]');
  const links = await page.locator('nav[aria-label="Main"] a[href]').evaluateAll((as) => [...new Set(as.map((a) => (a as HTMLAnchorElement).getAttribute('href')!))]);
  for (const href of links) {
    where = href;
    await page.goto(`${BASE}${href}`);
    await settle(page);
    visited++;
    // Every tab on the page, one after another.
    const tabNames = await page.locator('[role="tablist"] [role="tab"]').allInnerTexts();
    for (const name of tabNames) {
      where = `${href} › tab ${name.trim()}`;
      const t = page.locator('[role="tablist"] [role="tab"]', { hasText: name.trim() }).first();
      if (await t.isVisible()) { await t.click(); await settle(page); tabs++; await openFirstRow(page, href, () => { where = `${href} › tab ${name.trim()} › first record`; }); }
    }
    if (!tabNames.length) await openFirstRow(page, href, () => { where = `${href} › first record`; });
  }
  await context.close();
  console.log(`${user}: ${links.length} pages`);
}

/** Opens the first clickable row of the first table, if any (lists navigate to the record on click), then comes back. */
async function openFirstRow(page: Page, href: string, mark: () => void) {
  const row = page.locator('table tbody tr.clickable, table tbody tr[tabindex="0"]').first();
  if (!(await row.count()) || !(await row.isVisible())) return;
  const before = page.url();
  mark();
  await row.click();
  await settle(page);
  if (page.url() !== before) { details++; await page.goBack(); await settle(page); }
}

async function settle(page: Page) {
  await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => undefined);
}

/** Written after every user, so a crash part-way still leaves what was found. */
async function report() { await writeFile('.storage/ui-crawl.json', JSON.stringify({ summary: summary(), issues }, null, 2)); }
await report();
console.log(`\n${summary()}`);
const grouped = new Map<string, Issue[]>();
for (const i of issues) grouped.set(i.what, [...(grouped.get(i.what) ?? []), i]);
for (const [what, list] of grouped) console.log(`- ${what}\n    seen by ${[...new Set(list.map((l) => l.user.split(' ')[0]))].join(', ')} at ${[...new Set(list.map((l) => l.where))].slice(0, 4).join('; ')}`);
process.exit(issues.length ? 1 : 0);
