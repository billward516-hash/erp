import { FEATURES } from '../../platform/features.js';

/**
 * The fit interview (SC-004 A): plain questions about what the business does, turned into a recommendation of which features to show,
 * how deep the implementation plan should go, which data steps apply and what is not a fit yet. It lives in code so it is versioned with
 * the product; answers are stored per company and the result is recomputed from them, so a changed rule improves every re-take.
 */
export const INTERVIEW_VERSION = 1;
export type Answers = Record<string, string | string[] | boolean | undefined>;

export interface Question {
  id: string; text: string; help?: string; kind: 'single' | 'multi' | 'yesno';
  options?: { value: string; label: string }[];
  /** Asked only when this holds for the answers so far. */
  when?: (a: Answers) => boolean;
}
const has = (a: Answers, id: string, v: string) => (Array.isArray(a[id]) ? (a[id] as string[]).includes(v) : a[id] === v);
const yes = (a: Answers, id: string) => a[id] === true;

export const QUESTIONS: Question[] = [
  { id: 'business', kind: 'multi', text: 'What does the company do? Choose everything that applies.', options: [
    { value: 'makes', label: 'Makes products' }, { value: 'maintains', label: 'Maintains its own equipment or buildings' }, { value: 'services', label: 'Services other people’s equipment' },
    { value: 'sells', label: 'Sells goods or services to customers' }, { value: 'food', label: 'Restaurants or food service' }, { value: 'retail', label: 'Runs retail stores' },
    { value: 'property', label: 'Owns or rents out property' }, { value: 'office', label: 'Office or professional services only' }] },
  { id: 'sites', kind: 'single', text: 'How many sites (plants, stores, warehouses, properties)?', options: [{ value: '1', label: 'One' }, { value: '2-3', label: '2 to 3' }, { value: '4-10', label: '4 to 10' }, { value: '10+', label: 'More than 10' }] },
  { id: 'people', kind: 'single', text: 'How many people work there?', options: [{ value: '1-10', label: 'Up to 10' }, { value: '11-50', label: '11 to 50' }, { value: '51-200', label: '51 to 200' }, { value: '200+', label: 'More than 200' }] },
  { id: 'own_equipment', kind: 'yesno', text: 'Do you keep a list of equipment that has to be maintained, with repairs and scheduled upkeep?', when: (a) => has(a, 'business', 'makes') || has(a, 'business', 'maintains') || has(a, 'business', 'property') || has(a, 'business', 'food') },
  { id: 'stock', kind: 'yesno', text: 'Do you keep stock in a storeroom or warehouse (spare parts, materials or finished goods)?' },
  { id: 'tracked', kind: 'yesno', text: 'Do you have to trace lots or serial numbers, or watch expiry dates?', when: (a) => yes(a, 'stock') },
  { id: 'scanning', kind: 'yesno', text: 'Would your storeroom people use a tablet and barcode scanner to receive, issue and count?', when: (a) => yes(a, 'stock') },
  { id: 'make_to', kind: 'single', text: 'Do you make product to customer orders, to stock, or both?', when: (a) => has(a, 'business', 'makes'), options: [{ value: 'order', label: 'To order' }, { value: 'stock', label: 'To stock' }, { value: 'both', label: 'Both' }] },
  { id: 'buys', kind: 'yesno', text: 'Do you buy goods or services from suppliers with purchase orders and approvals?' },
  { id: 'rfq_out', kind: 'yesno', text: 'Do you ask several suppliers for prices on the same thing and compare their answers?', when: (a) => yes(a, 'buys') },
  { id: 'sells_quotes', kind: 'yesno', text: 'Do you send quotes and take orders from customers?', when: (a) => has(a, 'business', 'sells') || has(a, 'business', 'makes') || has(a, 'business', 'services') },
  { id: 'rfq_in', kind: 'yesno', text: 'Do customers send you requests for quote with deadlines, drawings or specifications?', when: (a) => yes(a, 'sells_quotes') },
  { id: 'contracts', kind: 'yesno', text: 'Do you service customers’ equipment on agreements, with scheduled visits and technicians in trucks?', when: (a) => has(a, 'business', 'services') },
  { id: 'certs', kind: 'multi', text: 'What do customers or regulators require you to prove?', options: [
    { value: 'iso9001', label: 'ISO 9001' }, { value: 'iatf', label: 'IATF 16949 or AS9100' }, { value: 'gmp', label: 'FDA / GMP (medical, pharma)' }, { value: 'food', label: 'Food safety (HACCP, SQF, FSMA)' },
    { value: 'osha', label: 'A safety program (OSHA)' }, { value: 'none', label: 'Nothing formal' }] },
  { id: 'change_control', kind: 'yesno', text: 'Must changes to equipment, processes or procedures be reviewed and approved before use?', when: (a) => !has(a, 'certs', 'none') || has(a, 'business', 'makes') },
  { id: 'training', kind: 'yesno', text: 'Must you prove that people are trained and qualified for the work (certificates that expire)?' },
  { id: 'time', kind: 'yesno', text: 'Do people record their hours on timesheets that someone approves?' },
  { id: 'expenses', kind: 'yesno', text: 'Do employees claim expenses that need approval?' },
  { id: 'books', kind: 'yesno', text: 'Do you need the system to keep the books (invoices, bills, bank reconciliation), rather than send them to accounting software?' },
  { id: 'rent', kind: 'yesno', text: 'Do you rent out space and bill tenants?', when: (a) => has(a, 'business', 'property') },
  { id: 'stores', kind: 'yesno', text: 'Do managers walk stores or restaurants against a standards checklist, or record temperatures?', when: (a) => has(a, 'business', 'retail') || has(a, 'business', 'food') },
  { id: 'today_books', kind: 'single', text: 'What do you use for the books today?', options: [{ value: 'quickbooks', label: 'QuickBooks' }, { value: 'xero', label: 'Xero' }, { value: 'sage', label: 'Sage' }, { value: 'spreadsheet', label: 'Spreadsheets' }, { value: 'other', label: 'Something else' }, { value: 'none', label: 'Nothing yet' }] },
  { id: 'today_maint', kind: 'single', text: 'What do you use to track maintenance today?', when: (a) => yes(a, 'own_equipment') || has(a, 'business', 'services'), options: [{ value: 'cmms', label: 'Maintenance software' }, { value: 'spreadsheet', label: 'Spreadsheets' }, { value: 'paper', label: 'Paper or nothing' }] },
];

export interface FitResult {
  version: number;
  show: { feature: string; label: string; why: string }[];
  maybe: { feature: string; label: string; why: string }[];
  hide: { feature: string; label: string }[];
  depth: 'guided' | 'standard' | 'full'; depthWhy: string;
  steps: string[];
  notFit: string[];
}

/** Features everyone gets: the company basics. */
const BASE = ['news', 'people', 'policies', 'improvements'];

export function evaluate(a: Answers): FitResult {
  const why = new Map<string, string>(); const maybe = new Map<string, string>(); const steps = new Set<string>(['sites', 'employees', 'users_roles', 'customers']); const notFit: string[] = [];
  const add = (f: string, w: string) => { if (!why.has(f)) why.set(f, w); maybe.delete(f); };
  const may = (f: string, w: string) => { if (!why.has(f) && !maybe.has(f)) maybe.set(f, w); };
  const makes = has(a, 'business', 'makes'), maintains = has(a, 'business', 'maintains'), services = has(a, 'business', 'services'), sells = has(a, 'business', 'sells'), food = has(a, 'business', 'food'), retail = has(a, 'business', 'retail'), property = has(a, 'business', 'property');
  for (const f of BASE) add(f, 'Company basics every business uses.');
  if (yes(a, 'own_equipment') || maintains || makes) { add('assets', 'You keep equipment that has to be maintained.'); add('work_orders', 'Repairs are tracked as work orders.'); add('pm', 'Scheduled upkeep is generated from plans.'); ['assets', 'work_order_history', 'pm_plans', 'asset_downtime'].forEach((s) => steps.add(s)); }
  if (yes(a, 'stock')) { add('storerooms', 'You keep stock; receipts, issues and counts go through one ledger.'); ['parts', 'stock_locations', 'stock_balances'].forEach((s) => steps.add(s)); }
  if (yes(a, 'tracked')) steps.add('stock_balances');
  if (yes(a, 'buys')) { add('purchasing', 'You buy with purchase orders and approvals.'); ['suppliers', 'supplier_prices', 'open_purchase_orders'].forEach((s) => steps.add(s)); }
  if (yes(a, 'sells_quotes') || sells) { add('sales', 'You send quotes and take orders.'); add('crm', 'Customers and opportunities.'); add('receivables', 'Invoices and collections follow orders.'); ['sales_items', 'opportunities', 'open_customer_invoices'].forEach((s) => steps.add(s)); }
  if (makes) { add('production', 'You make product.'); add('planning', 'Plan material and capacity from orders and forecasts.'); add('shift_log', 'Shift handover on the floor.'); ['boms', 'work_centers', 'routings'].forEach((s) => steps.add(s)); may('quality', 'Makers usually need nonconformances and calibration.'); }
  if (services && yes(a, 'contracts')) { add('field_service', 'You service customers’ equipment on agreements (licensed per site: talk to us).'); add('crm', 'Customers and their sites.'); add('sales', 'Quotes for repairs found on visits.'); add('receivables', 'Invoices per visit and per month.'); add('assets', 'Customers’ equipment is tracked as assets.'); add('storerooms', 'Truck stock is stock.'); add('work_orders', 'Each visit has a work order.'); }
  if (has(a, 'certs', 'iso9001') || has(a, 'certs', 'iatf') || has(a, 'certs', 'gmp')) { add('quality', 'You must show quality records to auditors or customers.'); add('capa', 'Corrective action with 8D is expected by these standards.'); add('changes', 'Change control is part of these standards.'); may('fmea', 'Risk analysis on products and processes.'); steps.add('nonconformance_history'); }
  if (has(a, 'certs', 'iatf')) { may('spc', 'Statistical process control is standard in IATF and AS9100 work.'); may('continuity', 'Business continuity plans are expected.'); steps.add('spc_characteristics'); }
  if (has(a, 'certs', 'osha') || has(a, 'certs', 'food') || has(a, 'certs', 'gmp') || food) { add('safety', 'Incidents, near misses and investigations.'); steps.add('safety_history'); }
  if (yes(a, 'change_control')) add('changes', 'Changes are reviewed and approved before use.');
  if (yes(a, 'training') || has(a, 'certs', 'gmp') || has(a, 'certs', 'osha')) { add('training', 'Training and qualifications with expiry.'); steps.add('qualifications'); steps.add('qualification_records'); }
  if (yes(a, 'time')) { add('time', 'Weekly timesheets with approval.'); steps.add('earning_codes'); }
  if (yes(a, 'expenses')) { add('expenses', 'Expense claims with approval by department and amount.'); steps.add('expense_categories'); }
  if (yes(a, 'books')) { add('books', 'Built-in books: invoices, bills, bank reconciliation.'); add('payables', 'Supplier bills.'); add('receivables', 'Customer invoices.'); ['chart_of_accounts', 'opening_balances', 'open_supplier_bills', 'bank_transactions'].forEach((s) => steps.add(s)); }
  else if (yes(a, 'buys') || yes(a, 'sells_quotes')) { may('payables', 'Bills can be captured and sent to your accounting software.'); may('receivables', 'Invoices can be issued and sent to your accounting software.'); }
  if (property && yes(a, 'rent')) { add('leasing', 'Rent roll, leases and tenant charges.'); ['rental_units', 'leases'].forEach((s) => steps.add(s)); }
  if (yes(a, 'stores') || retail || food) { add('visits', 'Standards walks and condition readings (temperatures).'); ['condition_points', 'condition_readings'].forEach((s) => steps.add(s)); }
  if (yes(a, 'rfq_out')) may('purchasing', 'Request for quote with comparison sits in Purchasing.');
  if (yes(a, 'rfq_in')) add('sales', 'Customer requests for quote are tracked in Sales.');
  if (property) may('assets', 'Buildings and building systems are assets too.');
  may('budgets', 'Budgets by department and account, when you are ready for them.'); may('proforma', 'Business cases for investments, when you need them.'); may('performance', 'Performance reviews at a frequency HR sets.');
  if (sells && makes) may('planning', 'Customer forecasts feed the plan.');

  // Not a fit yet: said plainly.
  if (has(a, 'business', 'food') && yes(a, 'tracked')) notFit.push('Recipe costing and menu management are not included; lot and expiry tracking, temperatures and safety records are.');
  if (retail) notFit.push('There is no point-of-sale or e-commerce; store operations are standards walks, conditions and the company basics.');
  if (yes(a, 'books')) notFit.push('The built-in books are for small and mid-size companies: no payroll calculation or tax filing, multi-currency or consolidation. Payroll stays with your payroll provider.');
  if (yes(a, 'scanning')) notFit.push('Scanning needs a connection; there is no offline scanning yet.');
  if (services && yes(a, 'contracts')) notFit.push('Dispatch estimates drive time from straight-line distance (no maps or GPS yet); there is no customer portal and no emailed reports yet.');
  if (a.sites === '10+' || a.people === '200+') notFit.push('Larger companies should plan a full implementation with a named owner per step; a rehearsal copy is part of it.');
  if (has(a, 'business', 'office') && !makes && !maintains && !services && !sells && !food && !retail && !property) notFit.push('An office-only business will find the company basics, expenses, time and books useful; the operations features will not apply.');

  // Plan depth: bigger and more regulated means a deeper plan.
  const score = (a.sites === '4-10' ? 1 : a.sites === '10+' ? 2 : 0) + (a.people === '51-200' ? 1 : a.people === '200+' ? 2 : 0) + (has(a, 'certs', 'iatf') || has(a, 'certs', 'gmp') ? 1 : 0) + (why.size > 14 ? 1 : 0);
  const depth = score >= 3 ? 'full' : score >= 1 || why.size > 9 ? 'standard' : 'guided';
  const depthWhy = depth === 'full' ? 'Several sites or people, a regulated customer base and many features: plan a full implementation with a rehearsal copy.' : depth === 'standard' ? 'A mid-size scope: a standard plan covers the data that matters and the usual connections.' : 'A small scope: a guided plan with the essentials is enough, and you can deepen it later.';
  if (a.today_books === 'quickbooks' || a.today_books === 'xero' || a.today_books === 'sage') steps.add('conn_accounting');
  steps.add('conn_bank');

  const label = (k: string) => FEATURES.find((f) => f.key === k)?.label ?? k;
  const shown = [...why.keys()];
  return {
    version: INTERVIEW_VERSION,
    show: shown.map((feature) => ({ feature, label: label(feature), why: why.get(feature)! })),
    maybe: [...maybe.entries()].filter(([f]) => !why.has(f)).map(([feature, w]) => ({ feature, label: label(feature), why: w })),
    hide: FEATURES.filter((f) => !why.has(f.key) && !maybe.has(f.key)).map((f) => ({ feature: f.key, label: f.label })),
    depth, depthWhy, steps: [...steps], notFit,
  };
}

/** The questions to ask for the answers so far (branching), in order. */
export const askable = (a: Answers) => QUESTIONS.filter((q) => !q.when || q.when(a));
