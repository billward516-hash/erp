/**
 * The step catalogue (SC-003): every kind of data a company brings, and every connection it makes, in the order a
 * sensible implementation does them, with who owns each and what "done" means. It is code, not data: versioned with
 * the product so a release that adds an import also adds its step.
 *
 * `depth` is the smallest plan depth that includes the step ('guided' = every plan, 'standard', 'full').
 * `dependsOn` lists step keys that must be loaded, verified or skipped first; '*data' means every data step.
 */
export type Depth = 'guided' | 'standard' | 'full';
export type Track = 'data' | 'connection' | 'cutover';
export type OwnerRole = 'Administrator' | 'HR' | 'IT' | 'Maintenance' | 'Storeroom' | 'Purchasing' | 'Sales' | 'Finance' | 'Payroll' | 'Production' | 'Quality';

export interface StepDef {
  key: string; track: Track; title: string; owner: OwnerRole; depth: Depth;
  /** Import target loaded by this step (data steps). */
  target?: string;
  dependsOn: string[];
  optional?: boolean;
  /** What to ask the owner to bring, and where such a list usually lives. */
  bring: string;
  /** How you know it is right. */
  doneWhen: string;
  /** One or two sentences for someone who has never done this. */
  help: string;
}

const d = (s: Omit<StepDef, 'track'>): StepDef => ({ track: 'data', ...s });
const c = (s: Omit<StepDef, 'track'>): StepDef => ({ track: 'connection', ...s });

export const CATALOGUE: StepDef[] = [
  d({ key: 'sites', title: 'Sites', owner: 'Administrator', depth: 'guided', target: 'sites', dependsOn: [],
    bring: 'One row per plant, store, warehouse or property: code, name, address, time zone. Often the site list in the finance or HR system.',
    doneWhen: 'Every site the company operates is listed, with the right time zone.', help: 'Everything else hangs off a site, so this comes first. Take the list people already use to say where things are.' }),
  d({ key: 'departments', title: 'Departments', owner: 'Administrator', depth: 'standard', target: 'departments', dependsOn: [],
    bring: 'Department code and name, optionally the site. Usually from payroll or the cost-center list.',
    doneWhen: 'Each department that approves spend or owns people is listed.', help: 'Approval rules and budgets use departments. Use the cost-center list from finance if there is one.' }),
  d({ key: 'employees', title: 'Employees', owner: 'HR', depth: 'guided', target: 'employees', dependsOn: ['sites'],
    bring: 'The employee export from payroll or HR: employee number, name, job title, site, hire date, manager number, work email.',
    doneWhen: 'The count matches the active headcount HR reports.', help: 'Do not bring pay rates or personal data; the platform does not need them. A payroll export with those columns is fine, the unmapped columns are ignored.' }),
  d({ key: 'users_roles', title: 'People who sign in, and their roles', owner: 'Administrator', depth: 'guided', target: 'users_roles', dependsOn: ['employees'],
    bring: 'For each person who will sign in: work email, the employee number, the role and the site. If unsure, start with administrators, managers and supervisors.',
    doneWhen: 'Each stakeholder in this plan can sign in and sees their own steps.', help: 'A role decides what a person can see and do. Several roles per person are normal in small companies.' }),
  d({ key: 'assets', title: 'Equipment and assets', owner: 'Maintenance', depth: 'standard', target: 'assets', dependsOn: ['sites'],
    bring: 'The equipment list from the maintenance system or spreadsheet: tag, name, make, model, serial number, location, criticality, parent equipment.',
    doneWhen: 'A walk around one area finds every machine in the list and nothing missing.', help: 'Parents can come after children in the file. Location paths such as "Building 2 > Line 3" create the locations.' }),
  d({ key: 'parts', title: 'Parts and materials', owner: 'Storeroom', depth: 'standard', target: 'parts', dependsOn: [],
    bring: 'The item master: part number, description, unit of measure, unit cost, manufacturer and its part number.',
    doneWhen: 'Ten parts picked from the shelf are found by their numbers.', help: 'Units such as pcs, each, ea are normalised. Unknown units are kept with a warning.' }),
  d({ key: 'stock_locations', title: 'Storerooms and bins', owner: 'Storeroom', depth: 'standard', target: 'stock_locations', dependsOn: ['sites'],
    bring: 'Each storeroom or crib: code, name, site.', doneWhen: 'Every place stock is kept is listed.', help: 'Bins are a column on the balances, not separate records.' }),
  d({ key: 'stock_balances', title: 'Stock on hand', owner: 'Storeroom', depth: 'standard', target: 'stock_balances', dependsOn: ['parts', 'stock_locations'],
    bring: 'On-hand quantity per part and storeroom, with bin and reorder point if known. Best taken from a count done close to go-live.',
    doneWhen: 'A count of three shelves matches the system.', help: 'Each row sets the on-hand quantity. Take the final one at cutover.' }),
  d({ key: 'suppliers', title: 'Suppliers', owner: 'Purchasing', depth: 'standard', target: 'suppliers', dependsOn: [],
    bring: 'Vendor list: code, name, contact, email, payment terms. Leave bank and tax details in accounting.',
    doneWhen: 'The count matches the active vendors in accounting.', help: 'Suppliers are shared by purchasing, payables and contractors.' }),
  d({ key: 'supplier_prices', title: 'Supplier price lists', owner: 'Purchasing', depth: 'full', target: 'supplier_prices', dependsOn: ['suppliers', 'parts'], optional: true,
    bring: 'Price, lead time and supplier part number per supplier and part.', doneWhen: 'Preferred suppliers show for the top parts.', help: 'Optional but makes purchase requests quick.' }),
  d({ key: 'customers', title: 'Customers', owner: 'Sales', depth: 'guided', target: 'customers', dependsOn: [],
    bring: 'Customer list with contacts: code, name, billing address, terms, contact name and email. From the CRM or accounting.',
    doneWhen: 'The count matches the active customers in accounting.', help: 'A contact on each row becomes the main contact.' }),
  d({ key: 'asset_parts', title: 'Spares per machine', owner: 'Maintenance', depth: 'full', target: 'asset_parts', dependsOn: ['assets', 'parts'], optional: true,
    bring: 'Which parts belong to which machine and how critical they are.', doneWhen: 'The top machines show their spares.', help: 'Parts can be matched by the manufacturer part number when you have only the OEM list.' }),
  d({ key: 'boms', title: 'Bills of material', owner: 'Production', depth: 'standard', target: 'boms', dependsOn: ['parts'],
    bring: 'Component lines per finished part, flat or indented, with quantity per and scrap percent.', doneWhen: 'One finished part is costed and its components match the drawing.', help: 'Lines land on a draft revision so nothing is released by accident.' }),
  d({ key: 'work_centers', title: 'Work centers', owner: 'Production', depth: 'standard', target: 'work_centers', dependsOn: ['sites'],
    bring: 'Work center code, name, site, machines (asset tags), hours per week, units.', doneWhen: 'Each cell or line used in routings is listed.', help: 'A work center is where an operation is done: a machine group or a manual station.' }),
  d({ key: 'routings', title: 'Routings (operations per part)', owner: 'Production', depth: 'standard', target: 'routings', dependsOn: ['work_centers', 'parts'],
    bring: 'Per finished part: operation number, work center, description, setup minutes, run minutes per unit.', doneWhen: 'One part produced last week has the same operations and times.', help: 'Operations land on the draft revision with the bill of material.' }),
  d({ key: 'pm_plans', title: 'Preventive maintenance plans', owner: 'Maintenance', depth: 'standard', target: 'pm_plans', dependsOn: ['assets'],
    bring: 'Per machine: task, frequency in days or meter units, estimated hours, last done date.', doneWhen: 'This month\'s PM list matches the paper schedule.', help: 'The last-done date sets when each is next due, so history is not repeated.' }),
  d({ key: 'open_purchase_orders', title: 'Open purchase orders', owner: 'Purchasing', depth: 'full', target: 'open_purchase_orders', dependsOn: ['suppliers', 'parts'], optional: true,
    bring: 'Purchase orders not yet fully received: PO number, supplier, part, quantity ordered, quantity received, due date, price.', doneWhen: 'Receiving next week\'s deliveries finds their orders.', help: 'Load at cutover so receipts after go-live match.' }),
  d({ key: 'chart_of_accounts', title: 'Chart of accounts', owner: 'Finance', depth: 'standard', target: 'chart_of_accounts', dependsOn: [],
    bring: 'Account number, name and type from the accounting system\'s chart.', doneWhen: 'The accountant has reviewed the list.', help: 'Starting from the built-in chart is fine for small companies; skip this step and review the chart in Books.' }),
  d({ key: 'opening_balances', title: 'Opening balances', owner: 'Finance', depth: 'standard', target: 'opening_balances', dependsOn: ['chart_of_accounts'],
    bring: 'The trial balance at the day before the first day in this system.', doneWhen: 'The trial balance here equals the old system\'s for that date.', help: 'Debit and credit columns or one signed column are both fine.' }),
  d({ key: 'open_customer_invoices', title: 'Open customer invoices', owner: 'Finance', depth: 'standard', target: 'open_customer_invoices', dependsOn: ['customers'],
    bring: 'Unpaid invoices at the cutover date: invoice number, customer, invoice date, due date, amount, amount already paid.', doneWhen: 'The aging report equals the old aging report.', help: 'Do not load paid history here; only what is still owed.' }),
  d({ key: 'open_supplier_bills', title: 'Open supplier bills', owner: 'Finance', depth: 'standard', target: 'open_supplier_bills', dependsOn: ['suppliers'],
    bring: 'Unpaid bills at the cutover date: supplier, invoice number, dates, amount.', doneWhen: 'The payables aging equals the old one.', help: 'Only what is still owed.' }),
  d({ key: 'bank_transactions', title: 'Bank statement lines', owner: 'Finance', depth: 'standard', target: 'bank_transactions', dependsOn: ['chart_of_accounts'], optional: true,
    bring: 'Three months of activity downloaded from the bank\'s website, in the bank\'s own layout.', doneWhen: 'The statement\'s closing balance equals the books\' balance.', help: 'No layout change needed; the mapping is saved for next month.' }),
  d({ key: 'work_order_history', title: 'Maintenance history', owner: 'Maintenance', depth: 'full', target: 'work_order_history', dependsOn: ['assets', 'employees'], optional: true,
    bring: 'Closed work orders from the old system: number, machine, date, problem, remedy, hours, cost.', doneWhen: 'A machine\'s page shows its past repairs.', help: 'History makes reliability and repair-or-replace work from day one.' }),
  d({ key: 'asset_downtime', title: 'Downtime history', owner: 'Maintenance', depth: 'full', target: 'asset_downtime', dependsOn: ['assets'], optional: true,
    bring: 'Stops with start and end (or duration) and reason.', doneWhen: 'Availability for a past month matches the old report.', help: 'Overlaps are rejected so the figures stay honest.' }),
  d({ key: 'qualification_records', title: 'Qualification records', owner: 'HR', depth: 'full', target: 'qualification_records', dependsOn: ['employees'], optional: true,
    bring: 'Who holds which qualification and when it was granted or expires.', doneWhen: 'Spot-check five people against their certificates.', help: 'Qualifications must be defined first.' }),
  d({ key: 'spend_history', title: 'Spend history', owner: 'Finance', depth: 'full', target: 'spend_history', dependsOn: [], optional: true,
    bring: 'A profit and loss by month from the old system.', doneWhen: 'Budget proposals show last year\'s spend.', help: 'Used to propose budgets.' }),

  c({ key: 'conn_bank', title: 'Bank: statement files', owner: 'Finance', depth: 'standard', dependsOn: ['chart_of_accounts'],
    bring: 'Access to the bank\'s website to download activity as CSV; the account number\'s last four digits.', doneWhen: 'The statement\'s closing balance equals the books\' balance for the account on that date.',
    help: 'Live bank feeds are not available yet. Each month download the activity file and upload it; matching to invoices and bills is automatic.' }),
  c({ key: 'conn_payroll', title: 'Payroll: export file', owner: 'Payroll', depth: 'standard', dependsOn: ['employees'],
    bring: 'The payroll provider\'s name, the earning codes it uses (regular, overtime, holiday...), the first day of the pay week, and one sample import file the provider accepts.',
    doneWhen: 'A dry-run export for a past week is accepted by the provider\'s test import and the hours match their register.',
    help: 'Direct payroll connections are not available yet. Approved timesheets export as a file with the provider\'s codes; corrections are made in payroll.' }),
  c({ key: 'conn_accounting', title: 'Accounting: built-in books or file export', owner: 'Finance', depth: 'standard', dependsOn: ['chart_of_accounts'],
    bring: 'The decision: use the built-in books, or keep the existing accounting system and export bills to it as a file.', doneWhen: 'The trial balance equals the old system\'s at the cutover date, or the first bills export file imports cleanly.',
    help: 'Direct accounting connections are not available yet.' }),
  c({ key: 'conn_sso', title: 'Sign-in with the company identity provider', owner: 'IT', depth: 'guided', dependsOn: ['users_roles'],
    bring: 'The identity provider\'s issuer address, client id and secret, and the work-email domain; the redirect address comes from this product. A company without one can use Google Workspace or Microsoft 365 accounts as the provider.', doneWhen: 'Two named people sign in with their work email and land with the right roles.',
    help: 'People sign in through the company\'s identity provider, which finds them by the email loaded in the previous step. Until it is set up, only access tokens issued by an administrator work.' }),
  c({ key: 'conn_email', title: 'Outgoing email', owner: 'IT', depth: 'standard', dependsOn: [], optional: true,
    bring: 'The sending domain and access to its DNS records.', doneWhen: 'A test message arrives in the inbox, not the spam folder.', help: 'Digests, reminders and customer messages go by email once this is done.' }),

  { key: 'rehearsal', track: 'cutover', title: 'Rehearsal in a practice copy', owner: 'Administrator', depth: 'standard', dependsOn: [], optional: true,
    bring: 'A few hours with the stakeholders, once the first files are ready.', doneWhen: 'The team has loaded sample files into the practice copy, seen the problem report and agreed the order.',
    help: 'The practice copy is a separate company with sample data. Nothing done there touches real data, and it can be reset.' },
  { key: 'cutover', track: 'cutover', title: 'Final changes and cutover', owner: 'Administrator', depth: 'guided', dependsOn: ['*data'],
    bring: 'The date the old system is frozen, and the last export of everything that changes daily (stock, open invoices and bills, open orders).', doneWhen: 'The last loads are committed and the old system is read-only.',
    help: 'Load only what changed since the earlier loads; re-imports update by number, they do not duplicate.' },
  { key: 'go_live', track: 'cutover', title: 'Go-live sign-off', owner: 'Administrator', depth: 'guided', dependsOn: ['cutover'],
    bring: 'The owner\'s decision.', doneWhen: 'Every required step is verified or skipped with a reason.', help: 'Signing off records the go-live date.' },
];

export const DEPTH_RANK: Record<Depth, number> = { guided: 0, standard: 1, full: 2 };
export const stepsFor = (depth: Depth) => CATALOGUE.filter((s) => DEPTH_RANK[s.depth] <= DEPTH_RANK[depth]);
export const stepDef = (key: string) => CATALOGUE.find((s) => s.key === key);
