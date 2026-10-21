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
// Stocked part: must pick the storeroom; stock is issued, then one is returned.
const bearing = await page.locator('#part option', { hasText: 'BRG-6205-2RS' }).getAttribute('value');
await page.selectOption('#part', bearing!);
await page.waitForSelector('#part-loc');
await page.selectOption('#part-loc', { label: 'DAY-MAIN · 24 on hand · bin A-01-03' });
await page.fill('#part-qty', '2');
await page.click('button:has-text("Record use")');
await expectText(page, 'DAY-MAIN', 'part use records the storeroom it came from');
await page.click('td button:has-text("Return")');
await page.locator('input[aria-label^="Quantity to return"]').fill('1');
await page.click('button:has-text("Return to DAY-MAIN")');
await page.waitForFunction(() => [...document.querySelectorAll('td')].some((td) => td.textContent === '1'));
checks.push('ok  unused part returned to the storeroom');
await shot(page, '03b-work-order-parts');
await page.click('a:has-text("Training")');
await page.click('button:has-text("My qualifications")');
await expectText(page, 'SPN-HMC201', 'qualifications tab lists granted qualification');
await shot(page, '04-my-qualifications');

// Technician raises a purchase request and submits it
await page.click('a:has-text("Purchasing")');
await page.click('button:has-text("New request")');
await page.fill('#pr-title', 'Torque screwdriver set');
await page.fill('input[aria-label="Line 1 description"]', 'Torque screwdriver set 5-50 in-lb');
await page.fill('input[aria-label="Line 1 estimated unit price"]', '240');
await page.click('button:has-text("Save draft")');
await expectText(page, /Sign-off route for \$240\.00: Budget owner approval/, 'draft request shows its approval route');
await page.click('button:has-text("Submit for approval")');
await expectText(page, 'Awaiting approval', 'request submitted for approval');
await shot(page, '04b-purchase-request');

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

// Maintenance manager: PM schedule, storerooms, meter reading
await page.click('a:has-text("PM")');
await expectText(page, 'PM-HMC-201-Q', 'PM schedule lists plans');
await expectText(page, 'Overdue', 'PM schedule flags the overdue plan');
await page.click('button:has-text("Generate due work orders")');
await expectText(page, /No new work orders: nothing else is due/, 'PM generation does not duplicate open work orders');
await shot(page, '11-pm-schedule');
await page.getByText('PM-CNC-101-M').first().click();
await expectText(page, 'Late', 'plan history shows a late PM');
await shot(page, '12-pm-plan');
await page.click('a:has-text("Storerooms")');
await expectText(page, 'BLT-AX38', 'storeroom stock lists parts');
await page.check('#inv-low');
await expectText(page, 'CMP-OIL-ROTO', 'reorder filter shows low stock');
await page.getByText('CMP-OIL-ROTO').first().click();
await expectText(page, 'Quote Q-8812', 'ledger shows the receipt reference');
await shot(page, '13-storeroom');
await page.selectOption('#rcv-loc', { label: 'DAY-MAIN · Dayton main storeroom' });
const oil = await page.locator('#rcv-part option', { hasText: 'CMP-OIL-ROTO' }).getAttribute('value');
await page.selectOption('#rcv-part', oil!);
await page.fill('#rcv-qty', '4');
await page.fill('#rcv-cost', '305');
await page.click('button:has-text("Receive")');
await expectText(page, /CMP-OIL-ROTO at DAY-MAIN is now 6/, 'receiving updates on-hand');
await page.click('a:has-text("Assets")');
await page.fill('#asset-q', 'CMP-01');
await page.getByText('CMP-01').first().click();
await expectText(page, 'PM-CMP-01-2000H', 'asset page lists its PM plans');
await page.fill('#meter-value', '41870');
await page.click('button:has-text("Record meter reading")');
await expectText(page, /PM-CMP-01-2000H: 30 to go/, 'meter reading updates the meter plan');
await shot(page, '14-asset-pm');

// Finance approves the capital request; buyer receives an order
await signIn(page, 'morgan');
await page.click('a:has-text("Approvals")');
await expectText(page, /Purchase request · Finance approval/, 'finance sees the capital request');
await expectText(page, '$18,500.00 capital', 'approval card shows amount and spend type');
await shot(page, '16-finance-approval');
await page.click('button:has-text("Approve as")');
await expectText(page, 'Nothing is waiting for you.', 'finance approval clears the queue');
await signIn(page, 'kim');
await page.click('a:has-text("Purchasing")');
await page.click('button[role="tab"]:has-text("Orders")');
await expectText(page, 'Late', 'open orders flag the late delivery');
await shot(page, '17-purchase-orders');
await page.getByText('Atlas Compressor Service').first().click();
await expectText(page, 'Receive delivery', 'buyer can receive an open order');
await page.fill('#po-slip', 'ACS-20931');
await page.click('button:has-text("Record receipt")');
await expectText(page, 'ACS-20931', 'receipt recorded with packing slip');
await expectText(page, 'Received', 'order fully received');
await shot(page, '18-purchase-order-received');
await page.click('a:has-text("Purchasing")');
await page.click('button[role="tab"]:has-text("Requests")');
await page.getByText('Spare spindle cartridge for HMC-201').first().click();
await expectText(page, 'Place the order', 'approved request can be ordered');
await page.click('button:has-text("Create purchase order")');
await expectText(page, 'Receive delivery', 'ordering opens the new purchase order');

// Executive reads a report
await signIn(page, 'exec');
await page.click('a:has-text("Reports")');
await page.getByText('Asset availability & utilization').click();
await expectText(page, /availability|measured asset/i, 'report renders headline');
await shot(page, '10-report');
await page.click('a:has-text("Reports")');
await page.getByText('Preventive maintenance compliance').click();
await expectText(page, /PM compliance 50\.0% over 90 days/, 'PM compliance report renders');
await shot(page, '15-report-pm');

await browser.close();
console.log(checks.join('\n'));
if (errors.length) {
  console.error(`\n${errors.length} problem(s):\n${errors.join('\n')}`);
  process.exit(1);
}
console.log(`\nall UI checks passed; screenshots in ${OUT}`);
