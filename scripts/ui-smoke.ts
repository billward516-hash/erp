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
  Payables: '/ap', Changes: '/changes', Approvals: '/approvals', Training: '/training', Time: '/time', Reports: '/reports', 'Data import': '/imports', Accounting: '/integrations', Customers: '/crm', 'Quotes & orders': '/sales', Receivables: '/receivables', Quality: '/quality', Safety: '/safety', 'Production orders': '/production', 'Shop floor': '/production/floor', Continuity: '/continuity', Sites: '/sites', Leasing: '/leasing', 'Conditions & visits': '/stores', Planning: '/planning' };
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
page.on('console', (m) => { if (m.type() === 'error' && !/status of 4\d\d|ERR_INTERNET_DISCONNECTED/.test(m.text())) errors.push(`console: ${m.text()}`); });

// Technician: home, asset with an open change, work order, training
await signIn(page, 'priya');
await expectText(page, 'My work orders', 'technician home shows assigned work');
await shot(page, '01-tech-home');
await go(page, 'Assets');
await page.fill('#asset-q', 'HMC-201');
await page.getByText('HMC-201').first().click();
await expectText(page, /change affects this asset/, 'asset page warns about open change');
await expectText(page, 'TSG-HMC-201-SPN', 'asset page lists controlled documents');
await page.selectOption('#rel-days', '30');
await expectText(page, /from state history, state records cover/, 'asset page shows reliability from state history');
await expectText(page, /MTBF · was [\d.,]+ h/, 'asset reliability compares with the previous period');
await shot(page, '02-asset-hmc201');
await page.locator('tr', { hasText: 'TSG-HMC-201-SPN' }).locator('a:has-text("Open")').click();
await expectText(page, 'Controlled copy online', 'document opens in the viewer with the controlled-copy notice');
await expectText(page, 'In force', 'viewer shows the revision in force');
if (await page.getByText('Revisions').count()) throw new Error('a technician sees superseded revisions');
await shot(page, '02b-document-viewer');
await go(page, 'Work orders');
await page.getByText('Spindle vibration above 6k rpm').first().click();
await expectText(page, 'Mark work complete', 'technician can complete in-progress work order');
await shot(page, '03-work-order');
// Offline: the connection drops; labor goes to the outbox and is sent when the connection returns (exactly once).
const laborRows = async () => page.locator('tr', { hasText: '1.75' }).count();
const laborBefore = await laborRows();
await context.setOffline(true);
await page.fill('#labor-hours', '1.75');
await page.click('button:has-text("Add my hours")');
await expectText(page, /Waiting to be sent: 1\.75 h labor/, 'labor recorded offline waits in the outbox');
await expectText(page, /Offline: showing copies saved on this device/, 'offline bar shows');
await shot(page, '03a-offline');
await context.setOffline(false);
await page.evaluate(() => window.dispatchEvent(new Event('online')));
await page.waitForFunction(() => !document.querySelector('.offline-bar'), null, { timeout: 15000 });
await page.reload();
await expectText(page, 'Mark work complete', 'work order reloads online');
if ((await laborRows()) !== laborBefore + 1) throw new Error(`labor recorded offline should appear exactly once after sync (before ${laborBefore}, now ${await laborRows()})`);
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
// The compressor PM kit was short of oil; the delivery fills it and it is staged on the kit shelf
await page.click('button[role="tab"]:has-text("Kits")');
await expectText(page, '1 short', 'kit list flags the short kit');
await page.locator('tr', { hasText: 'CMP-01' }).first().click();
await expectText(page, 'Refresh from stock', 'work order shows its short kit');
await page.click('button:has-text("Refresh from stock")');
await page.click('button:has-text("Stage kit in DAY-KIT")');
await expectText(page, /KIT-\d{6} · Staged/, 'kit staged on the kit shelf');
await shot(page, '44-kit');
await go(page, 'Assets');
await page.fill('#asset-q', 'CNC-101');
await page.getByText('CNC-101').first().click();
await expectText(page, 'SEAL-KIT-VF4', 'asset page lists its spare parts');
await expectText(page, 'VF-DRAWBAR-SEALS', 'asset page lists its repair templates');
await shot(page, '45-asset-spares');
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

// Sales rep: customer, follow-ups, a new quote that needs pricing approval
await signIn(page, 'riley');
await go(page, 'Customers');
await expectText(page, 'Miami Valley Hydraulics', 'customer list shows imported CRM companies');
await page.click('button[role="tab"]:has-text("Pipeline")');
await expectText(page, 'Bracket family, AS9100 supplier add', 'pipeline board shows open opportunities');
await shot(page, '23-pipeline');
await page.click('button[role="tab"]:has-text("My follow-ups")');
await expectText(page, 'Send AS9100 certificate', 'rep sees overdue follow-ups');
await page.click('button[role="tab"]:has-text("Customers")');
await page.getByText('Buckeye Medical Devices').first().click();
await page.click('button:has-text("New quote")');
await page.fill('#q-title', 'Surgical handle prototype, 25 pcs');
await page.selectOption('select[aria-label="Line 1 item"]', { label: 'PROTO-RUN · Prototype run: programming, first article and inspection report · $2,400.00' });
await page.fill('input[aria-label="Line 1 unit price"]', '1800');
await page.click('button:has-text("Save draft")');
await expectText(page, '25.0%', 'quote shows the discount from list');
await page.click('button:has-text("Finish quote")');
await expectText(page, /Needs a sales manager's approval: line 1: 25% below list price/, 'deep discount goes to the sales manager');
await shot(page, '24-quote-pending');

// Sales manager approves pricing; the order desk ships the late order
await signIn(page, 'taylor');
await go(page, 'Approvals');
await expectText(page, /Quote pricing for Buckeye Medical Devices/, 'sales manager sees the pricing approval');
await page.locator('section.card', { hasText: 'Buckeye Medical Devices' }).locator('button:has-text("Approve as")').click();
await expectText(page, 'Quote pricing for Great Miami Aerospace', 'other pricing approval still waiting');
await go(page, 'Quotes & orders');
await page.click('button[role="tab"]:has-text("Orders")');
await expectText(page, 'Late', 'late sales order is flagged');
await page.getByText('Miami Valley Hydraulics').first().click();
await expectText(page, 'DAY-FG', 'order shows finished-goods stock to ship from');
await page.click('button:has-text("Record shipment")');
await expectText(page, 'SH-000004', 'what is in stock ships as a second shipment');
await expectText(page, 'Partly shipped', 'order stays open for the rest');
await shot(page, '25-sales-order');

// Billing: invoice the new shipment, chase the overdue account
await signIn(page, 'casey');
await go(page, 'Receivables');
await expectText(page, 'Lakeshore Robotics', 'receivables list shows open invoices');
await expectText(page, 'Overdue', 'overdue invoice is flagged');
await page.click('button[role="tab"]:has-text("Ready to invoice")');
await expectText(page, 'Miami Valley Hydraulics', 'second shipment is ready to invoice');
await page.click('button:has-text("Create invoice")');
await expectText(page, 'Draft invoice', 'draft invoice opens');
await page.click('button:has-text("Issue invoice")');
await expectText(page, /INV-000004/, 'issuing assigns the next invoice number');
await expectText(page, 'Due', 'issued invoice shows its due date');
await shot(page, '26-invoice');
await go(page, 'Receivables');
await page.click('button[role="tab"]:has-text("Collections")');
await expectText(page, 'Kim Ostrowski', 'collections queue shows the contact to call');
await expectText(page, 'None', 'customer never contacted is flagged');
await shot(page, '27-collections');
await page.click('button[role="tab"]:has-text("Invoices")');
await page.locator('tr', { hasText: 'Lakeshore Robotics' }).first().click();
await expectText(page, 'Accounting system', 'payment received back from accounting is shown');
await expectText(page, 'No primary contact email', 'reminder needs a contact email (the import rejected an invalid one)');
await page.fill('#call-summary', 'Kim says the balance goes out with Friday\'s check run.');
await page.fill('#call-promise', new Date(Date.now() + 3 * 86_400_000).toISOString().slice(0, 10));
await page.click('button:has-text("Log call")');
await expectText(page, "Friday's check run", 'collections call is logged on the invoice');
await expectText(page, /Check payment promised by/, 'promise to pay becomes a follow-up');
await shot(page, '28-invoice-collections');
await go(page, 'Receivables');
await page.locator('tr', { hasText: 'Buckeye Medical Devices' }).first().click();
await page.click('button:has-text("Email payment reminder")');
await expectText(page, 'Reminder queued to ohaddad@buckeyemed.example', 'payment reminder queued to the primary contact');

// Finance releases an order on credit hold
await signIn(page, 'morgan');
await go(page, 'Quotes & orders');
await page.click('button[role="tab"]:has-text("Orders")');
await page.getByText('Tri-County Ag Equipment').first().click();
await expectText(page, 'Credit hold.', 'order over the credit limit is held');
await expectText(page, /over the credit limit of 5000.00/, 'hold explains the exposure');
await page.fill('#so-release', 'Dale agreed to 50% deposit by card; balance on Net 30.');
await page.click('button:has-text("Release hold")');
await expectText(page, 'Released: Dale agreed', 'release reason is recorded');
await shot(page, '29-credit-release');

// Production supervisor: a live order short of an in-house part, a product revision from the BOM import
await signIn(page, 'carlos');
await go(page, 'Production orders');
await expectText(page, 'MO-000002', 'production orders list');
await page.getByText('MO-000002').first().click();
await expectText(page, 'made in house', 'in-house component is marked');
await expectText(page, 'SO-000001', 'order shows the sales order it is for');
await shot(page, '31-production-order');
await page.click('button:has-text("Make 10")');
await expectText(page, 'KIT-AH220-SEAL', 'a production order for the short component opens');
await page.click('button:has-text("Release to the floor")');
await expectText(page, /Released; all materials are covered|Released\. Short/, 'component order released');
await go(page, 'Production orders');
await page.click('button[role="tab"]:has-text("Products")');
await page.getByText('HSG-220').first().click();
await expectText(page, 'Face, turn OD and bore from bar', 'routing shown on the product revision');
await expectText(page, 'Rev C drawing', 'revision notes shown');
await shot(page, '32-product-revision');

// Operator on the shop floor: deburr the milled housings, then inspect on the CMM (qualified)
await signIn(page, 'tolu');
await go(page, 'Shop floor');
await page.selectOption('#floor-wc', { label: 'DAY · DEBURR · Deburr, wash and assemble (2 waiting)' });
await expectText(page, 'Waiting here', 'work-center queue');
await page.locator('tr', { hasText: 'MO-000002' }).locator('button:has-text("Start")').click();
await expectText(page, 'Your job: MO-000002 op 30', 'running job shown to the operator');
await page.fill('#stop-good', '40');
await page.fill('#stop-rework', '2');
await page.click('button:has-text("Stop and record")');
await expectText(page, 'KIT-AH220-SEAL', 'next job in the queue');
await page.selectOption('#floor-wc', { label: 'DAY · INSPECT · Final inspection (CMM) (1 waiting)' });
await expectText(page, 'CMM-OP', 'machine shows the qualification operators need');
await page.locator('tr', { hasText: 'MO-000002' }).locator('button:has-text("Start")').click();
await page.fill('#stop-good', '39');
await page.fill('#stop-scrap', '1');
await page.selectOption('#stop-reason', { label: 'Surface damage / finish' });
await page.click('button:has-text("Stop and record")');
await expectText(page, 'more to come', 'inspection waits for the rest from milling');
await page.selectOption('#floor-wc', { label: 'DAY · VMC · Vertical machining (1 waiting)' });
await expectText(page, 'Carlos Reyes', 'supervisor\'s running job shows on the VMC');
await shot(page, '33-shop-floor');

// Quality: contain a receiving nonconformance, verify a corrective action's effectiveness
await signIn(page, 'sam');
await go(page, 'Quality');
await expectText(page, 'Not yet contained', 'nonconformance list KPIs');
await page.locator('tr', { hasText: 'hardness' }).first().click();
await expectText(page, 'Not contained yet.', 'receiving nonconformance opens');
await page.fill('#ncr-containment', 'Lot 5512 held in receiving quarantine; supplier notified');
await page.click('button:has-text("Record containment")');
await expectText(page, 'Lot 5512 held', 'containment recorded');
await page.setInputFiles('input[aria-label="Add a file"]', { name: 'oring-cert.png', mimeType: 'image/png', buffer: Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex') });
await page.click('button:has-text("Add file")');
await expectText(page, 'oring-cert.png', 'photo attached to the nonconformance');
await shot(page, '35-ncr');
await go(page, 'Quality');
await page.click('button[role="tab"]:has-text("Corrective actions")');
await page.getByText('Scrap from spindle alarms on CNC-101').click();
await expectText(page, 'Checked by quality, not by the owner', 'effectiveness check waits for quality');
await page.fill('#capa-evidence', 'No spindle alarms in 6 weeks; clamp force within spec at two PMs');
await page.click('button:has-text("Record check")');
await expectText(page, 'No spindle alarms in 6 weeks', 'effectiveness evidence recorded');
await shot(page, '36-capa-closed');
await go(page, 'Quality');
await page.click('button[role="tab"]:has-text("Calibration")');
await expectText(page, 'Overdue', 'overdue instrument flagged');
await page.getByText('BG-250').first().click();
await page.fill('#calr-by', 'Sam Okafor');
await page.fill('#calr-cert', 'RL-2250-26');
await page.fill('#calr-notes', 'Setting ring 2.2500 in: reads 2.2501');
await page.click('button:has-text("Record calibration")');
await expectText(page, /Current · due \d{4}-\d{2}-\d{2}/, 'calibration recorded and instrument current');
await go(page, 'Quality');
await page.click('button[role="tab"]:has-text("Calibration")');
await page.getByText('CMM-01').first().click();
await expectText(page, 'Used for production since the last good calibration', 'instrument usage since last good calibration');
await expectText(page, 'MO-000001', 'production runs measured on the CMM listed');
await shot(page, '42-calibration');
await go(page, 'Quality');
await page.click('button[role="tab"]:has-text("Audits")');
await page.getByText('Production control, machining cell').click();
await expectText(page, 'Minor nonconformity', 'audit finding shown with its response options');
await page.click('button:has-text("Corrective action")');
await expectText(page, /CA-\d{6}/, 'finding answered with a corrective action');
await page.click('button:has-text("Close audit")');
await expectText(page, 'Closed', 'audit closed');
await shot(page, '43-audit');

// The corrective action owner finishes an overdue action and moves to verification
await signIn(page, 'carlos');
await go(page, 'Quality');
await page.click('button[role="tab"]:has-text("My actions")');
await expectText(page, 'Overdue', 'overdue action shows for its owner');
await page.locator('tr', { hasText: 'in-process bore check' }).locator('input').fill('Bore check every 10 parts added to op 10; routing rev 2 drafted');
await page.locator('tr', { hasText: 'in-process bore check' }).locator('button:has-text("Done")').click();
await expectText(page, 'No open actions assigned to you.', 'action completed');
await page.click('button[role="tab"]:has-text("Corrective actions")');
await page.getByText('Repeat bore oversize on HSG-220 turning').click();
await page.click('button:has-text("Move to Effectiveness check")');
await expectText(page, 'Checked by quality, not by the owner', 'corrective action moved to verification');
await shot(page, '37-capa');

// FMEA: the owner sees a failure mode happening more than rated, and sends a process FMEA for review once its high-priority row has an action
await go(page, 'Quality');
await page.click('button[role="tab"]:has-text("FMEA")');
await page.getByText('CNC-104 turning cell').click();
await expectText(page, /happened 2 times in 12 months; occurrence 2 may be too low/, 'FMEA flags a failure mode happening more than rated');
await expectText(page, 'High after actions', 'FMEA shows risk before and after actions');
await shot(page, '46-fmea');
await go(page, 'Quality');
await page.click('button[role="tab"]:has-text("FMEA")');
await page.getByText('HSG-220 machining and assembly').click();
await page.click('button:has-text("Send for quality review")');
await expectText(page, /row 1 needs a recommended action/, 'high-priority row needs an action before review');
await page.locator('tr', { hasText: 'O-ring missing' }).locator('button:has-text("+ action")').click();
await page.fill('#fmea-action', 'Poka-yoke: kit tray with one cavity per seal; leak test at op 40');
await page.selectOption('#fmea-action-owner', { label: 'Marcus Kowalski' });
await page.click('button:has-text("Add")');
await page.click('button:has-text("Send for quality review")');
await expectText(page, 'In review', 'FMEA sent for quality review');
await shot(page, '47-fmea-review');

// Planning: forecasts and firm orders against capacity; a second-shift scenario; the forecast version view
await signIn(page, 'carlos');
await go(page, 'Planning');
await expectText(page, 'Work-center load', 'capacity plan renders');
await expectText(page, /LATHE/, 'plan lists the lathe');
await expectText(page, /BAR-6061-250/, 'plan lists material needs');
await expectText(page, /Assumptions this plan had to make/, 'plan states its assumptions');
await expectText(page, 'Qualified operators', 'plan checks qualified operators');
await expectText(page, 'Consumables, chemicals and PM parts', 'plan forecasts consumables and PM parts');
await expectText(page, /1 per 90 units/, 'insert usage read as 1 per 90 units');
await expectText(page, /CNC-TURN expires/, 'plan names the qualification that lapses');
await shot(page, '63-capacity-plan');
await page.selectOption('#plan-scenario', { label: 'Second shift on the lathe' });
await expectText(page, /\(was \d+\.\d%\)/, 'scenario compared with the plan as is');
await page.selectOption('#plan-scenario', { label: 'As planned (no scenario)' });
await page.click('button:has-text("Draft a purchase request for")');
await expectText(page, /Drafted PR-\d+/, 'purchase request drafted from the plan shortfall');
await page.locator('button:has-text("create order")').first().click();
await expectText(page, /as planned orders/, 'planned production order created from the plan');
await shot(page, '65-plan-actions');
await page.click('button[role="tab"]:has-text("Forecasts")');
await page.getByText('Miami Valley Hydraulics').first().click();
await expectText(page, /forecast version 1/, 'forecast version view');
await shot(page, '64-forecast');

// SPC: a drifting bore raises signals; quality answers one with a nonconformance; a CMM reading is recorded
await signIn(page, 'sam');
await page.goto(`${BASE}/quality?tab=spc`);
await expectText(page, 'Signal open', 'SPC list shows the drifting bore');
await page.locator('tr', { hasText: 'HSG-BORE' }).click();
await expectText(page, 'Signals waiting for an investigation', 'open signals listed on the characteristic');
await expectText(page, 'Subgroup means (X̄)', 'X-bar chart drawn');
await expectText(page, /Limits set .* from 25 subgroups/, 'limits come from the baseline');
await shot(page, '66-spc-chart');
await page.locator('button:has-text("Answer")').first().click();
await page.fill('#sig-cause', 'Boring insert worn past its life');
await page.fill('#sig-response', 'Insert changed, offset reset; parts since 08:00 sorted on the bore gauge');
await page.check('#sig-ncr');
await page.click('button:has-text("Close the signal")');
await expectText(page, 'Answered signals', 'signal answered with a nonconformance');
await page.goto(`${BASE}/quality?tab=spc`);
await page.locator('tr', { hasText: 'HSG-FLAT' }).click();
await page.fill('#spc-v1', '0.0079');
await page.click('button:has-text("Record")');
await expectText(page, 'Recorded; no signal', 'reading recorded within limits');
await page.goto(`${BASE}/quality?tab=spc`);
await page.locator('tr', { hasText: 'HSG-LEAK' }).click();
await expectText(page, /p chart · fraction defective/, 'attribute (p) chart page');
await expectText(page, /Limits step with each sample size/, 'p chart limits step with sample size');
await shot(page, '67-p-chart');
await page.fill('#attr-count', '1');
await page.fill('#attr-n', '60');
await page.click('button:has-text("Record")');
await expectText(page, /Recorded; no signal|quality has been told/, 'attribute sample recorded');

// Supplier performance: scorecards from orders, receipts, NCRs and imported history; a corrective action request answered
await signIn(page, 'dana');
await go(page, 'Purchasing');
await page.click('button[role="tab"]:has-text("Supplier performance")');
await expectText(page, 'Ridgeway Press Brake Parts', 'scorecards list the poor supplier first');
await shot(page, '68-supplier-performance');
await page.locator('tr', { hasText: 'Ridgeway Press Brake Parts' }).click();
await expectText(page, 'Performance, last 90 days', 'supplier page shows its scorecard');
await page.locator('a', { hasText: /^CA-\d+$/ }).first().click();
await expectText(page, /Waiting/, 'corrective action request waits for the supplier');
await page.fill('#scar-response', '8D received: compound batch mixed at the wrong cure time; batch quarantined, 100% durometer check for 3 lots');
await page.click('button:has-text("Record their answer")');
await expectText(page, 'Answered', 'supplier answer recorded on the corrective action');

// Safety: the safety team classifies a near miss; a manager sees no private details; an operator reports
await signIn(page, 'jordan');
await go(page, 'Safety');
await expectText(page, 'Not yet classified', 'incident list KPIs');
await page.locator('tr', { hasText: 'VMC cell' }).first().click();
await page.click('button:has-text("Classify")');
await page.selectOption('#cls-severity', 'high');
await page.click('button:has-text("Save classification")');
await page.click('button:has-text("Record root cause")');
await page.fill('#inv-root', 'Side panel interlock bypassed with tape; no check of interlocks in the PM');
await page.click('button:has-text("Save")');
await page.fill('#action-title', 'Remove bypass, repair interlock, add interlock check to CNC-101 PM');
await page.selectOption('#action-owner', { label: 'Marcus Kowalski' });
await page.click('button:has-text("Add action")');
await expectText(page, 'Remove bypass, repair interlock', 'safety action added');
await shot(page, '38-incident');
await go(page, 'Safety');
await page.locator('tr', { hasText: 'Raw material rack' }).first().click();
await expectText(page, 'Lumbar strain', 'safety team sees injury details');
await signIn(page, 'alex');
await go(page, 'Safety');
await page.locator('tr', { hasText: 'Raw material rack' }).first().click();
await expectText(page, 'visible to the safety team only', 'manager does not see injury details');
if (await page.getByText('Lumbar strain').count()) throw new Error('private injury details shown to a manager');
await signIn(page, 'tolu');
await go(page, 'Safety');
await page.click('label:has-text("Near miss")');
await page.fill('#inc-location', 'Saw area');
await page.fill('#inc-description', 'Bar rolled off the rack when the strap was cut');
await page.click('button:has-text("Send report")');
await expectText(page, 'Thank you for reporting', 'operator reports a near miss');
await shot(page, '39-near-miss');

// Continuity: the plan owner sees gaps from live records and records a timed full test within the RTO; EHS finishes a draft plan
await signIn(page, 'alex');
await go(page, 'Continuity');
await expectText(page, 'HSG-220 housing supply to Lakeshore Hydraulics', 'continuity plans listed');
await page.getByText('HSG-220 housing supply to Lakeshore Hydraulics').click();
await expectText(page, /estimated 96 h recovery exceeds the 48 h RTO/, 'plan flags a recovery estimate over the RTO');
await expectText(page, /Only 1 current holder of HMC-201 spindle service/, 'plan checks skill holders against qualifications');
await expectText(page, /only source for \d+ parts/, 'plan flags a sole-source supplier');
await page.locator('tr', { hasText: 'Full test' }).locator('button:has-text("Record result")').click();
await page.fill('#bcp-hours', '30');
await page.fill('#bcp-participants', 'Marcus Kowalski, Priya Shah, Carlos Reyes');
await page.fill('#bcp-findings', 'Op 10 moved to CNC-102 in 5 h with the fixture at the cell; first piece good.');
await page.click('form button:has-text("Record result")');
await expectText(page, '30 h', 'timed full test within the RTO demonstrates it');
await page.fill('#bcp-review', 'Called every number on the call list; Lakeshore buffer still 3 days');
await page.click('button:has-text("Confirm review")');
await expectText(page, /Last reviewed \d{4}-\d{2}-\d{2}: Called every number/, 'periodic review confirmed');
await shot(page, '49-continuity');
await signIn(page, 'jordan');
await go(page, 'Continuity');
await page.getByText('Bracket forming on PRS-01').click();
await page.click('button:has-text("Send for plant manager approval")');
await expectText(page, /add the call list/, 'plan needs a call list before approval');
await page.click('button:has-text("Edit call list")');
await page.fill('[aria-label="Contact 1 name"]', 'Sean Brennan');
await page.fill('[aria-label="Contact 1 role"]', 'Plan owner (maintenance lead)');
await page.fill('[aria-label="Contact 1 phone"]', '+1 260 555 0120');
await page.click('button:has-text("Save call list")');
await page.click('button:has-text("Send for plant manager approval")');
await expectText(page, 'In review', 'continuity plan sent for approval');
await signIn(page, 'alex');
await go(page, 'Approvals');
await expectText(page, /Continuity plan approval/, 'plant manager sees the continuity plan to approve');
await expectText(page, /BCP-002 rev 1: Press brake continuity/, 'approval card names the plan');
await shot(page, '50-continuity-approval');

// Landlord (other tenant): a resident reports a problem without signing in; the property manager sees only their portfolio,
// turns a request into a work order and sends it to a contractor with a not-to-exceed; a lapsed certificate blocks dispatch.
await page.goto(BASE);
await page.evaluate(() => sessionStorage.clear());
await page.goto(`${BASE}/r/${token('maple court')}`);
await expectText(page, 'Maple Court Apartments', 'request link opens the site form without signing in');
await page.selectOption('#pub-place', { label: 'Building B › Unit 302' });
await page.fill('#pub-description', 'Bedroom window will not close all the way');
await page.fill('#pub-name', 'Priya Nair (302)');
await page.fill('#pub-contact', '614-555-0177');
await page.selectOption('#pub-entry', 'no');
await page.click('button:has-text("Send request")');
await expectText(page, /Your reference is R-[0-9A-F]{8}/, 'resident gets a reference');
await shot(page, '53-public-request');
await signIn(page, 'dev');
await go(page, 'Sites');
await expectText(page, 'Willow Row Townhomes', 'property manager sees the portfolio sites');
if (await page.getByText('Cedar Plaza').count()) throw new Error('property manager sees a site outside the portfolio');
await shot(page, '54-sites');
await expectText(page, /Properties licensed/, 'property licence usage shown');
await expectText(page, /of 100/, 'licensed in a band of up to 100 properties');
await go(page, 'Work orders');
await expectText(page, /Response missed/, 'work order list shows a missed response target');
await page.click('button:has-text("Requests")');
await expectText(page, 'Bedroom window will not close all the way', 'request from the link lands in the inbox');
await expectText(page, /614-555-0177 · call first/, 'inbox shows contact and entry permission');
await page.locator('tr', { hasText: 'Hallway light out' }).locator('button:has-text("Create work order")').click();
await page.click('form button:has-text("Create")');
await expectText(page, 'Send to a contractor', 'work order from a request can go to a contractor');
await page.click('button:has-text("Send to a contractor")');
await page.locator('#dispatch-contractor option', { hasText: 'Sparks Electric' }).waitFor({ state: 'attached' });
if (!(await page.locator('#dispatch-contractor option[disabled]', { hasText: /Handy Andy Repairs.*insurance lapsed/ }).count())) throw new Error('contractor without insurance not shown as lapsed');
checks.push('ok  contractor without insurance shown as lapsed and cannot be chosen');
await page.selectOption('#dispatch-contractor', { label: 'Sparks Electric (electrical)' });
await page.fill('#dispatch-nte', '250');
await page.click('button:has-text("Dispatch")');
await expectText(page, /not to exceed \$250\.00/, 'dispatched with a not-to-exceed');
await shot(page, '55-contractor-dispatch');
// Leasing: rent roll with holdovers and past due, a new lease on a vacant unit, the late unit turn, next month's rent run, a renewal
await go(page, 'Leasing');
await expectText(page, 'month to month', 'rent roll shows a holdover lease');
await expectText(page, /\$3,590\.00 past due/, 'rent roll shows rent past due after grace');
await page.locator('tr', { hasText: 'MAPLE-202' }).locator('button:has-text("New lease")').click();
await page.fill('#lease-name', 'Riley Morgan');
await page.fill('#lease-email', 'riley.morgan@example.com');
await page.click('button:has-text("Create draft lease")');
await page.click('button:has-text("Signed: start the lease")');
await expectText(page, 'active', 'new lease signed and active');
await shot(page, '57-lease');
await go(page, 'Leasing');
await page.click('button[role="tab"]:has-text("Unit turns")');
await expectText(page, /late/, 'unit turn past its target is flagged');
await expectText(page, /0 \/ 2 done/, 'unit turn lists its make-ready jobs');
await page.click('button[role="tab"]:has-text("Rent billing")');
await page.fill('#bill-period', new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth() + 1, 1)).toISOString().slice(0, 7));
await expectText(page, /Rent, Unit 101/, 'rent billing previews next month');
await page.click('button:has-text("rent invoices")');
await expectText(page, /invoices? for \d{4}-\d{2}/, 'rent invoices issued');
await shot(page, '58-rent-billing');
await go(page, 'Leasing');
await page.click('button[role="tab"]:has-text("Rent roll")');
await page.getByText('Hannah Lee').click();
await page.click('button:has-text("Renew")');
await page.fill('#renew-end', '2027-11-30');
await page.fill('#renew-rent', '1495');
await page.click('form button:has-text("Renew")');
await expectText(page, /renews LSE-/, 'renewal creates the next lease');
await signIn(page, 'riya');
await go(page, 'Reports');
await page.getByText('Service levels by site and contractor').click();
await expectText(page, /of work completed within target over 90 days/, 'service level report headline');
await expectText(page, /invoiced over the not-to-exceed, by \$120\.00/, 'service level report flags spend over the not-to-exceed');
await shot(page, '56-report-service-levels');
await go(page, 'Reports');
await page.getByText('Rent roll and occupancy').click();
await expectText(page, /\d+\.\d% occupied \(\d+ of 16 rentable units\)/, 'rent roll report headline');
await expectText(page, /Past due after the grace period: MAPLE-302 Grace Kim/, 'rent roll report names past-due renters');
await shot(page, '59-report-rent-roll');

// Retail (other tenant): a store manager logs a warm cooler (one request per excursion); the district manager walks a store
await signIn(page, 'mina');
await go(page, 'Conditions & visits');
await expectText(page, 'S101-WIC-1', 'store manager sees the store\'s condition logs');
if (await page.getByText('S102-WIC-1').count()) throw new Error('store manager sees another store\'s logs');
await page.fill('[aria-label="Reading for S101-WIC-1"]', '45');
await page.fill('[aria-label="Note for S101-WIC-1"]', 'Door left open after delivery');
await page.locator('tr', { hasText: 'S101-WIC-1' }).locator('button:has-text("Log")').click();
await expectText(page, 'Out of limits: maintenance has been asked to check it.', 'out-of-limit reading raises a request');
await shot(page, '60-conditions');
await signIn(page, 'jo (');
await go(page, 'Conditions & visits');
await expectText(page, /out since/, 'district manager sees the open excursion at another store');
await expectText(page, /missed/, 'missed readings are flagged');
await page.click('button[role="tab"]:has-text("Visits")');
await page.selectOption('#visit-site', { label: 'S103 Northwind Express Monroe' });
await page.selectOption('#visit-template', { label: 'Monthly store walk' });
await page.click('button:has-text("Start visit")');
await expectText(page, '0 of 12 answered', 'visit started from the checklist');
for (let i = 0; i < 12; i++) {
  const row = page.locator('.visit-answer').first();
  if (i === 4) {
    await row.locator('input').fill('Reach-in cooler log has no entries for two days');
    await row.locator('select').selectOption({ label: 'S103-RIC-1 Reach-in cooler (grab and go)' });
    await row.locator('button:has-text("Fail")').click();
  } else await row.locator('button:has-text("Pass")').click();
  await page.getByText(`${i + 1} of 12 answered`).waitFor({ timeout: 8000 });
}
await page.click('button:has-text("Complete visit")');
await expectText(page, /91\.7% · 1 critical/, 'visit scored with its critical miss');
await expectText(page, 'maintenance request raised', 'failed equipment item raised a request');
await shot(page, '61-store-visit');
await go(page, 'Reports');
await page.getByText('Store standards and conditions').click();
await expectText(page, /below the 85\.0% standard on the latest visit/, 'store standards report headline');
await shot(page, '62-report-store-standards');

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
await go(page, 'Reports');
await page.getByText('Accounts receivable aging').click();
await expectText(page, /receivables overdue/, 'AR aging report renders');
await expectText(page, 'Days sales outstanding', 'AR aging shows DSO');
await shot(page, '30-report-ar');
await go(page, 'Reports');
await page.getByText('Production status and yield').click();
await expectText(page, /first-pass yield \d/, 'production report headline');
await expectText(page, /Top scrap reason/, 'production report names the top scrap reason');
await shot(page, '34-report-production');
await go(page, 'Reports');
await page.getByText('Nonconformances and corrective actions').click();
await expectText(page, /cost of poor quality in 90 days/, 'quality report headline');
await shot(page, '40-report-quality');
await go(page, 'Reports');
await page.getByText('Safety incidents and near misses').click();
await expectText(page, /1 recordable case and \d+ near misses in 365 days/, 'safety report headline');
await expectText(page, /Incident rate [\d.]+ per 200,000 hours/, 'incident rate from timesheet hours');
await shot(page, '41-report-safety');
await go(page, 'Reports');
await page.getByText('Capacity and material plan').click();
await expectText(page, /LATHE is loaded to \d+\.\d% in \w{3} \d{4}/, 'capacity plan report names the bottleneck');
await shot(page, '65-report-capacity');
await go(page, 'Reports');
await page.getByText('FMEA risk register').click();
await expectText(page, /high-priority failure mode open across 2 FMEAs/, 'FMEA risk register headline');
await shot(page, '48-report-fmea');
await go(page, 'Reports');
await page.getByText('Continuity readiness').click();
await expectText(page, /Recovery within the RTO shown in a timed exercise for 1 of 1 approved plan/, 'continuity readiness headline');
await shot(page, '51-report-continuity');
await go(page, 'Reports');
await page.getByText('Equipment reliability (MTBF / MTTR)').click();
await expectText(page, /HMC-201 is the worst actor: \d+ failures in 90 days, MTBF [\d.]+ h/, 'reliability report names the bad actor');
await expectText(page, 'State coverage', 'reliability report shows how much of the period is measured');
await shot(page, '52-report-reliability');

await browser.close();
console.log(checks.join('\n'));
if (errors.length) {
  console.error(`\n${errors.length} problem(s):\n${errors.join('\n')}`);
  process.exit(1);
}
console.log(`\nall UI checks passed; screenshots in ${OUT}`);
