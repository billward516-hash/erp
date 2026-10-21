/**
 * UI smoke test: drives the built web app against a seeded server as several demo users and saves
 * screenshots. Fails on any page error, console error, or missing expected text.
 *
 *   npm run seed && npm run web:build && PORT=3011 npm start   (in another shell)
 *   BASE_URL=http://localhost:3011 npx tsx scripts/ui-smoke.ts
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium, type Page } from 'playwright';

const BASE = process.env.BASE_URL ?? 'http://localhost:3011';
const OUT = process.env.SHOT_DIR ?? '.storage/ui-smoke';
const tokens: Record<string, string> = JSON.parse(await readFile('.storage/dev-tokens.json', 'utf8'));
const token = (prefix: string) => Object.entries(tokens).find(([k]) => k.startsWith(prefix))![1];
const errors: string[] = [];
const checks: string[] = [];

async function signIn(page: Page, who: string) {
  await page.goto(BASE);
  await page.evaluate(() => sessionStorage.clear());
  await page.goto(BASE);
  await page.fill('#token', token(who));
  await page.click('button:has-text("Sign in")');
  await page.waitForSelector('nav[aria-label="Main"]');
}
async function expectText(page: Page, text: string | RegExp, label: string) {
  try {
    await page.getByText(text).first().waitFor({ timeout: 8000 });
  } catch (e) {
    await page.screenshot({ path: path.join(OUT, 'FAILED.png'), fullPage: true });
    throw new Error(`check failed: ${label} (screenshot ${OUT}/FAILED.png)`);
  }
  checks.push(`ok  ${label}`);
}
const shot = (page: Page, name: string) => page.screenshot({ path: path.join(OUT, `${name}.png`), fullPage: true });

await mkdir(OUT, { recursive: true });
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? '/opt/pw-browsers/chromium' }).catch(() => chromium.launch());
const context = await browser.newContext({ viewport: { width: 1360, height: 900 } });
const page = await context.newPage();
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
page.on('console', (m) => { if (m.type() === 'error' && !/status of 4\d\d/.test(m.text())) errors.push(`console: ${m.text()}`); });

// Technician: home, asset with an open change, work order, training
await signIn(page, 'priya');
await expectText(page, 'My work orders', 'technician home shows assigned work');
await shot(page, '01-tech-home');
await page.click('a:has-text("Assets")');
await page.fill('#asset-q', 'HMC-201');
await page.getByText('HMC-201').first().click();
await expectText(page, /change affects this asset/, 'asset page warns about open change');
await expectText(page, 'TSG-HMC-201-SPN', 'asset page lists controlled documents');
await shot(page, '02-asset-hmc201');
await page.click('a:has-text("Work orders")');
await page.getByText('Spindle vibration above 6k rpm').first().click();
await expectText(page, 'Mark work complete', 'technician can complete in-progress work order');
await shot(page, '03-work-order');
await page.click('a:has-text("Training")');
await page.click('button:has-text("My qualifications")');
await expectText(page, 'SPN-HMC201', 'qualifications tab lists granted qualification');
await shot(page, '04-my-qualifications');

// Phone width
await page.setViewportSize({ width: 390, height: 844 });
await page.click('a:has-text("Home")');
await expectText(page, 'My work orders', 'home renders at phone width');
const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
if (overflow > 1) errors.push(`horizontal overflow at phone width: ${overflow}px`); else checks.push('ok  no horizontal scroll at 390px');
await shot(page, '05-tech-home-phone');
await page.setViewportSize({ width: 1360, height: 900 });

// EHS reviewer approves the chemical change
await signIn(page, 'jordan');
await page.click('a:has-text("Approvals")');
await expectText(page, 'MOC-000003', 'EHS approval queue shows the chemical change');
await shot(page, '06-approvals');
await page.click('button:has-text("Approve as")');
await expectText(page, 'Nothing is waiting for you.', 'approval clears the queue');

// Operations manager sees it next, then opens the change
await signIn(page, 'alex');
await page.click('a:has-text("Approvals")');
await expectText(page, 'Authorize the change', 'authorization step reaches operations');
await page.click('a:has-text("Changes")');
await page.getByText('MOC-000001').first().click();
await expectText(page, 'Action plan', 'change page shows action plan');
await shot(page, '07-change-detail');

// Maintenance manager imports a messy parts file through the wizard
await signIn(page, 'marcus');
await page.click('a:has-text("Data import")');
const csv = path.resolve(OUT, 'ui-parts.csv');
await writeFile(csv, 'Item #;Desc;U/M;Unit Price;Status\nUI-001;Test bearing;pcs;$12,50;Active\nUI-002;Test belt;each;7.25;Obsolete\nUI-003;;EA;1;Active\n');
await page.selectOption('#imp-target', 'parts');
await page.fill('#imp-source', 'ui-smoke');
await page.setInputFiles('#imp-file', csv);
await page.click('button:has-text("Match columns")');
await expectText(page, 'Column in your file', 'wizard shows column matching');
await shot(page, '08-import-matching');
await page.click('button:has-text("Check every row")');
await expectText(page, 'Rows that will not import', 'dry run reports the bad row');
await shot(page, '09-import-check');
await page.check('#imp-partial');
await page.click('button:has-text("Import 2 rows")');
await expectText(page, /Imported: 2 created/, 'import commits good rows');

// Executive reads a report
await signIn(page, 'exec');
await page.click('a:has-text("Reports")');
await page.getByText('Asset availability & utilization').click();
await expectText(page, /availability|measured asset/i, 'report renders headline');
await shot(page, '10-report');

await browser.close();
console.log(checks.join('\n'));
if (errors.length) {
  console.error(`\n${errors.length} problem(s):\n${errors.join('\n')}`);
  process.exit(1);
}
console.log(`\nall UI checks passed; screenshots in ${OUT}`);
