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
const PATHS: Record<string, string> = { Home: '/', Assets: '/assets', 'Work orders': '/work-orders', PM: '/pm', Storerooms: '/inventory', Purchasing: '/purchasing',
  Payables: '/ap', Changes: '/changes', Approvals: '/approvals', Training: '/training', Time: '/time', Reports: '/reports', 'Data import': '/imports', Accounting: '/integrations' };
/** Opens a main-menu destination, opening its menu group first when the link is inside one. */
async function go(page: Page, label: string) {
  const nav = page.locator('nav[aria-label="Main"]');
  const link = nav.locator(`a[href="${PATHS[label]}"]`).first();
  if (await link.isVisible()) return link.click();
  for (const group of await nav.locator('button.nav-button').all()) {
    await group.click();
    if (await link.isVisible()) return link.click();
    await page.keyboard.press('Escape');
  }
  throw new Error(`menu item not found: ${label}`);
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
await go(page, 'Assets');
await page.fill('#asset-q', 'HMC-201');
await page.getByText('HMC-201').first().click();
await expectText(page, /change affects this asset/, 'asset page warns about open change');
await expectText(page, 'TSG-HMC-201-SPN', 'asset page lists controlled documents');
await shot(page, '02-asset-hmc201');
await go(page, 'Work orders');
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
await go(page, 'Training');
await page.click('button:has-text("My qualifications")');
await expectText(page, 'SPN-HMC201', 'qualifications tab lists granted qualification');
await shot(page, '04-my-qualifications');

// Technician raises a purchase request and submits it
await go(page, 'Purchasing');
await page.click('button:has-text("New request")');
await page.fill('#pr-title', 'Torque screwdriver set');
await page.fill('input[aria-label="Line 1 description"]', 'Torque screwdriver set 5-50 in-lb');
await page.fill('input[aria-label="Line 1 estimated unit price"]', '240');
await page.click('button:has-text("Save draft")');
await expectText(page, /Sign-off route for \$240\.00: Budget owner approval/, 'draft request shows its approval route');
await page.click('button:has-text("Submit for approval")');
await expectText(page, 'Awaiting approval', 'request submitted for approval');
await shot(page, '04b-purchase-request');

// Technician's week: work-order hours appear by themselves; add training time
await go(page, 'Time');
await expectText(page, 'from work order', 'timesheet shows work-order hours automatically');
await page.fill('#te-hours', '1.5');
await page.fill('#te-note', 'Toolbox talk: lockout refresher');
await page.click('button:has-text("Add time")');
await expectText(page, 'Toolbox talk: lockout refresher', 'employee adds non-work-order time');
await shot(page, '04c-my-timesheet');

// Phone width
await page.setViewportSize({ width: 390, height: 844 });
await go(page, 'Home');
await expectText(page, 'My work orders', 'home renders at phone width');
const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
if (overflow > 1) errors.push(`horizontal overflow at phone width: ${overflow}px`); else checks.push('ok  no horizontal scroll at 390px');
await shot(page, '05-tech-home-phone');
await page.setViewportSize({ width: 1360, height: 900 });

// EHS reviewer approves the chemical change
await signIn(page, 'jordan');
await go(page, 'Approvals');
await expectText(page, 'MOC-000003', 'EHS approval queue shows the chemical change');
await shot(page, '06-approvals');
await page.click('button:has-text("Approve as")');
await expectText(page, 'Nothing is waiting for you.', 'approval clears the queue');

// Operations manager sees it next, then opens the change
await signIn(page, 'alex');
await go(page, 'Approvals');
await expectText(page, 'Authorize the change', 'authorization step reaches operations');
await go(page, 'Changes');
await page.getByText('MOC-000001').first().click();
await expectText(page, 'Action plan', 'change page shows action plan');
await shot(page, '07-change-detail');

// Maintenance manager imports a messy parts file through the wizard
await signIn(page, 'marcus');
await page.click('a.bell');
await expectText(page, /Waiting for your sign-off: PR-\d+ Torque screwdriver set/, 'approver is notified of the request a technician just submitted');
await expectText(page, /timesheets? at DAY waiting for approval/, 'daily reminders appear in notifications');
await shot(page, '08a-notifications');
await page.getByText(/Waiting for your sign-off: PR-\d+ Torque/).first().click();
await expectText(page, 'Waiting for my sign-off', 'opening a notification goes to the approvals inbox');
await go(page, 'Data import');
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
await go(page, 'PM');
await expectText(page, 'PM-HMC-201-Q', 'PM schedule lists plans');
await expectText(page, 'Overdue', 'PM schedule flags the overdue plan');
await page.click('button:has-text("Generate due work orders")');
await expectText(page, /No new work orders: nothing else is due/, 'PM generation does not duplicate open work orders');
await shot(page, '11-pm-schedule');
await page.getByText('PM-CNC-101-M').first().click();
await expectText(page, 'Late', 'plan history shows a late PM');
await shot(page, '12-pm-plan');
await go(page, 'Storerooms');
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
await go(page, 'Assets');
await page.fill('#asset-q', 'CMP-01');
await page.getByText('CMP-01').first().click();
await expectText(page, 'PM-CMP-01-2000H', 'asset page lists its PM plans');
await page.fill('#meter-value', '41870');
await page.click('button:has-text("Record meter reading")');
await expectText(page, /PM-CMP-01-2000H: 30 to go/, 'meter reading updates the meter plan');
await shot(page, '14-asset-pm');

// Supervisor approves last week's timesheet
await go(page, 'Time');
await page.click('button[role="tab"]:has-text("Team")');
await expectText(page, 'Waiting for approval', 'team view shows a timesheet waiting');
await page.locator('tr', { hasText: 'Priya Shah' }).click();
await expectText(page, /over 40: split overtime/, 'long week is flagged for overtime review');
await shot(page, '14b-timesheet-review');
await page.click('button:has-text("Approve")');
await expectText(page, 'Approved', 'supervisor approves the week');

// Finance approves the capital request; buyer receives an order
await signIn(page, 'morgan');
await go(page, 'Approvals');
await expectText(page, /Purchase request · Finance approval/, 'finance sees the capital request');
await expectText(page, '$18,500.00 capital', 'approval card shows amount and spend type');
await shot(page, '16-finance-approval');
await page.click('button:has-text("Approve as")');
await expectText(page, 'Nothing is waiting for you.', 'finance approval clears the queue');
await go(page, 'Payables');
await expectText(page, 'RW-44190', 'payables list shows invoices');
await page.getByText('RW-44190').first().click();
await expectText(page, /Does not match the order: line 1: invoiced 1 but received 0/, 'invoice shows the mismatch with receipts');
await page.fill('#inv-note', 'OEM requires prepayment for special-order encoders; confirmed with Kim');
await page.click('button:has-text("Approve $3,850.00")');
await expectText(page, 'Approved with note', 'mismatched invoice approved with an explanation');
await shot(page, '19-invoice-approved');
await signIn(page, 'ana');
await go(page, 'Payables');
await page.click('button:has-text("Capture invoice")');
await page.selectOption('#inv-supplier', { label: 'GREATLKS · Great Lakes Fluid Power' });
await page.selectOption('#inv-fac', { label: 'DAY · Dayton Plant' });
await page.fill('#inv-number', '558377');
await page.click('button:has-text("Add a line not on the order")');
await page.fill('input[aria-label="Line 1 description"]', 'Hydraulic oil analysis kit');
await page.fill('input[aria-label="Line 1 unit price"]', '74.50');
await page.click('button:has-text("Save invoice")');
await expectText(page, 'You captured this invoice, so someone else must approve it.', 'capturer cannot approve their own invoice');
await shot(page, '20-invoice-captured');
await signIn(page, 'dana');
await go(page, 'Accounting');
await expectText(page, 'MOCK connection.', 'mock accounting connection is clearly labeled');
await page.click('button:has-text("Sync now")');
await expectText(page, /Sync finished: 1 sent/, 'sync sends the approved invoice');
await page.locator('tr', { hasText: 'RW-44190' }).locator('button:has-text("Pay in accounting")').click();
await page.click('button:has-text("Sync now")');
await expectText(page, /1 payment received/, 'payment made in accounting comes back');
await shot(page, '21-accounting');
await signIn(page, 'kim');
await go(page, 'Purchasing');
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
await go(page, 'Purchasing');
await page.click('button[role="tab"]:has-text("Requests")');
await page.getByText('Spare spindle cartridge for HMC-201').first().click();
await expectText(page, 'Place the order', 'approved request can be ordered');
await page.click('button:has-text("Create purchase order")');
await expectText(page, 'Receive delivery', 'ordering opens the new purchase order');

// Payroll administrator exports approved hours
await signIn(page, 'lena');
await go(page, 'Time');
await page.click('button[role="tab"]:has-text("Payroll export")');
await expectText(page, /approved timesheets? ready/, 'payroll preview counts approved weeks');
await expectText(page, 'not ready; they stay out of this file', 'payroll preview lists weeks not ready');
await page.click('button:has-text("Create payroll file")');
await expectText(page, 'payroll-hours-', 'payroll file created');
await shot(page, '22-payroll');

// Executive reads a report
await signIn(page, 'exec');
await go(page, 'Reports');
await page.getByText('Asset availability & utilization').click();
await expectText(page, /availability|measured asset/i, 'report renders headline');
await shot(page, '10-report');
await go(page, 'Reports');
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
