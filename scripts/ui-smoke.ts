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
  await page.click('summary:has-text("Development sign-in")');
  await page.fill('#token', token(who));
  await page.click('button:has-text("Sign in with token")');
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
const PATHS: Record<string, string> = { Home: '/', Assets: '/assets', 'Work orders': '/work-orders', PM: '/pm', Storerooms: '/inventory', 'Scan station': '/scan', 'Field service': '/service', 'My day': '/service/my-day', Purchasing: '/purchasing',
  Payables: '/ap', Changes: '/changes', Approvals: '/approvals', Training: '/training', Time: '/time', Reports: '/reports', 'Data import': '/imports', Accounting: '/integrations', Customers: '/crm', 'Quotes & orders': '/sales', Receivables: '/receivables', Quality: '/quality', Safety: '/safety', 'Production orders': '/production', 'Shop floor': '/production/floor', Continuity: '/continuity', Sites: '/sites', Leasing: '/leasing', 'Conditions & visits': '/stores', Planning: '/planning', 'Shift log': '/shift-log', Improvements: '/improvements', 'Policies & handbook': '/policies', People: '/people', 'News and events': '/news', Notifications: '/notifications', Expenses: '/expenses', Budgets: '/budgets', Books: '/books', 'Sign-in': '/sign-in-settings', Reviews: '/reviews', Performance: '/performance', 'CAPA & 8D': '/capa', 'Business cases': '/proforma', 'Archives and restore': '/archives', 'Document control': '/documents' };
/** Opens a sidebar destination (opening the drawer first at phone width). */
async function go(page: Page, label: string) {
  const nav = page.locator('nav[aria-label="Main"]');
  const link = nav.locator(`a[href="${PATHS[label]}"]`).first();
  if (await link.isVisible()) return link.click();
  // Phone width: the sidebar is a drawer behind "Menu".
  const menu = page.locator('button.menu-button');
  if (await menu.isVisible()) {
    await menu.click();
    if (await link.isVisible()) return link.click();
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
// Single sign-on (D-140): a work email whose company has no identity provider set up gets a clear answer.
await page.goto(BASE);
await page.fill('#sso-email', 'someone@nowhere-configured.example');
await page.click('button:has-text("Continue with your company account")');
await expectText(page, /single sign-on is not set up for nowhere-configured.example/, 'single sign-on explains when a company has not set it up');
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
// A change review records its result (ISO 9001 8.5.6, D-158): approve stays disabled until it is written.
await expectText(page, 'Result of your review (required', 'a change review asks for the result of the review');
if (await page.locator('button:has-text("Approve as")').isEnabled()) errors.push('a change could be approved without recording the review result'); else checks.push('ok  a change cannot be approved without its review result');
await page.locator('textarea').first().fill('Safety data sheet reviewed: nitrile gloves already issued; no new waste stream.');
await page.click('button:has-text("Approve as")');
await expectText(page, 'Nothing is waiting for you.', 'approval clears the queue');

// Operations manager sees it next, then opens the change
await signIn(page, 'alex');
await go(page, 'Approvals');
await expectText(page, 'Authorize the change', 'authorization step reaches operations');
await go(page, 'Changes');
await page.getByText('MOC-000001').first().click();
await expectText(page, 'Action plan', 'change page shows action plan');
await expectText(page, 'Planning (ISO 9001 6.3)', 'change page shows its ISO 9001 planning');
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
await expectText(page, 'Stocked and counted in', 'a part shows its stock unit');
await page.fill('input[aria-label="Unit"]', 'DR');
await page.locator('input[aria-label^="How many"]').fill('5');
await page.click('button:has-text("Add unit")');
await expectText(page, /1 DR = 5 /, 'a purchase unit can be added to a part (a drum of 5)');
await shot(page, '13-storeroom');
// Lots (D-147): the coolant's lots with expiry and a quarantined lot; a lot's page.
await page.click('button[role="tab"]:has-text("Lots")');
await expectText(page, 'TC-25-0402', 'tracked stock is listed by lot');
try { await page.locator('table').getByText('On hold').first().waitFor({ timeout: 8000 }); checks.push('ok  a lot on hold is marked'); } catch { errors.push('a lot on hold is not marked'); }
await page.getByText('TC-24-0917').first().click();
await expectText(page, 'supplier lot MF2409-17', 'a lot page shows the supplier lot');
await expectText(page, 'Where it went', 'a lot page traces where it went');
await shot(page, '13b-lot');
await go(page, 'Reports');
await page.getByText('Lot expiry and holds').click();
await expectText(page, /1 lot expiring within 30 days .*; 1 lot on hold/, 'lot expiry and holds report answers first');
await go(page, 'Storerooms');
await page.selectOption('#rcv-loc', { label: 'DAY-MAIN · Dayton main storeroom' });
const oil = await page.locator('#rcv-part option', { hasText: 'CMP-OIL-ROTO' }).getAttribute('value');
await page.selectOption('#rcv-part', oil!);
await page.fill('#rcv-qty', '4');
await page.fill('#rcv-cost', '305');
await page.click('button:has-text("Receive")');
await expectText(page, /CMP-OIL-ROTO at DAY-MAIN is now 6/, 'receiving updates on-hand');
// Scan station: a scanner types the code and presses Enter; look up, then issue to a job reference through the same ledger
await go(page, 'Scan station');
await page.click('button[role="tab"]:has-text("Look up")');
await page.fill('#scan-input', 'CMP-OIL-ROTO'); await page.keyboard.press('Enter');
await expectText(page, 'DAY-MAIN', 'scanning a part number shows where it is on hand');
await page.fill('#scan-input', 'NOT-A-REAL-CODE'); await page.keyboard.press('Enter');
await expectText(page, /is not a part, location, lot, purchase order or work order/, 'an unknown scan is refused with the reason');
await page.click('button[role="tab"]:has-text("Issue")');
await page.fill('#scan-input', 'L:DAY-MAIN'); await page.keyboard.press('Enter');
await expectText(page, /Issuing from DAY-MAIN/, 'scanning a location label sets the storeroom');
await page.fill('#scan-ref', 'JOB-SMOKE-1');
await page.fill('#scan-input', 'CMP-OIL-ROTO'); await page.keyboard.press('Enter');
await page.click('button:has-text("Issue 1")');
await expectText(page, /Issued 1 × CMP-OIL-ROTO to JOB-SMOKE-1/, 'issue by scan posts to the ledger');
await shot(page, '13c-scan-station');
await go(page, 'Storerooms');
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
// The built-in daily job now also syncs (D-183B), so it may already have sent one of the two before this click.
await expectText(page, /Sync finished: [12] sent/, 'sync sends the approved invoice and the approved expense report');
await expectText(page, 'MOCK-B-00004', 'the approved invoice reached the accounting system');
await expectText(page, 'MOCK-B-00003', 'the approved expense report reached the accounting system');
await page.locator('tr', { hasText: 'RW-44190' }).locator('button:has-text("Pay in accounting")').click();
await page.click('button:has-text("Sync now")');
await expectText(page, /1 payment received/, 'payment made in accounting comes back');
await shot(page, '21-accounting');
await go(page, 'Sign-in');
await expectText(page, 'Redirect URL', 'sign-in settings show the redirect URL to register with the identity provider');
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
await page.fill('#q-lead', '3 weeks from purchase order');
await page.fill('#q-excl', 'Freight and taxes');
await page.click('button:has-text("Save draft")');
await expectText(page, '3 weeks from purchase order', 'quote terms are kept and shown');
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
await signIn(page, 'riley');
await go(page, 'Quotes & orders');
await page.getByText('Surgical handle prototype, 25 pcs').first().click();
await page.click('button:has-text("Mark as sent")');
await expectText(page, 'Record the customer\'s acceptance', 'sent quote offers the acceptance record');
await expectText(page, 'Extend validity to', 'sent quote offers a tracked extension');
await page.fill('#q-ext-date', new Date(Date.now() + 45 * 86_400_000).toISOString().slice(0, 10));
await page.fill('#q-ext-reason', 'Customer budget approval pending');
await page.click('button:has-text("Extend")');
await expectText(page, 'Validity history', 'extension is kept with its reason');
await page.fill('#q-acc-name', 'Pat Lindqvist');
await page.selectOption('#q-acc-method', 'email');
await page.click('button:has-text("Customer accepted")');
await expectText(page, /from Q-\d+/, 'acceptance creates the sales order');
await page.click('a:has-text("Q-")');
await expectText(page, /Accepted .* by Pat Lindqvist/, 'acceptance is recorded with who and how');
await shot(page, '24b-quote-accepted');
await signIn(page, 'taylor');
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
// 8D: the disciplines say what is missing; deciding the last read-across and recording the systemic changes completes D7.
await go(page, 'Quality');
await page.click('button[role="tab"]:has-text("Corrective actions")');
await page.getByText('Burrs in cross-drilled port (Lakeshore 8D)').click();
await expectText(page, '5 of 8 complete', '8D disciplines counted');
await expectText(page, 'decide every read-across', '8D says what D7 still needs');
await expectText(page, 'Housings drilled on VMC-1 with the same program', 'is / is not shown');
await page.fill('input[aria-label="What was found at Other cross-drilled parts (KIT-AH220 manifold)"]', 'Manifold port is reamed after drilling; no exit burr possible');
await page.selectOption('select[aria-label="Applies to Other cross-drilled parts (KIT-AH220 manifold)"]', 'false');
await page.click('button:has-text("Decide")');
await expectText(page, 'Manifold port is reamed', 'read-across decided');
await page.fill('#capa-prevention', 'PFMEA op 30 updated for exit burrs; borescope check in the control plan; drill-change checklist asks for a burr check');
await page.locator('section', { hasText: 'D7 Prevent recurrence' }).locator('button:has-text("Save")').click();
await expectText(page, '6 of 8 complete', 'D7 complete after prevention and read-across');
await shot(page, '36b-8d');
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
await page.locator('tr', { hasText: 'in-process bore check' }).waitFor({ state: 'detached' });
await expectText(page, 'Add a back-deburr tool pass', 'action completed; the 8D action stays in the list');
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

// Shift log: the supervisor reads the machining handover and takes over
await signIn(page, 'carlos');
await go(page, 'Shift log');
await expectText(page, 'Handed over, not yet read', 'shift log waits to be read');
await page.locator('tr', { hasText: 'Handed over, not yet read' }).first().click();
await expectText(page, 'Coolant leak under VMC cell', 'handover shows safety notes and items');
await expectText(page, /carried from 2nd/, 'open item carried from the previous shift');
await shot(page, '69-shift-log');
await page.fill('#shift-ack', 'Maintenance called for the leak');
await page.click('button:has-text("I have read this and taken over")');
await expectText(page, 'Acknowledged', 'handover acknowledged by the incoming lead');

// Repair or replace: the aging VMC costs more to keep than a new one
await signIn(page, 'marcus');
await go(page, 'Assets');
await page.fill('#asset-q', 'CNC-101');
await page.getByText('Haas VF-4').first().click();
await expectText(page, 'Repair or replace', 'asset page compares keeping with replacing');
await expectText(page, /Keeping it is expected to cost [\d,]+ this year, more than the [\d,]+ a year a new one costs/, 'aging machine flagged for replacement');
await shot(page, '71-repair-or-replace');

// Improvements: a validated improvement, one measuring, and an idea the operations manager approves
await signIn(page, 'alex');
await go(page, 'Improvements');
await expectText(page, 'Quick-change fixture plates on the VMCs', 'improvement list shows the closed improvement');
await expectText(page, /\$14,500/, 'validated savings shown');
await page.getByText('Interlock check in the VMC chip conveyor PM').click();
await page.selectOption('#imp-owner', { label: 'Tolu Adeyemi' });
await page.click('button:has-text("Approve")');
await expectText(page, 'Approved', 'idea approved with an owner');
await shot(page, '70-improvement');

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
await expectText(page, /of 100/, 'licensed up to the 100-property cap');
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
// Filters from the report's own parameters, kept in the address; a saved view brings them back.
await page.fill('#flt-days', '30');
await page.click('button:has-text("Apply")');
await expectText(page, /PM compliance .* over 30 days|No PM work orders were due in the last 30 days/, 'a report filter changes the report');
if (!page.url().includes('days=30')) errors.push('report filters are not kept in the address'); else checks.push('ok  report filters are kept in the address');
await page.fill('input[aria-label="View name"]', 'Last 30 days');
await page.click('button:has-text("Save view")');
await page.click('button:has-text("Reset")');
await expectText(page, /over 90 days/, 'reset returns to the default filters');
await page.selectOption('#rep-view', { label: 'Last 30 days' });
await expectText(page, /over 30 days|in the last 30 days/, 'a saved view restores its filters');
await go(page, 'Reports');
await page.getByText('Maintenance backlog').first().click();
await page.getByRole('link', { name: /^Open / }).first().click();
await page.waitForURL(/\/work-orders\/[0-9a-f-]{36}$/);
checks.push('ok  a report row opens its work order');
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

// Policies: an employee reads and acknowledges the handbook; HR sees drafts with placeholders and the expense rules.
await signIn(page, 'carlos');
await go(page, 'Policies & handbook');
await expectText(page, 'Ridgeline Precision Machining employee handbook', 'handbook opens');
await expectText(page, /sections are new or changed since you last acknowledged/, 'handbook asks for acknowledgement');
await page.click('button:has-text("I have read the handbook")');
await expectText(page, 'Acknowledged', 'handbook acknowledged');
await shot(page, '70-handbook');
await signIn(page, 'lena');
await go(page, 'Policies & handbook');
await page.click('button[role="tab"]:has-text("All policies")');
await expectText(page, '2 to complete', 'draft sections show their placeholders to complete');
await page.getByText('Performance and discipline').click();
await expectText(page, /placeholders to complete before publishing/, 'draft cannot be published until completed');
await go(page, 'Policies & handbook');
await page.click('button[role="tab"]:has-text("Expense rules")');
await expectText(page, '$225.00', 'expense rules show the lodging limit');
await expectText(page, /\$0\.70 a mile/, 'expense rules show the mileage rate');
await shot(page, '71-expense-rules');

// Intranet: company news, events for the user's site, the directory and search.
await signIn(page, 'tolu');
await expectText(page, /Good (morning|afternoon|evening), Tolu/, 'intranet home greets the user');
await expectText(page, 'Open enrollment runs until November 15', 'pinned company news on the home page');
await expectText(page, 'Lakeshore Hydraulics audit at Dayton', 'site event shown to someone at that site');
await expectText(page, 'Benefits portal', 'quick links on the home page');
await shot(page, '72-intranet-home');
await page.fill('input[aria-label="Find a colleague"]', 'production office');
await page.press('input[aria-label="Find a colleague"]', 'Enter');
await expectText(page, 'Carlos Reyes', 'people directory finds a colleague by office');
await expectText(page, '937-555-0108', 'directory shows the work phone');
await page.fill('input[aria-label="Search people, policies, assets and records"]', 'forklift');
await page.press('input[aria-label="Search people, policies, assets and records"]', 'Enter');
await expectText(page, 'Forklift seat-belt check this week', 'search finds the announcement');
await shot(page, '73-search');
await signIn(page, 'dana');
await go(page, 'News and events');
await page.fill('#ann-title', 'Parking lot resurfacing Saturday');
await page.fill('#ann-body', 'Park on the **north side** on Saturday.');
await page.click('button:has-text("Post")');
await expectText(page, 'Parking lot resurfacing Saturday', 'announcement posted');

// Expenses: the claimant explains a flagged hotel and submits; the department head approves from the report.
await signIn(page, 'priya');
await go(page, 'Expenses');
await page.getByText('Hydraulics seminar, Cincinnati').click();
await expectText(page, 'receipt required over $25.00; attach it, or explain why there is none', 'expense line flagged for a missing receipt');
await expectText(page, '$14.00 over the $225.00 limit per expense for Lodging', 'expense line flagged over the lodging limit');
await expectText(page, 'Manager approval: Marcus Kowalski (head of Maintenance)', 'route shows the department head by name');
await page.click('button[aria-label="Edit line 1"]');
await page.fill('#line-explanation', 'Seminar hotel block; receipt emailed to the old address, requested again');
await page.click('button:has-text("Save change")');
await expectText(page, 'Ready to submit', 'explained exceptions let the report go');
await page.click('button:has-text("Submit for approval")');
await expectText(page, 'Waiting for approval', 'expense report submitted');
await shot(page, '74-expense-report');
await signIn(page, 'marcus');
await go(page, 'Approvals');
await page.getByText(/Thi Nguyen: Bearings pickup/).click();
await expectText(page, /Waiting for you: Manager approval: Marcus Kowalski/, 'department head sees the step on the report');
await page.click('button:has-text("Approve")');
await expectText(page, 'Approved, to reimburse', 'report approved by the department head (under the finance threshold)');
await signIn(page, 'ana');
await go(page, 'Expenses');
await page.click('button[role="tab"]:has-text("All reports")');
await page.getByText('Bearings pickup, Fastenal Springfield').click();
await page.fill('#pay-ref', 'Payroll run 22');
await page.click('button:has-text("Mark reimbursed")');
await expectText(page, /Reimbursed \$32\.60 on/, 'finance records the reimbursement');

// Budgets: spend history by category; next year's budget reconciled top-down against the bottom-up, review, allocation.
await signIn(page, 'morgan');
await go(page, 'Budgets');
await expectText(page, /spent in the last twelve months, [\d.]+% of it on utilities/, 'spend history answers first');
await expectText(page, 'Contract and professional services', 'history classifies GL accounts into spend categories');
await shot(page, '75-spend-history');
await page.click('button[role="tab"]:has-text("Budgets")');
await page.getByText(`${new Date().getUTCFullYear() + 1} operating budget`).click();
await expectText(page, 'Bottom-up total', 'budget detail opens');
await page.click('button[role="tab"]:has-text("Reviews")');
await page.click('button:has-text("Accept")');
await expectText(page, 'Accepted', 'finance accepts the Maintenance budget');
await page.click('button[role="tab"]:has-text("Top-down targets")');
await expectText(page, 'Bottom-up over', 'target below the bottom-up shows the gap');
await page.click('button:has-text("Allocate by bottom-up")');
await expectText(page, 'Within 2%', 'allocation closes the gap exactly');
await shot(page, '76-budget-targets');
await go(page, 'Reports');
await page.getByText('Budget against actual').click();
await expectText(page, /spent against \$[\d,]+ budgeted to date/, 'budget against actual report answers first');

// Lite edition: the owner of a small shop keeps the books; Standard areas are not offered.
// Admin → Features (D-149): a feature turned off leaves the sidebar and its page, and comes back.
await signIn(page, 'dana');
await page.goto(`${BASE}/features`);
await expectText(page, /features are on for everyone|features are limited or turned off/, 'the Features screen answers first');
await page.selectOption('select[aria-label="Who sees Leasing"]', 'off');
await page.locator('.feature-row', { hasText: 'Leasing' }).locator('button:has-text("Save")').click();
await expectText(page, 'Off for everyone', 'a feature can be turned off');
await page.goto(`${BASE}/`);
await page.waitForSelector('nav[aria-label="Main"]');
if (await page.locator('nav[aria-label="Main"] a[href="/leasing"]').count()) errors.push('a feature turned off still shows in the sidebar'); else checks.push('ok  a feature turned off leaves the sidebar');
await page.goto(`${BASE}/leasing`);
await expectText(page, 'This part of the platform is turned off for your role', 'a turned-off page explains itself');
await page.goto(`${BASE}/features`);
await page.selectOption('select[aria-label="Who sees Leasing"]', 'all');
await page.locator('.feature-row', { hasText: 'Leasing' }).locator('button:has-text("Save")').click();
await expectText(page, /features are on for everyone/, 'the feature comes back');
// Admin → Reminders (D-153): every reminder with the company's settings.
await page.goto(`${BASE}/reminders`);
await expectText(page, /\d+ reminders; all on/, 'the reminders screen answers first');
const lotRow = page.locator('.reminder-row', { hasText: 'Lots expiring' });
await lotRow.locator('input[type="checkbox"]').first().uncheck();
await lotRow.locator('button:has-text("Save")').first().click();
await expectText(page, /\d+ reminders; 1 turned off/, 'a reminder can be turned off');
await page.locator('.reminder-row', { hasText: 'Lots expiring' }).locator('input[type="checkbox"]').first().check();
await page.locator('.reminder-row', { hasText: 'Lots expiring' }).locator('button:has-text("Save")').first().click();
await expectText(page, /\d+ reminders; all on/, 'and back on');
// Admin → Data retention (D-151): periods per category, what is never removed.
await page.goto(`${BASE}/retention`);
await expectText(page, /next daily sweep|Nothing is past its period/, 'the retention screen answers first');
await expectText(page, 'The audit log (tamper-evident, never changed or removed)', 'the retention screen lists what is never removed');
await page.locator('.retention-row', { hasText: 'Sent emails' }).locator('input').fill('60');
await page.locator('.retention-row', { hasText: 'Sent emails' }).locator('button:has-text("Save")').click();
await expectText(page, '7 to 3650 days; default 90', 'a retention period can be changed');
await page.locator('.retention-row', { hasText: 'Sent emails' }).locator('input').fill('90');
await page.locator('.retention-row', { hasText: 'Sent emails' }).locator('button:has-text("Save")').click();
await expectText(page, '7 to 3650 days (default)', 'and set back to the default');
// Periodic reviews (D-154): settings on Admin → Reminders; Sam reviews the FMEA that is a year old.
await page.goto(`${BASE}/reminders`);
await expectText(page, 'Periodic reviews', 'review frequencies are on the reminders screen');
await signIn(page, 'sam');
await go(page, 'Reviews');
await expectText(page, /1 review is overdue/, 'the Reviews page answers first');
const fmeaReview = page.locator('.review-row', { hasText: 'CNC-104 turning cell' });
await fmeaReview.locator('button:has-text("Record review")').click();
await fmeaReview.locator('textarea').fill('Read against this year’s nonconformances: still current');
await fmeaReview.locator('button:has-text("Save review")').click();
await expectText(page, 'Nothing is overdue', 'a review is recorded and the record is current again');
// SPC rules and alarm summary (D-156).
await page.goto(`${BASE}/quality?tab=spc`);
await expectText(page, 'Alarm summary', 'the SPC tab opens with the alarm summary');
await expectText(page, /DAY: (no new alarms|\d+ new alarms?) in the last day/, 'the summary answers first, per site');
await expectText(page, '6 of 10 on for every characteristic', 'the rules in force are stated');
await page.click('.spc-rules button:has-text("Choose rules")');
await page.locator('.spc-rules label', { hasText: '4 of 5 beyond 1σ' }).locator('input').check();
await page.click('.spc-rules button:has-text("Save rules")');
await expectText(page, '7 of 10 on for every characteristic', 'an optional rule can be turned on');
await page.click('.spc-rules button:has-text("Choose rules")');
await page.locator('.spc-rules label', { hasText: '4 of 5 beyond 1σ' }).locator('input').uncheck();
await page.click('.spc-rules button:has-text("Save rules")');
await expectText(page, '6 of 10 on for every characteristic', 'and off again');
// CAPA and 8D module (D-160): the dashboard answers first; Sam opens a preventive action.
await go(page, 'CAPA & 8D');
await expectText(page, /\d+ open \(\d+ preventive\)|No open corrective or preventive actions/, 'the CAPA dashboard answers first');
await expectText(page, 'Repeat problems', 'the dashboard shows repeat problems');
await page.click('button:has-text("Open a CAPA")');
await page.getByLabel('Preventive: a problem that could happen').check();
await page.selectOption('#capa-site', { index: 1 });
await page.waitForFunction(() => (document.querySelector('#capa-owner-m') as HTMLSelectElement | null)?.options.length! > 1);
await page.selectOption('#capa-owner-m', { index: 1 });
await page.fill('#capa-title-m', 'Coolant concentration trending low on Cell 1');
await page.fill('#capa-problem-m', 'Refractometer readings drift down between top-ups; tool life would suffer before anyone notices.');
await page.click('button:has-text("Open preventive action")');
await expectText(page, 'Preventive action', 'a preventive action opens with its own label');
// Business cases (D-162): Alex reads the approved cell, then starts a capital project and sees the preview move as a driver changes.
await signIn(page, 'alex');
await go(page, 'Business cases');
await expectText(page, /business cases?: 1 approved/, 'the business case list answers first');
await page.click('td:has-text("Second 5-axis cell for the Lakeshore program")');
await expectText(page, /^Base case (pays back in \d+ months|does not pay back)/, 'a case answers first: payback, NPV, funding');
await expectText(page, 'What moves the result', 'with what moves the result');
await expectText(page, 'Owner approval of the business case', 'and the owner\'s approval');
await shot(page, '72-business-case');
await go(page, 'Business cases');
await page.click('button:has-text("New business case")');
await page.fill('#pf-title', 'Laser marking station for traceability');
await page.selectOption('#pf-kind', 'capital_project');
await page.click('button:has-text("Create")');
await expectText(page, 'Equipment and installation (example)', 'a new case starts from example drivers');
await page.click('button:has-text("Edit")');
await page.getByLabel('Amount', { exact: true }).fill('300000');
await expectText(page, /^Preview, not saved: base case NPV/, 'the figures recalculate while editing');
await page.click('button:has-text("Cancel")');
// Document control (D-168): Marcus finds the customer spec, then writes a work instruction and sends it for review.
await signIn(page, 'marcus');
await go(page, 'Document control');
await expectText(page, /\d+ controlled documents \(\d+ external\); \d+ in review/, 'document control answers first');
await page.fill('#doc-q', 'LH-ES-104');
await page.click('button:has-text("Search")');
await page.click('td:has-text("Component cleanliness requirements")');
await expectText(page, 'issued by', 'an external document shows its issuer');
await expectText(page, 'Lakeshore Hydraulics', 'the customer that owns it');
await expectText(page, 'Revision impact reviews', 'each customer revision is reviewed for its impact (D-169)');
await expectText(page, 'Our wash line and particle count already meet', 'with the assessment on record');
await expectText(page, 'Our documents that work to it', 'and the work instructions that work to it');
await go(page, 'Document control');
await page.click('button:has-text("New document")');
await page.selectOption('#nd-kind', 'work_instruction');
await page.fill('#nd-title', 'Load HSG-100 in fixture 3');
await page.setInputFiles('#nd-file', { name: 'WI-load-fixture-3.txt', mimeType: 'text/plain', buffer: Buffer.from('1. Clean the locators. 2. Load against pins A and B. 3. Clamp to 40 Nm.') });
await page.click('button:has-text("Create document")');
await expectText(page, /WI-\d{4}/, 'a work instruction is numbered automatically');
await expectText(page, 'is a draft: send it for review', 'its first version is a draft');
await page.selectOption('#sub-approver', { label: 'Dana Walsh' });
await page.click('button:has-text("Send for review")');
await expectText(page, 'is in review', 'it goes for review to an approver other than the author');
await expectText(page, 'Approval by Dana Walsh', 'with the approver named');
await shot(page, '73-document-control');
// Work instructions in the app, revision comparison (D-170): Marcus reads the coolant instruction and compares two revisions of the oil change.
await go(page, 'Document control');
await page.fill('#doc-q', 'Coolant concentrate');
await page.click('button:has-text("Search")');
await page.click('td:has-text("Coolant concentrate change on the HMC-201")');
await expectText(page, 'Coolant concentrate irritates skin and eyes', 'a work instruction written in the app shows its hazards');
await expectText(page, '8 to 10 Brix', 'and its checkpoints');
await go(page, 'Document control');
await page.fill('#doc-q', 'RP-CMP-01-OIL');
await page.click('button:has-text("Search")');
await page.click('td:has-text("CMP-01 oil & separator change")');
await page.getByRole('button', { name: 'Compare', exact: true }).click();
await expectText(page, /\d+ lines? added and \d+ removed from revision/, 'two revisions compare line by line');
await shot(page, '74-document-compare');
// Audit pack and electronic signatures (D-170): Dana downloads the audit pack and turns signatures on for SOPs, then off again.
await signIn(page, 'dana');
await go(page, 'Document control');
const [pack] = await Promise.all([page.waitForEvent('download'), page.click('button:has-text("Audit pack")')]);
if (!/^document-audit-pack-.*\.zip$/.test(pack.suggestedFilename())) throw new Error(`check failed: the audit pack is not a zip (${pack.suggestedFilename()})`);
checks.push('ok  the audit pack downloads as a zip');
await page.click('section:has-text("Document settings") button:has-text("Change")');
await page.locator('section:has-text("Document settings") label', { hasText: 'Standard operating procedure' }).locator('input').check();
await page.click('section:has-text("Document settings") button:has-text("Save")');
await expectText(page, /electronic signatures are required for Standard operating procedure/, 'an administrator turns electronic signatures on for a kind of document');
await page.click('section:has-text("Document settings") button:has-text("Change")');
await page.locator('section:has-text("Document settings") label', { hasText: 'Standard operating procedure' }).locator('input').uncheck();
await page.click('section:has-text("Document settings") button:has-text("Save")');
await expectText(page, /electronic signatures are required for no kinds of document/, 'and off again');
await signIn(page, 'marcus');
// Read and understood (D-170): Priya sees the deburring instruction waiting on Home, reads it and acknowledges it.
await signIn(page, 'priya');
await page.goto(`${BASE}/`);
await expectText(page, 'Documents to read', 'Home lists the documents a person must read');
await page.click('.todo a:has-text("Deburr cross-drilled ports on HSG-100")');
await expectText(page, 'Brush each cross-drilled port', 'she opens and reads the revision');
await page.click('button:has-text("I have read and understood this revision")');
await page.getByText(/Read and acknowledge this revision by/).waitFor({ state: 'detached', timeout: 8000 });
checks.push('ok  the acknowledgement is recorded and the reading leaves her list');
await signIn(page, 'marcus');
// Archives and restore (D-165): Dana takes an archive, a customer is renamed, and the old name is brought back from it.
await signIn(page, 'dana');
await go(page, 'Archives and restore');
await expectText(page, /^Last archive today/, 'the archives screen answers first: last archive and the next due');
await page.click('button:has-text("Archive now")');
await expectText(page, 'Taken by hand', 'an archive is taken by hand');
await page.locator('tr', { hasText: 'Taken by hand' }).first().locator('a:has-text("Bring records back")').click();
await page.selectOption('#arch-table', 'customer');
await page.fill('#arch-q', 'Lakeshore');
await page.click('button:has-text("Search")');
await expectText(page, /\d+ deleted and \d+ changed since the archive/, 'an archive shows what was deleted or changed since');
await signIn(page, 'alex');
// Labor productivity (D-166): output per direct labor hour and efficiency against standard, answer first.
await page.goto(`${BASE}/reports/labor-productivity`);
await expectText(page, /labor efficiency over \d+ direct labor hours|No production time recorded/, 'the labor productivity report answers first');
// Unsaved entries are kept on the server (D-164): Alex starts a case, leaves, finds it on Home, comes back to it, then discards it.
await go(page, 'Business cases');
await page.click('button:has-text("New business case")');
await page.fill('#pf-title', 'Robot cell for deburring');
await page.waitForTimeout(1600);
await page.goto(`${BASE}/`);
await expectText(page, 'Unsaved entries', 'Home lists forms started and not saved');
await page.click('.todo a:has-text("New business case")');
await expectText(page, /Your unsaved entries from .* are back/, 'the form comes back with what was typed');
if ((await page.inputValue('#pf-title')) !== 'Robot cell for deburring') throw new Error('check failed: the typed title was not restored');
checks.push('ok  the typed value is restored');
await page.click('button:has-text("Discard them")');
await page.waitForTimeout(300);
if ((await page.inputValue('#pf-title')) !== '') throw new Error('check failed: discarding did not clear the form');
checks.push('ok  and discarding clears it');
// Performance reviews (D-155): Marcus reviews Priya and shares it; Priya acknowledges.
await signIn(page, 'marcus');
await go(page, 'Performance');
await page.click('button[role="tab"]:has-text("My team")');
await expectText(page, /reviews? or check-ins? to complete/, 'a manager sees the reviews waiting on them');
await page.click('a:has-text("Priya Shah")');
await expectText(page, 'Write the assessment, agree goals, then share it.', 'the review page says what to do next');
await page.getByLabel('Overall rating').selectOption('4');
await page.getByLabel('Summary').fill('Cut the PM backlog on line 2; next, PLC fault finding.');
await page.click('button:has-text("Share with the employee")');
await expectText(page, 'Shared; waiting for the employee to acknowledge it.', 'a review is shared');
await signIn(page, 'priya');
await go(page, 'Performance');
await page.click('a:has-text("Priya Shah")');
await expectText(page, 'Read your review and acknowledge it.', 'the employee reads their shared review');
await expectText(page, 'Exceeds expectations', 'with its rating');
await page.click('button:has-text("Acknowledge")');
await expectText(page, 'Completed, acknowledged by the employee.', 'and acknowledges it');
// Justification presentation on a draft change (D-159): Sean attaches the deck for the light curtain.
await signIn(page, 'sean');
await go(page, 'Changes');
await page.getByText('Add a light curtain to PRS-01 press brake').first().click();
await expectText(page, 'No presentation attached.', 'a draft change has a place for its justification deck');
await page.setInputFiles('input[aria-label="Presentation file (PowerPoint or PDF)"]', { name: 'light-curtain-case.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4\n%%EOF\n') });
await page.click('button:has-text("Attach presentation")');
await expectText(page, 'light-curtain-case.pdf', 'the deck is attached to the change');
// Change notices (SC-006 B): an ECN to a colleague, issued and tracked
await go(page, 'Changes');
await page.click('button[role="tab"]:has-text("Change notices")');
await page.click('button:has-text("New notice")');
await page.fill('#cn-title', 'Light curtain muting changes on PRS-01');
await page.fill('#cn-summary', 'The muting sensor moves to the rear of the press brake.');
await page.fill('#cn-ack', new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10));
await page.locator('fieldset:has-text("Colleagues to notify") input[type="checkbox"]').first().check();
await page.click('button:has-text("Save draft")');
await expectText(page, 'Distribution and acknowledgement', 'a notice lists who must be told');
await page.click('button:has-text("Issue the notice")');
await expectText(page, '0 of 1', 'an issued notice tracks acknowledgements');
await shot(page, '24c-change-notice');
// Temporary SOP change (SC-006 C): drafted against a procedure with an end date
await go(page, 'Changes');
await page.click('button[role="tab"]:has-text("Temporary SOP changes")');
await page.click('button:has-text("New temporary change")');
await page.selectOption('#tc-doc', { label: 'SOP-LOTO-001 · Lockout/Tagout' });
await page.fill('#tc-end', new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10));
await page.fill('#tc-title', 'Use the alternate lockout hasp on the press brake');
await page.fill('#tc-what', 'Use the red alternate hasp on PRS-01 until the standard hasp is replaced.');
await page.fill('#tc-why', 'The standard hasp was damaged and the replacement is on back-order.');
await page.click('button:has-text("Save draft")');
await expectText(page, 'Submit for approval', 'a temporary change is drafted with an end date and goes for approval');
await shot(page, '24d-temporary-change');
await signIn(page, 'kai');
await expectText(page, 'Intranet · Lite', 'Lite edition shown in the sidebar');
if (await page.locator('nav[aria-label="Main"] a[href="/assets"]').count()) errors.push('Lite sidebar shows Assets');
else checks.push('ok  Lite sidebar hides Standard areas');
await go(page, 'Books');
await expectText(page, /in the bank; net income of \$[\d,.]+ this year/, 'books overview answers first');
await page.click('button[role="tab"]:has-text("Banking")');
await expectText(page, 'SHELL OIL 57442', 'unreviewed bank line listed');
await page.selectOption('select[aria-label="Account for SHELL OIL 57442"]', { label: '6560 Vehicle fuel' });
await page.check('input[aria-label="Remember a rule for SHELL OIL 57442"]');
await page.locator('tr', { hasText: 'SHELL OIL 57442' }).locator('button:has-text("Categorize")').click();
await page.locator('tr', { hasText: 'SHELL OIL 57442' }).waitFor({ state: 'detached' });
await expectText(page, 'Description contains', 'categorized with a rule remembered');
await shot(page, '77-books-banking');
await page.click('button[role="tab"]:has-text("Statements")');
await expectText(page, 'Net income', 'profit and loss shown');
await expectText(page, 'Balanced', 'trial balance balances');
await shot(page, '78-books-statements');
await go(page, 'Receivables');
await page.click('button[role="tab"]:has-text("New invoice")');
await page.selectOption('#ni-customer', { label: 'Lakeview Dental' });
await page.fill('input[aria-label="Line 1 description"]', 'Compressor service call');
await page.fill('input[aria-label="Line 1 price"]', '185');
await page.click('button:has-text("Create draft")');
await page.click('button:has-text("Issue invoice")');
await expectText(page, 'Issued', 'simple invoice issued (posts to the books)');
await page.getByText('Credit this invoice').click();
await page.fill('input[aria-label="Credit line 1 quantity"]', '1');
await page.fill('#cm-reason', 'Service call billed twice');
await page.click('button:has-text("Draft credit memo")');
await page.click('button:has-text("Issue credit memo")');
await expectText(page, 'Where the credit went', 'a credit memo is issued and applied to the invoice it corrects');
await expectText(page, /Applied to INV-\d{6}/, 'the credit shows the invoice it settled');
await shot(page, '79-credit-memo');
await page.goto(`${BASE}/assets`);
await expectText(page, /part of the Standard edition/, 'Standard areas answer with the upgrade message');

// Quote requests (SC-005 A): from Purchasing, one request to two suppliers, replies compared, awarded to a purchase request.
await signIn(page, 'kim');
await go(page, 'Purchasing');
await page.click('button[role="tab"]:has-text("Quote requests")');
await page.click('button:has-text("New quote request")');
await page.fill('#rfq-title', 'Smoke bearings');
await page.fill('#rfq-respond', new Date(Date.now() + 5 * 86_400_000).toISOString().slice(0, 10));
await page.fill('input[aria-label="Line 1 description"]', 'Bearing 6204 2RS');
await page.fill('input[aria-label="Line 1 quantity"]', '10');
await page.locator('section label:has(input[type=checkbox])').first().locator('input').check();
await page.click('button:has-text("Save draft")');
await expectText(page, /Draft: \d+ supplier/, 'a quote request is saved as a draft');
await shot(page, '81-rfq-draft');

// Implementation plan (SC-003): build it, see steps in order with locks, templates on the import page, the bulk-document panel.
await signIn(page, 'dana');
await page.goto(`${BASE}/implementation`);
await expectText(page, 'No implementation plan yet', 'a company without a plan is offered one');
await page.getByLabel(/Standard/).check();
await page.getByRole('button', { name: 'Build the plan' }).click();
await expectText(page, /required steps are verified/, 'the plan says how far along it is');
await expectText(page, 'Waits for: Sites', 'a step waits for what it depends on');
await page.getByRole('article', { name: 'Sites' }).getByRole('button', { name: 'Start' }).click();
await expectText(page, 'In progress', 'a step can be started');
await shot(page, '80-implementation-plan');
await page.goto(`${BASE}/imports`);
await page.selectOption('#imp-target', 'open_customer_invoices');
await expectText(page, 'Excel template', 'the import page offers a template');
await page.goto(`${BASE}/documents`);
await page.getByText('Bring in files from another system').click();
await expectText(page, 'Check the zip', 'documents can be brought over from a zip');

// Field service (SC-002): the dispatcher's board, the technician's tablet report, a quote from a recommended repair, and billing
await signIn(page, 'dee');
await go(page, 'Field service');
await expectText(page, 'Tia Nguyen', 'the dispatch board shows the technicians');
await expectText(page, 'Drive time = straight-line distance', 'the board says how drive time is estimated');
await page.click('button[role="tab"]:has-text("Agreements")');
await expectText(page, 'Riverside Mall', 'agreements list the customers');
await page.click('button[role="tab"]:has-text("Technicians, trucks and tools")');
await expectText(page, 'VAN-01', 'trucks are listed');
await shot(page, '90-field-service');
await signIn(page, 'tia');
await go(page, 'My day');
await expectText(page, 'Quarterly PM', 'the technician sees the day with the checklist visit');
await page.getByRole('button', { name: 'Start the visit' }).first().click();
await page.waitForSelector('form[aria-label="Service report"]');
for (const b of await page.locator('button[aria-pressed]').filter({ hasText: /^OK$/ }).all()) await b.click();
await page.fill('#rep-work', 'Replaced filters, cleaned the condenser coil, checked belts.');
await page.fill('#rep-hours', '1.5');
await page.getByRole('button', { name: 'Add a recommended repair' }).click();
await page.fill('input[aria-label="Recommended repair"]', 'Replace the condenser fan motor');
await page.fill('input[aria-label="Price if known"]', '640');
await page.fill('#rep-signed', 'Pat Lindqvist');
const pad = page.locator('canvas[role="img"]'); await pad.scrollIntoViewIfNeeded(); const box = (await pad.boundingBox())!;
await page.mouse.move(box.x + 40, box.y + 100); await page.mouse.down(); await page.mouse.move(box.x + 200, box.y + 60, { steps: 8 }); await page.mouse.move(box.x + 320, box.y + 130, { steps: 8 }); await page.mouse.up();
await shot(page, '91-service-report');
await page.getByRole('button', { name: 'Submit report' }).click();
await expectText(page, 'View report', 'the submitted visit shows as done on the technician’s day');
await signIn(page, 'dee');
await page.goto(`${BASE}/service`);
await page.click('button[role="tab"]:has-text("Visits")');
await page.selectOption('#visit-filter', 'all');
await page.getByText('Quarterly PM').first().click();
await expectText(page, 'Service report', 'the dispatcher sees the submitted report');
await expectText(page, 'Replace the condenser fan motor', 'with the repair the technician recommended');
await page.getByLabel('Quote Replace the condenser fan motor').check();
await page.getByRole('button', { name: /Create a draft quote/ }).click();
await expectText(page, 'Recommended repairs', 'the repair becomes a draft quote for the customer');
await signIn(page, 'ari');
await page.goto(`${BASE}/service`);
await page.click('button[role="tab"]:has-text("Billing")');
await expectText(page, 'Visits ready to invoice', 'billing lists the finished visit');
await page.getByRole('button', { name: 'Create invoice' }).first().click();
await expectText(page, 'Nothing waiting.', 'invoicing a visit clears it from the list');
await shot(page, '92-service-billing');

// Fit interview and personal display settings (SC-004)
await signIn(page, 'dana');
await page.goto(`${BASE}/fit`);
await page.getByLabel('Makes products').check();
await page.getByLabel('Maintains its own equipment or buildings').check();
await page.getByLabel('2 to 3').check();
await page.getByLabel('11 to 50').check();
await page.getByRole('button', { name: /Save answers/ }).click();
await expectText(page, 'What we suggest', 'the interview gives a recommendation');
await expectText(page, /Implementation plan: (guided|standard|full)/, 'with a plan depth');
await shot(page, '95-fit-interview');
await page.goto(`${BASE}/my-settings`);
await page.getByLabel('Compact: more on the screen').click();
await page.getByLabel('Large', { exact: true }).click();
await page.waitForFunction(() => document.documentElement.dataset.density === 'compact' && document.documentElement.dataset.text === 'large');
checks.push('ok  display settings apply at once');
await page.reload();
await page.waitForFunction(() => document.documentElement.dataset.density === 'compact');
checks.push('ok  display settings are remembered');
await page.getByLabel('Normal', { exact: true }).first().click();
await page.getByLabel('Normal', { exact: true }).nth(1).click();
await page.waitForFunction(() => document.documentElement.dataset.density === 'normal' && document.documentElement.dataset.text === 'normal');

// People and access (D-183A): add a person, give and remove a role, disable and enable, issue and revoke a token.
await peopleAndAccessSmoke(page);
async function peopleAndAccessSmoke(page: Page) {
  const email = `smoke.${Date.now()}@example.test`;
  await signIn(page, 'dana');
  await page.locator('nav[aria-label="Main"]').locator('a[href="/access"]').first().click();
  await expectText(page, 'People and access', 'the People and access screen opens from the Admin menu');
  await page.getByRole('button', { name: 'Add a person' }).click();
  await page.fill('#new-user-name', 'Smoke Person');
  await page.fill('#new-user-email', email);
  await page.getByRole('button', { name: 'Add person', exact: true }).click();
  await expectText(page, 'No role yet', 'a new person is listed with no role');
  await page.getByLabel('Role to give').selectOption({ label: 'Operator / Requester' });
  await page.getByRole('button', { name: 'Give role' }).click();
  await expectText(page, 'Operator / Requester (all sites)', 'the role is given');
  await shot(page, '96-people-and-access');
  page.once('dialog', (d) => d.accept());
  await page.getByRole('button', { name: 'Disable account' }).click();
  await expectText(page, 'Account disabled', 'disabling the account is confirmed on the page');
  await page.getByRole('button', { name: 'Enable account' }).click();
  await expectText(page, 'Account enabled.', 'the account can be enabled again');
  await page.getByRole('tab', { name: 'Roles' }).click();
  await expectText(page, 'Starter roles come with the product', 'roles are listed with starter roles read-only');
  await page.getByRole('button', { name: 'New company role' }).click();
  await page.fill('#role-name', 'Smoke Reader');
  await page.getByLabel('view', { exact: true }).first().check() // the first permission called "view" (org.view);
  await page.getByRole('button', { name: 'Save role' }).click();
  await expectText(page, 'Smoke Reader', 'a company role can be created');
  await page.getByRole('tab', { name: 'Tokens' }).click();
  await page.selectOption('#token-user', { label: `Smoke Person (${email})` });
  await page.fill('#token-label', 'Smoke token');
  await page.getByRole('button', { name: 'Issue token' }).click();
  await expectText(page, 'It is shown once', 'a new token is shown once');
  const tokenText = (await page.locator('#new-token').textContent()) ?? '';
  if (!/^erp_/.test(tokenText)) errors.push('the issued token is not displayed');
  await shot(page, '97-tokens');
  await page.getByRole('button', { name: 'I have stored it' }).click();
  await page.reload();
  await page.getByRole('tab', { name: 'Tokens' }).click();
  await expectText(page, 'Smoke token', 'the token is listed afterwards');
  if (await page.getByText(tokenText).count()) errors.push('the token is shown again after leaving the screen');
  page.once('dialog', (d) => d.accept());
  await page.getByRole('button', { name: 'Revoke Smoke token' }).click();
  await page.getByText('Smoke token').waitFor({ state: 'detached', timeout: 8000 });
  checks.push('ok  a token can be revoked');
}



// New asset and New work order forms (D-183): create an asset, then a work order against it.
async function newAssetAndWorkOrderSmoke(page: Page) {
  const tag = `SMK-${Date.now().toString(36).toUpperCase()}`;
  await signIn(page, 'dana');
  await page.locator('nav[aria-label="Main"]').locator('a[href="/assets"]').first().click();
  await page.getByRole('button', { name: 'New asset' }).click();
  await page.selectOption('#na-site', { index: 1 });
  await page.fill('#na-tag', tag);
  await page.fill('#na-name', 'Smoke test press');
  await page.getByRole('button', { name: 'Create asset' }).click();
  await expectText(page, tag, 'a new asset is created and its page opens');
  await page.locator('nav[aria-label="Main"]').locator('a[href="/work-orders"]').first().click();
  await page.getByRole('button', { name: 'New work order' }).click();
  await page.selectOption('#nw-asset', { label: `${tag} · Smoke test press` });
  await page.fill('#nw-title', 'Smoke test: replace guard');
  await page.getByRole('button', { name: 'Create work order' }).click();
  await expectText(page, 'Smoke test: replace guard', 'a new work order is created and opens');
}
await newAssetAndWorkOrderSmoke(page);

/**
 * My day offline (SC-002, D-183C): with no connection the technician still sees the day and a visit's details, starts a visit, saves a draft,
 * enters labor and submits the report; everything is kept in the outbox and sent once, in order, when the connection returns. A draft
 * saved on the server is restored into the form after a reload.
 */
async function offlineMyDay() {
  const stopOf = (title: string) => page.locator('section[aria-label^="Stop"]', { hasText: title });
  const api = (p: string) => page.evaluate(async (path) => (await fetch(path, { headers: { authorization: `Bearer ${sessionStorage.getItem('erp.token')}` } })).json(), p);
  await signIn(page, 'sam (field');
  await go(page, 'My day');
  await expectText(page, 'Walk-in cooler not holding temperature', 'offline: the technician sees the day while online');
  await expectText(page, 'Monthly cooler inspection', 'with every stop of the day');
  // Saved copies of every visit are kept in the background while there is a connection.
  await page.waitForFunction(() => Object.keys(localStorage).filter((k) => k.startsWith('erp.cache:') && /service-visits\/[0-9a-f-]{36}(\/report)?$/.test(k)).length >= 4, null, { timeout: 15000 });
  checks.push('ok  offline: the day, each visit and its report draft are saved on the device');
  const day = await api(`/api/service-my-day?date=${new Date().toISOString().slice(0, 10)}`);
  const callout = day.stops.find((x: any) => /Walk-in cooler/.test(x.title));
  const laborBefore = (await api(`/api/work-orders/${callout.work_order_id}`)).labor.length;

  await context.setOffline(true);
  await page.evaluate(() => window.dispatchEvent(new Event('offline')));
  await stopOf('Monthly cooler inspection').getByRole('button', { name: 'Visit details' }).click();
  await expectText(page, 'Checklist', 'offline: a visit’s details open from the saved copy');
  await stopOf('Monthly cooler inspection').getByRole('button', { name: 'Hide details' }).click();
  await stopOf('not holding temperature').getByRole('button', { name: 'Start the visit' }).click();
  await expectText(page, 'Offline.', 'offline: the page says there is no connection');
  await expectText(page, 'Start the visit: Waiting', 'offline: starting the visit waits in the outbox');
  await page.waitForSelector('form[aria-label="Service report"]');
  await page.fill('#rep-work', 'Cleaned the condenser coil, reset the defrost timer, temperature back to 36 F.');
  await page.fill('#rep-hours', '2');
  await page.fill('#rep-signed', 'Pat Lindqvist');
  const pad = page.locator('canvas[role="img"]'); await pad.scrollIntoViewIfNeeded(); const box = (await pad.boundingBox())!;
  await page.mouse.move(box.x + 40, box.y + 100); await page.mouse.down(); await page.mouse.move(box.x + 200, box.y + 60, { steps: 8 }); await page.mouse.move(box.x + 320, box.y + 130, { steps: 8 }); await page.mouse.up();
  await page.getByRole('button', { name: 'Save draft' }).click();
  await expectText(page, /Draft saved on this device/, 'offline: the report draft is kept on the device');
  await page.getByRole('button', { name: 'Submit report' }).click();
  await expectText(page, /Submit the service report \(2 h labor\): Waiting/, 'offline: the finished report waits in the outbox');
  await expectText(page, /Waiting to send/, 'offline: the stop shows it is waiting to be sent');
  await shot(page, '93-my-day-offline');
  const queued = await page.evaluate(() => Object.entries(localStorage).filter(([k]) => k.startsWith('erp.outbox:')).flatMap(([, v]) => JSON.parse(v) as { method: string; path: string; id: string }[]));
  if (queued.map((q) => `${q.method} ${q.path.split('/').slice(-1)[0]}`).join(',') !== 'POST start,PUT report,POST submit') throw new Error(`outbox order wrong: ${JSON.stringify(queued.map((q) => q.method + q.path))}`);
  if (new Set(queued.map((q) => q.id)).size !== 3) throw new Error('every queued change needs its own Idempotency-Key');
  checks.push('ok  offline: start, draft and submission are queued in order, each with its own Idempotency-Key');

  await context.setOffline(false);
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await page.waitForFunction(() => !Object.entries(localStorage).some(([k, v]) => k.startsWith('erp.outbox:') && JSON.parse(v).length), null, { timeout: 20000 });
  await expectText(page, 'View report', 'back online: the queued start and report are sent and the visit shows as done');
  const after = await api(`/api/service-visits/${callout.id}`);
  if (after.status !== 'completed') throw new Error(`visit should be completed after sync, is ${after.status}`);
  const labor = (await api(`/api/work-orders/${after.work_order_id}`)).labor;
  if (labor.length !== laborBefore + 1 || Number(labor[labor.length - 1].hours) !== 2) throw new Error(`labor should be posted once (before ${laborBefore}, now ${labor.length})`);
  checks.push('ok  back online: the visit is completed and its labor was posted exactly once');

  // A draft saved on the server comes back into the form after a reload (it used to start empty).
  await stopOf('Monthly cooler inspection').getByRole('button', { name: 'Start the visit' }).click();
  await page.waitForSelector('form[aria-label="Service report"]');
  await page.fill('#rep-work', 'Checked the evaporator fans, all running.');
  await page.fill('#rep-hours', '1.25');
  await page.getByRole('button', { name: 'Save draft' }).click();
  await expectText(page, /Draft saved \d/, 'the draft is saved on the server');
  await page.evaluate(() => { for (const k of Object.keys(localStorage)) if (k.startsWith('erp.form:')) localStorage.removeItem(k); }); // as if on another tablet
  await page.reload();
  await expectText(page, 'Monthly cooler inspection', 'the day reloads');
  await stopOf('Monthly cooler inspection').getByRole('button', { name: 'Service report' }).click();
  await expectText(page, /Draft restored/, 'the service report says the draft was restored');
  await page.waitForFunction(() => (document.querySelector('#rep-work') as HTMLTextAreaElement | null)?.value === 'Checked the evaporator fans, all running.', null, { timeout: 8000 });
  if ((await page.inputValue('#rep-hours')) !== '1.25') throw new Error('the saved hours should be restored into the form');
  checks.push('ok  a saved report draft is restored into the form after a reload');
}


/** Samples and test results (SC-007 D, D-184D): a method, a sample, a result outside its limit opens an investigation that blocks release. */
async function labSamplesSmoke() {
  await signIn(page, 'dana');
  await page.locator('nav[aria-label="Main"]').locator('a[href="/lab"]').first().click();
  await expectText(page, 'Samples and test results', 'the Lab samples page opens from the Quality & safety menu');
  await page.getByRole('tab', { name: 'Methods' }).click();
  await page.getByRole('button', { name: 'New method' }).click();
  await page.getByLabel('Site', { exact: true }).selectOption({ index: 1 });
  await page.getByLabel('Method code').fill('SMK-01');
  await page.getByLabel('Method name').fill('Smoke moisture');
  await page.getByLabel('Analyte 1 name').fill('Moisture');
  await page.getByLabel('Analyte 1 unit').fill('%');
  await page.getByLabel('Analyte 1 high limit').fill('2');
  await page.getByRole('button', { name: 'Save method' }).click();
  await expectText(page, 'at most 2', 'a one-sided specification is saved and shown');
  await page.getByRole('tab', { name: 'Samples' }).click();
  await page.getByRole('button', { name: 'Receive a sample' }).click();
  await page.getByLabel('Site', { exact: true }).selectOption({ index: 1 });
  await page.getByLabel('Source').selectOption('internal');
  await page.getByLabel('Description').fill('Lab smoke sample');
  await page.getByLabel('Storage location').fill('Fridge 1');
  await page.getByRole('button', { name: 'Receive sample', exact: true }).click();
  await expectText(page, 'Chain of custody', 'a received sample opens with its custody log');
  await page.getByRole('button', { name: 'Add a test' }).click();
  await page.getByLabel('Method', { exact: true }).selectOption({ label: 'SMK-01 v1 · Smoke moisture' });
  await page.getByRole('button', { name: 'Add test', exact: true }).click();
  await expectText(page, 'Enter results', 'the test is added and takes results');
  await page.getByLabel(/^Moisture/).fill('3.4');
  await page.getByRole('button', { name: 'Save results' }).click();
  await expectText(page, 'Open: blocks release', 'a result over its limit opens an out-of-specification investigation');
  await page.getByRole('button', { name: 'Release sample' }).click();
  await expectText(page, /still open; close the out-of-specification investigation before releasing/, 'release is refused while the investigation is open');
  await shot(page, '98-lab-sample');
}

await labSamplesSmoke();
await offlineMyDay();

await browser.close();
console.log(checks.join('\n'));
if (errors.length) {
  console.error(`\n${errors.length} problem(s):\n${errors.join('\n')}`);
  process.exit(1);
}
console.log(`\nall UI checks passed; screenshots in ${OUT}`);
