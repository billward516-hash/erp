import { FEATURES } from '../../platform/features.js';

/**
 * The fit interview (SC-004 A): plain questions about what the business does, turned into a recommendation of which features to show,
 * how deep the implementation plan should go, which data steps apply and what is not a fit yet. It lives in code so it is versioned with
 * the product; answers are stored per company and the result is recomputed from them, so a changed rule improves every re-take.
 */
export const INTERVIEW_VERSION = 2;
export type Answers = Record<string, string | string[] | boolean | number | undefined>;

export interface Question {
  id: string; text: string; help?: string; kind: 'single' | 'multi' | 'yesno' | 'number' | 'text';
  options?: { value: string; label: string }[];
  /** For number questions: the unit shown beside the box and the accepted range. */
  unit?: string; min?: number; max?: number;
  /** The group of questions it belongs to (the page shows them under a heading). */
  section?: string;
  /** Asked only when this holds for the answers so far. */
  when?: (a: Answers) => boolean;
}
const has = (a: Answers, id: string, v: string) => (Array.isArray(a[id]) ? (a[id] as string[]).includes(v) : a[id] === v);
const yes = (a: Answers, id: string) => a[id] === true;
const num = (a: Answers, id: string) => (typeof a[id] === 'number' ? (a[id] as number) : null);

const CORE: Question[] = [
  { id: 'business', kind: 'multi', text: 'What does the company do? Choose everything that applies.', options: [
    { value: 'makes', label: 'Makes products' }, { value: 'maintains', label: 'Maintains its own equipment or buildings' }, { value: 'services', label: 'Services other people’s equipment' },
    { value: 'sells', label: 'Sells goods or services to customers' }, { value: 'food', label: 'Restaurants or food service' }, { value: 'retail', label: 'Runs retail stores' },
    { value: 'property', label: 'Owns or rents out property' }, { value: 'lab', label: 'Runs a laboratory or cleanroom' }, { value: 'professional', label: 'Sells professional services (consulting, agency, accounting, IT, legal)' },
    { value: 'office', label: 'Office work only, nothing physical' }, { value: 'other', label: 'Something else' }] },
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

const opt = (...pairs: [string, string][]) => pairs.map(([value, label]) => ({ value, label }));
const physical = (a: Answers) => ['makes', 'maintains', 'services', 'food', 'retail', 'property', 'lab'].some((b) => has(a, 'business', b));
const serviceish = (a: Answers) => has(a, 'business', 'services') || has(a, 'business', 'professional') || has(a, 'business', 'lab');

/** Added in version 2: why the company is looking, how it earns and bills, size of the data, readiness, and the company's own numbers for a business case. */
const MORE: Question[] = [
  { id: 'customers_n', kind: 'single', text: 'About how many customers do you actively serve?', options: opt(['<25', 'Fewer than 25'], ['25-250', '25 to 250'], ['250-2500', '250 to 2,500'], ['2500+', 'More than 2,500']) },
  // Why now
  { id: 'reasons', kind: 'multi', text: 'What is the main reason you are looking at a new system now?', help: 'Choose up to three that matter most.', options: opt(
    ['spreadsheets', 'Spreadsheets and paper no longer cope'], ['audit', 'An audit or a customer requirement'], ['growth', 'Growth: more people, sites or customers'], ['cost', 'Current software costs too much or is being retired'],
    ['visibility', 'Nobody can see across sites or departments'], ['incident', 'Something went wrong (a failure, a recall, a complaint)'], ['people', 'Key people are retiring or leaving'], ['acquisition', 'A merger or acquisition']) },
  { id: 'pains', kind: 'multi', text: 'What goes wrong most often today?', help: 'Choose everything that is true, even if it only happens sometimes.', options: opt(
    ['late_work', 'Repairs and scheduled upkeep get done late or missed'], ['breakdowns', 'Unplanned breakdowns stop work'], ['stock', 'Stockouts, or too much stock'], ['quality', 'Repeat defects or customer complaints'],
    ['training', 'We cannot prove people are trained and qualified'], ['billing', 'Billing is slow or work goes unbilled'], ['close', 'Month-end close takes too long'], ['audit_scramble', 'We scramble to find records before audits'],
    ['knowledge', 'Knowledge walks out the door when people leave'], ['cross_site', 'No single view across sites'], ['response', 'Customers wait too long for answers or visits'], ['paper', 'Paper and double entry'],
    ['traceability', 'We cannot trace a result or a lot back to who, what and when'], ['excursions', 'Environmental or process excursions are found late']) },
  // How you earn and bill
  { id: 'revenue', kind: 'multi', text: 'How does the company earn its money?', options: opt(
    ['products', 'Selling products'], ['fixed_jobs', 'Fixed-price jobs or projects'], ['time_materials', 'Time and materials (hours plus parts)'], ['agreements', 'Service agreements with scheduled visits'],
    ['retainers', 'Retainers or subscriptions billed every month'], ['rent', 'Rent'], ['tests', 'Fees for tests or analysis']) },
  { id: 'bill_hours', kind: 'yesno', text: 'Do you bill customers for people’s hours (by the hour or day)?', when: (a) => has(a, 'revenue', 'time_materials') || has(a, 'business', 'professional') },
  { id: 'projects', kind: 'yesno', text: 'Do you run projects that have a budget, milestones and a team, and report profit per project?', when: (a) => has(a, 'revenue', 'fixed_jobs') || has(a, 'business', 'professional') },
  { id: 'utilization', kind: 'yesno', text: 'Do you manage people’s billable utilization (billable hours against hours available)?', when: (a) => yes(a, 'bill_hours') },
  { id: 'retainers', kind: 'yesno', text: 'Do customers pay a fixed amount every month or year (retainer, subscription, maintenance plan) that must be invoiced automatically?', when: (a) => has(a, 'revenue', 'retainers') || has(a, 'revenue', 'agreements') },
  { id: 'client_portal', kind: 'yesno', text: 'Do customers expect to sign in themselves to see jobs, reports or invoices?', when: (a) => serviceish(a) || has(a, 'business', 'sells') },
  { id: 'tickets', kind: 'yesno', text: 'Do customers send support requests that you must answer within agreed response times?', when: (a) => serviceish(a) },
  { id: 'job_costing', kind: 'yesno', text: 'Do you need to know the cost and margin of each job (labor, parts and subcontractors)?', when: (a) => has(a, 'revenue', 'fixed_jobs') || has(a, 'revenue', 'time_materials') || has(a, 'business', 'makes') },
  // Labs and cleanrooms
  { id: 'lab_kind', kind: 'multi', text: 'What kind of laboratory or cleanroom?', when: (a) => has(a, 'business', 'lab'), options: opt(
    ['testing', 'A testing laboratory for customers'], ['qc', 'An internal quality-control lab'], ['rd', 'R&D'], ['cleanroom_mfg', 'Manufacturing or assembly in a cleanroom'], ['cleanroom_support', 'Supports semiconductor or cleanroom customers (tools, parts, chemicals, services)']) },
  { id: 'lab_samples', kind: 'yesno', text: 'Do you receive samples, test them against a method and report results?', when: (a) => has(a, 'business', 'lab') && (has(a, 'lab_kind', 'testing') || has(a, 'lab_kind', 'qc') || has(a, 'lab_kind', 'rd')) },
  { id: 'lab_accred', kind: 'single', text: 'Which standard governs the lab?', when: (a) => yes(a, 'lab_samples'), options: opt(['none', 'None formally'], ['17025', 'ISO/IEC 17025'], ['gmp', 'GMP or ISO 13485'], ['other', 'Another standard']) },
  { id: 'cleanroom_class', kind: 'single', text: 'What is the cleanest class you run?', when: (a) => has(a, 'lab_kind', 'cleanroom_mfg') || has(a, 'lab_kind', 'cleanroom_support'), options: opt(['8', 'ISO 8 or 7'], ['6', 'ISO 6 or 5'], ['4', 'ISO 4 or cleaner'], ['unclassified', 'Not classified']) },
  { id: 'em_monitoring', kind: 'yesno', text: 'Do you record particle counts, pressure, temperature or humidity for rooms on a schedule?', when: (a) => has(a, 'lab_kind', 'cleanroom_mfg') || has(a, 'lab_kind', 'cleanroom_support') || has(a, 'lab_kind', 'rd') },
  { id: 'tool_qual', kind: 'yesno', text: 'Must equipment be qualified (installation, operation, performance) and requalified after repairs or changes?', when: (a) => has(a, 'business', 'lab') || has(a, 'certs', 'gmp') },
  { id: 'chem_control', kind: 'yesno', text: 'Do you control hazardous chemicals or reagents (safety data sheets, storage groups, expiry after opening)?', when: (a) => has(a, 'business', 'lab') || has(a, 'business', 'makes') },
  { id: 'calibration', kind: 'yesno', text: 'Do instruments need calibration on a schedule, with results that depend on them being in calibration?', when: (a) => physical(a) },
  // Compliance and risk
  { id: 'audits', kind: 'single', text: 'How often is the company audited by customers, certifiers or regulators?', options: opt(['never', 'Rarely or never'], ['yearly', 'About once a year'], ['quarterly', 'Several times a year'], ['continuous', 'Almost always someone is auditing']) },
  { id: 'recall_risk', kind: 'yesno', text: 'Could a defect or a wrong result hurt people or force a recall?', when: (a) => physical(a) },
  { id: 'retention', kind: 'single', text: 'How long must you keep records?', options: opt(['none', 'No fixed rule'], ['3', 'About 3 years'], ['7', 'About 7 years'], ['10+', 'Ten years or more']) },
  { id: 'esign', kind: 'yesno', text: 'Do approvals need electronic signatures that identify the person and the time?', when: (a) => !has(a, 'certs', 'none') },
  { id: 'security_review', kind: 'yesno', text: 'Will your customers or your insurer ask for a security questionnaire or a penetration test of the system?' },
  // Size of the data
  { id: 'assets_n', kind: 'single', text: 'About how many pieces of equipment would you track?', when: (a) => yes(a, 'own_equipment') || has(a, 'business', 'services') || has(a, 'business', 'lab'), options: opt(['<50', 'Fewer than 50'], ['50-500', '50 to 500'], ['500-5000', '500 to 5,000'], ['5000+', 'More than 5,000']) },
  { id: 'skus_n', kind: 'single', text: 'About how many different stocked items (parts, materials, products)?', when: (a) => yes(a, 'stock'), options: opt(['<500', 'Fewer than 500'], ['500-5000', '500 to 5,000'], ['5000-50000', '5,000 to 50,000'], ['50000+', 'More than 50,000']) },
  { id: 'invoices_n', kind: 'single', text: 'About how many invoices and bills a month?', options: opt(['<50', 'Fewer than 50'], ['50-500', '50 to 500'], ['500-5000', '500 to 5,000'], ['5000+', 'More than 5,000']) },
  { id: 'work_orders_n', kind: 'single', text: 'About how many repair or service jobs a month?', when: (a) => yes(a, 'own_equipment') || has(a, 'business', 'services') || has(a, 'business', 'property'), options: opt(['<20', 'Fewer than 20'], ['20-200', '20 to 200'], ['200-2000', '200 to 2,000'], ['2000+', 'More than 2,000']) },
  // Readiness
  { id: 'who_uses', kind: 'multi', text: 'Who would use the system day to day?', options: opt(['office', 'Office and finance staff'], ['supervisors', 'Supervisors and managers'], ['technicians', 'Technicians and operators'], ['executives', 'Executives (reports and approvals)'], ['external', 'Customers or suppliers']) },
  { id: 'devices', kind: 'multi', text: 'On what devices?', options: opt(['desktop', 'Office computers'], ['tablet', 'Tablets in the shop or on trucks'], ['phone', 'Phones'], ['kiosk', 'Shared screens or kiosks']) },
  { id: 'sso', kind: 'yesno', text: 'Does the company sign in to other tools with Microsoft, Google or Okta accounts?' },
  { id: 'champion', kind: 'yesno', text: 'Is there one named person who will own this project and has time for it?' },
  { id: 'admin_capacity', kind: 'single', text: 'Who will run the system after it is live?', options: opt(['none', 'Nobody has been named'], ['part_time', 'Someone part-time on top of another job'], ['dedicated', 'A dedicated administrator'], ['it', 'An IT team']) },
  { id: 'data_state', kind: 'single', text: 'How good are your lists today (equipment, parts, customers, suppliers)?', options: opt(['clean', 'Clean and in spreadsheets or exports'], ['messy', 'They exist but are messy or duplicated'], ['other_system', 'In another system that can export'], ['none', 'Mostly in people’s heads or on paper']) },
  { id: 'history', kind: 'single', text: 'How much history do you want to bring in (work orders, invoices, readings)?', options: opt(['none', 'None, start fresh'], ['1', 'About one year'], ['3', 'About three years'], ['all', 'All of it']) },
  { id: 'integrations', kind: 'multi', text: 'What must the system connect to?', options: opt(['accounting', 'Accounting software'], ['payroll', 'A payroll provider'], ['pos', 'Point of sale or e-commerce'], ['instruments', 'Instruments, scales or particle counters'], ['bms', 'A building or machine monitoring system'], ['identity', 'Company sign-in (single sign-on)'], ['none', 'Nothing yet']) },
  { id: 'today_other', kind: 'multi', text: 'What do you use today besides spreadsheets?', options: opt(['erp', 'An ERP or MRP system'], ['crm', 'A CRM'], ['qms', 'A quality management system'], ['lms', 'A training system'], ['lims', 'A lab information system'], ['none', 'Nothing']) },
  // The company's own numbers
  { id: 'num_downtime_hours', kind: 'number', unit: 'hours a month', min: 0, max: 100000, text: 'About how many hours a month does unplanned downtime stop equipment or work?', when: (a) => yes(a, 'own_equipment') || has(a, 'business', 'makes') || has(a, 'business', 'lab') },
  { id: 'num_downtime_cost', kind: 'number', unit: 'dollars per hour', min: 0, max: 10000000, text: 'What does one hour of that downtime cost (lost output, idle labor, penalties)?', help: 'A rough figure is fine. Leave blank if you do not know.', when: (a) => num(a, 'num_downtime_hours') !== null && (num(a, 'num_downtime_hours') ?? 0) > 0 },
  { id: 'num_paperwork_hours', kind: 'number', unit: 'hours a week, all staff together', min: 0, max: 100000, text: 'About how many hours a week do your people spend on paperwork, re-keying data or hunting for records?' },
  { id: 'num_loaded_rate', kind: 'number', unit: 'dollars per hour', min: 0, max: 100000, text: 'What is an average hour of staff time worth to the company (wages plus benefits and overhead)?', when: (a) => num(a, 'num_paperwork_hours') !== null || num(a, 'num_audit_days') !== null },
  { id: 'num_audit_days', kind: 'number', unit: 'person-days a year', min: 0, max: 100000, text: 'About how many person-days a year go into preparing for audits and customer visits?', when: (a) => a.audits !== 'never' && a.audits !== undefined },
  { id: 'num_scrap', kind: 'number', unit: 'dollars a year', min: 0, max: 1000000000, text: 'About how much a year is lost to scrap, rework, returns or repeat visits?', when: (a) => has(a, 'business', 'makes') || has(a, 'business', 'services') || has(a, 'business', 'lab') },
  { id: 'num_inventory', kind: 'number', unit: 'dollars', min: 0, max: 100000000000, text: 'About how much stock is on hand at cost?', when: (a) => yes(a, 'stock') },
  { id: 'num_revenue', kind: 'number', unit: 'dollars a year', min: 0, max: 100000000000, text: 'Roughly what is the annual revenue?', when: (a) => has(a, 'pains', 'billing') },
  { id: 'num_invoice_days', kind: 'number', unit: 'days', min: 0, max: 365, text: 'On average, how many days pass between finishing work and sending the invoice?', when: (a) => has(a, 'pains', 'billing') },
  // Goals and decision
  { id: 'goals', kind: 'multi', text: 'What would make this a success a year from now?', help: 'Choose up to three.', options: opt(
    ['uptime', 'Less downtime'], ['paperwork', 'Less paperwork'], ['audits', 'Audits that go smoothly'], ['inventory', 'Less money tied up in stock'], ['speed', 'Faster quotes and invoices'], ['close', 'A faster month-end close'],
    ['visibility', 'One view of the whole company'], ['onboarding', 'New people productive sooner'], ['win', 'Winning customers that require certification'], ['quality', 'Fewer defects and complaints']) },
  { id: 'success_text', kind: 'text', text: 'In one sentence: what would you point to a year from now to say it worked?', help: 'Optional. Your own words go in the summary.' },
  { id: 'timeline', kind: 'single', text: 'When do you want to be using it?', options: opt(['3', 'Within three months'], ['6', 'Within six months'], ['12', 'Within a year'], ['explore', 'Just exploring']) },
  { id: 'decider', kind: 'single', text: 'Who decides?', options: opt(['owner', 'The owner'], ['team', 'A small team'], ['committee', 'A committee or board'], ['unsure', 'Not clear yet']) },
  { id: 'blockers', kind: 'multi', text: 'What could stop this from happening?', options: opt(['price', 'Price'], ['data', 'Cleaning up our data'], ['time', 'People’s time'], ['it', 'An IT or security review'], ['integration', 'A connection we need'], ['fit', 'Not sure it fits'], ['change', 'People resisting change']) },
];

const SECTIONS = ['About the business', 'Why now', 'How you earn and bill', 'Equipment, stock and buying', 'Laboratories and cleanrooms', 'Proof and compliance', 'People and money', 'Size of the data', 'Readiness', 'Your own numbers', 'Goals and decision'] as const;
const SECTION_OF: Record<string, (typeof SECTIONS)[number]> = {
  business: 'About the business', sites: 'About the business', people: 'About the business', customers_n: 'About the business',
  reasons: 'Why now', pains: 'Why now',
  revenue: 'How you earn and bill', bill_hours: 'How you earn and bill', projects: 'How you earn and bill', utilization: 'How you earn and bill', retainers: 'How you earn and bill', client_portal: 'How you earn and bill', tickets: 'How you earn and bill', job_costing: 'How you earn and bill',
  sells_quotes: 'How you earn and bill', rfq_in: 'How you earn and bill', contracts: 'How you earn and bill', rent: 'How you earn and bill',
  own_equipment: 'Equipment, stock and buying', assets_n: 'Equipment, stock and buying', stock: 'Equipment, stock and buying', skus_n: 'Equipment, stock and buying', tracked: 'Equipment, stock and buying', scanning: 'Equipment, stock and buying', make_to: 'Equipment, stock and buying',
  buys: 'Equipment, stock and buying', rfq_out: 'Equipment, stock and buying', work_orders_n: 'Equipment, stock and buying', stores: 'Equipment, stock and buying',
  lab_kind: 'Laboratories and cleanrooms', lab_samples: 'Laboratories and cleanrooms', lab_accred: 'Laboratories and cleanrooms', cleanroom_class: 'Laboratories and cleanrooms', em_monitoring: 'Laboratories and cleanrooms', tool_qual: 'Laboratories and cleanrooms', chem_control: 'Laboratories and cleanrooms', calibration: 'Laboratories and cleanrooms',
  certs: 'Proof and compliance', audits: 'Proof and compliance', change_control: 'Proof and compliance', training: 'Proof and compliance', recall_risk: 'Proof and compliance', retention: 'Proof and compliance', esign: 'Proof and compliance', security_review: 'Proof and compliance',
  time: 'People and money', expenses: 'People and money', books: 'People and money', invoices_n: 'People and money', today_books: 'People and money',
  who_uses: 'Readiness', devices: 'Readiness', sso: 'Readiness', champion: 'Readiness', admin_capacity: 'Readiness', data_state: 'Readiness', history: 'Readiness', integrations: 'Readiness', today_maint: 'Readiness', today_other: 'Readiness',
  num_downtime_hours: 'Your own numbers', num_downtime_cost: 'Your own numbers', num_paperwork_hours: 'Your own numbers', num_loaded_rate: 'Your own numbers', num_audit_days: 'Your own numbers', num_scrap: 'Your own numbers', num_inventory: 'Your own numbers', num_revenue: 'Your own numbers', num_invoice_days: 'Your own numbers',
  goals: 'Goals and decision', success_text: 'Goals and decision', timeline: 'Goals and decision', decider: 'Goals and decision', blockers: 'Goals and decision',
};
export const QUESTIONS: Question[] = [...CORE, ...MORE].map((q, i) => ({ q, i, s: SECTIONS.indexOf(SECTION_OF[q.id] ?? 'About the business') }))
  .sort((x, y) => x.s - y.s || x.i - y.i).map(({ q }) => ({ ...q, section: SECTION_OF[q.id] ?? 'About the business' }));


export interface FitResult {
  version: number;
  show: { feature: string; label: string; why: string }[];
  maybe: { feature: string; label: string; why: string }[];
  hide: { feature: string; label: string }[];
  depth: 'guided' | 'standard' | 'full'; depthWhy: string;
  steps: string[];
  notFit: string[];
  /** Needs the answers point to that the product does not serve yet (held on purpose): the evidence for building them. */
  unmet: { key: string; label: string; note: string }[];
  /** What the company's own numbers say is exposed, with the arithmetic shown. Not a forecast of savings. */
  businessCase: { lines: { key: string; label: string; amount: number; kind: 'yearly cost' | 'cash tied up'; how: string }[]; yearlyTotal: number; cashTotal: number; tenPercent: number; note: string } | null;
  /** What to measure before starting, and where the product reports it. */
  measures: { metric: string; where: string }[];
  /** How ready the company is, with plain advice. */
  readiness: { level: 'ready' | 'some work' | 'needs groundwork'; flags: { ok: boolean; text: string }[] };
  goals: string[];
  success: string | null;
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
  const score = (a.sites === '4-10' ? 1 : a.sites === '10+' ? 2 : 0) + (a.people === '51-200' ? 1 : a.people === '200+' ? 2 : 0) + (has(a, 'certs', 'iatf') || has(a, 'certs', 'gmp') ? 1 : 0) + (why.size > 14 ? 1 : 0) + (a.assets_n === '5000+' || a.skus_n === '50000+' || a.invoices_n === '5000+' || a.work_orders_n === '2000+' ? 1 : 0);
  const depth = score >= 3 ? 'full' : score >= 1 || why.size > 9 ? 'standard' : 'guided';
  const depthWhy = depth === 'full' ? 'Several sites or people, a regulated customer base and many features: plan a full implementation with a rehearsal copy.' : depth === 'standard' ? 'A mid-size scope: a standard plan covers the data that matters and the usual connections.' : 'A small scope: a guided plan with the essentials is enough, and you can deepen it later.';
  if (a.today_books === 'quickbooks' || a.today_books === 'xero' || a.today_books === 'sage') steps.add('conn_accounting');
  steps.add('conn_bank');


  // ---- Version 2: lab and cleanroom features, held needs, the company's own numbers, what to measure and readiness. ----
  const known = (f: string) => FEATURES.some((x) => x.key === f);
  const addIf = (f: string, w: string) => { if (known(f)) add(f, w); };
  const lab = has(a, 'business', 'lab');
  if (lab || has(a, 'lab_kind', 'cleanroom_mfg') || has(a, 'lab_kind', 'cleanroom_support')) {
    add('assets', 'Rooms, tools and instruments are assets.'); add('work_orders', 'Repairs and upkeep are tracked as work orders.'); add('pm', 'Scheduled upkeep and calibration reminders.');
    add('quality', 'Nonconformances, calibration and audits.'); add('capa', 'Corrective action with 8D.'); add('changes', 'Change control and change notices.'); add('training', 'Qualifications gate who may do which task.'); steps.add('qualifications'); steps.add('qualification_records');
  }
  if (yes(a, 'em_monitoring') || has(a, 'lab_kind', 'cleanroom_mfg') || has(a, 'lab_kind', 'cleanroom_support')) addIf('cleanroom', 'Particle counts, pressure, temperature and humidity against class limits, with excursions raised.');
  if (yes(a, 'tool_qual')) addIf('qualification', 'Equipment qualification (IQ, OQ, PQ) with requalification before return to service, and a logbook.');
  if (yes(a, 'chem_control')) addIf('chemicals', 'Hazard classes, safety data sheets, storage groups and in-use expiry.');
  if (yes(a, 'lab_samples')) addIf('lab_samples', 'Samples with chain of custody, results against limits, investigations and a certificate of analysis.');
  if (yes(a, 'calibration')) { add('quality', 'Calibration records block use of overdue instruments.'); }
  if (yes(a, 'esign')) may('documents', 'Optional electronic signatures are available on document approvals.');
  if (yes(a, 'tickets') && !(services && yes(a, 'contracts'))) may('work_orders', 'Requests can be received through request links and tracked with response targets.');

  const unmet: FitResult['unmet'] = [];
  const want = (key: string, label: string, note: string) => { if (!unmet.some((u) => u.key === key)) unmet.push({ key, label, note }); };
  if (yes(a, 'bill_hours')) want('hourly_billing', 'Billing people’s hours by the hour or day', 'Hours are recorded on timesheets and work orders and invoices are drafted by hand; there is no billing of hours by client, rate card or project yet.');
  if (yes(a, 'projects')) want('projects', 'Projects with budgets, milestones and profit per project', 'Business cases and work orders exist; there is no project budget, milestone or project profit view yet.');
  if (yes(a, 'utilization')) want('utilization', 'Billable utilization of people', 'Labor productivity and wrench time are reported for maintenance; billable utilization against hours available is not.');
  if (yes(a, 'retainers')) want('recurring_billing', 'Retainers and subscriptions invoiced automatically', 'Service agreements generate visits and monthly lease charges are prorated; automatic recurring invoices for retainers or subscriptions do not exist yet.');
  if (yes(a, 'client_portal')) want('client_portal', 'A customer sign-in to see jobs, reports and invoices', 'Customers receive PDFs and a no-sign-in request link; there is no customer portal yet.');
  if (yes(a, 'tickets')) want('ticketing', 'A support queue with response-time targets', 'Requests and work orders have service levels for contractors; a customer-facing ticket queue is not built.');
  if (yes(a, 'job_costing') && !makes) want('job_costing', 'Cost and margin per job for service work', 'Work orders collect labor and parts cost; margin against the invoice per job is not reported yet.');
  if (has(a, 'integrations', 'pos')) want('pos', 'Point-of-sale or e-commerce connection', 'Not built; sales arrive by invoice or file import.');
  if (has(a, 'integrations', 'instruments') || has(a, 'integrations', 'bms')) want('live_instruments', 'Live connection to instruments, counters or monitoring systems', 'Readings come in by file import or typing; no live connection exists.');
  if (has(a, 'business', 'food') && yes(a, 'tracked')) want('recipes', 'Recipes, plate cost and allergen matrix', 'Not built.');
  if (yes(a, 'lab_samples') && a.lab_accred === '17025') want('accreditation', 'Records shaped to ISO/IEC 17025 audits (uncertainty, proficiency testing)', 'The platform holds records that support the work; it does not claim accreditation and has no measurement-uncertainty or proficiency-testing features.');
  if (has(a, 'business', 'professional') && !makes && !maintains && !services) notFit.push('Professional-services work is held: projects, hourly billing, retainers, utilization and a client portal are not built (the answers are recorded as demand). The company basics, time, expenses, quotes, invoices, books and training do apply.');
  if (has(a, 'business', 'other') && !makes && !maintains && !services && !sells && !food && !retail && !property && !lab) notFit.push('Tell us what the business does: the platform is built for companies that run equipment, buildings, crews, production lines or labs.');
  if (a.security_review === true) notFit.push('Security questionnaires are common; an independent penetration test has not been done yet, and documents for customers (OPERATIONS runbook, security self-review) are available now.');
  if (has(a, 'integrations', 'payroll') ) notFit.push('Payroll stays with your provider; the platform exports hours and earning codes as a file.');

  // The company's own numbers: arithmetic on what was typed, nothing assumed.
  const rate = num(a, 'num_loaded_rate');
  const lines: NonNullable<FitResult['businessCase']>['lines'] = [];
  const dh = num(a, 'num_downtime_hours'), dc = num(a, 'num_downtime_cost');
  if (dh && dc) lines.push({ key: 'downtime', label: 'Unplanned downtime', amount: dh * dc * 12, kind: 'yearly cost', how: `${dh} hours a month × $${dc}/hour × 12` });
  const ph = num(a, 'num_paperwork_hours');
  if (ph && rate) lines.push({ key: 'paperwork', label: 'Paperwork, re-keying and hunting for records', amount: ph * rate * 52, kind: 'yearly cost', how: `${ph} hours a week × $${rate}/hour × 52` });
  const ad = num(a, 'num_audit_days');
  if (ad && rate) lines.push({ key: 'audit', label: 'Audit and customer-visit preparation', amount: ad * 8 * rate, kind: 'yearly cost', how: `${ad} person-days × 8 hours × $${rate}/hour` });
  const sc = num(a, 'num_scrap');
  if (sc) lines.push({ key: 'scrap', label: 'Scrap, rework, returns and repeat visits', amount: sc, kind: 'yearly cost', how: `$${sc} a year as you stated` });
  const inv = num(a, 'num_inventory');
  if (inv) lines.push({ key: 'inventory', label: 'Stock on hand (cash tied up)', amount: inv, kind: 'cash tied up', how: `$${inv} at cost as you stated` });
  const rev = num(a, 'num_revenue'), idays = num(a, 'num_invoice_days');
  if (rev && idays) lines.push({ key: 'unbilled', label: 'Work finished but not yet invoiced (cash tied up)', amount: Math.round((rev / 365) * idays), kind: 'cash tied up', how: `$${rev} a year ÷ 365 × ${idays} days` });
  const yearlyTotal = lines.filter((l) => l.kind === 'yearly cost').reduce((s2, l) => s2 + l.amount, 0);
  const cashTotal = lines.filter((l) => l.kind === 'cash tied up').reduce((s2, l) => s2 + l.amount, 0);
  const businessCase = lines.length ? { lines, yearlyTotal, cashTotal, tenPercent: Math.round(yearlyTotal * 0.1), note: 'These multiply the numbers you typed, to show where money is exposed. They are not a forecast of savings. Agree a starting measure for each, then measure again after go-live.' } : null;

  // What to measure first, with where the product reports it.
  const measureMap: Record<string, { metric: string; where: string }> = {
    late_work: { metric: 'Share of work orders and PMs done on time', where: 'Reports → PM compliance; Insight → What is late' },
    breakdowns: { metric: 'Unplanned downtime hours, MTBF and MTTR per machine', where: 'Reports → Reliability and Asset availability' },
    stock: { metric: 'Stockouts a month and stock value', where: 'Reports → Inventory reorder' },
    quality: { metric: 'Nonconformances, repeat causes and cost of poor quality', where: 'Reports → Quality status; Quality → CAPA' },
    training: { metric: 'People with a current qualification for each task', where: 'Reports → Qualification status and Training compliance' },
    billing: { metric: 'Days from finished work to invoice, and receivables aging', where: 'Reports → AR aging' },
    close: { metric: 'Days to close the month', where: 'Books → Statements (record the close date each month)' },
    audit_scramble: { metric: 'Audit findings per audit and days of preparation', where: 'Quality → Audits; Reports → Document reads' },
    knowledge: { metric: 'Procedures with a current revision read by the people who use them', where: 'Reports → Document reads' },
    cross_site: { metric: 'The same report for every site', where: 'Reports (choose all sites)' },
    response: { metric: 'Response and completion time against target', where: 'Reports → Service levels and Service performance' },
    paper: { metric: 'Hours a week of re-keying (your own count)', where: 'Time → your count before and after' },
    traceability: { metric: 'Minutes to trace a lot or result back to its source', where: 'Storerooms → Lots trace' },
    excursions: { metric: 'Excursions found late versus on the day', where: 'Cleanrooms report, when the feature is on' },
  };
  const measures = (Array.isArray(a.pains) ? a.pains : []).map((p) => measureMap[p]).filter((m): m is { metric: string; where: string } => !!m);

  // Readiness: plain flags.
  const flags: { ok: boolean; text: string }[] = [];
  if (a.champion !== undefined) flags.push({ ok: yes(a, 'champion'), text: yes(a, 'champion') ? 'A named owner with time for the project.' : 'No named owner yet. Name one person before starting; projects without one stall.' });
  if (a.admin_capacity !== undefined) flags.push({ ok: a.admin_capacity === 'dedicated' || a.admin_capacity === 'it', text: a.admin_capacity === 'dedicated' || a.admin_capacity === 'it' ? 'Someone will run it after go-live.' : a.admin_capacity === 'none' ? 'Nobody has been named to run it after go-live; plan for that before you start.' : 'Running it part-time works for a small scope; keep the first release small.' });
  if (a.data_state !== undefined) flags.push({ ok: a.data_state === 'clean' || a.data_state === 'other_system', text: a.data_state === 'clean' || a.data_state === 'other_system' ? 'Your lists can be imported as they are (the import steps check them first).' : a.data_state === 'messy' ? 'Messy lists: allow a cleanup week and run the rehearsal copy before real data.' : 'Lists live in people’s heads or on paper: plan to build them first, starting with equipment, parts and customers.' });
  if (a.sso !== undefined) flags.push({ ok: true, text: yes(a, 'sso') ? 'Company sign-in is available once you give us the identity provider details.' : 'Without company sign-in, people use issued sign-in tokens until you choose a provider.' });
  if (Array.isArray(a.blockers) && a.blockers.length) flags.push({ ok: false, text: `You named these risks: ${(a.blockers as string[]).join(', ')}. Each needs an owner and a date in the plan.` });
  if (a.timeline === '3' && (a.sites === '4-10' || a.sites === '10+' || a.people === '200+')) flags.push({ ok: false, text: 'Three months is tight for this many sites or people; plan a phased release, one site first.' });
  const bad = flags.filter((f) => !f.ok).length;
  const readiness = { level: (bad === 0 ? 'ready' : bad <= 2 ? 'some work' : 'needs groundwork') as 'ready' | 'some work' | 'needs groundwork', flags };
  const goals = Array.isArray(a.goals) ? (a.goals as string[]) : [];
  const success = typeof a.success_text === 'string' && a.success_text.trim() ? a.success_text.trim() : null;

  const label = (k: string) => FEATURES.find((f) => f.key === k)?.label ?? k;
  const shown = [...why.keys()];
  return {
    version: INTERVIEW_VERSION,
    show: shown.map((feature) => ({ feature, label: label(feature), why: why.get(feature)! })),
    maybe: [...maybe.entries()].filter(([f]) => !why.has(f)).map(([feature, w]) => ({ feature, label: label(feature), why: w })),
    hide: FEATURES.filter((f) => !why.has(f.key) && !maybe.has(f.key)).map((f) => ({ feature: f.key, label: f.label })),
    depth, depthWhy, steps: [...steps], notFit, unmet, businessCase, measures, readiness, goals, success,
  };
}

/** The questions to ask for the answers so far (branching), in order. */
export const askable = (a: Answers) => QUESTIONS.filter((q) => !q.when || q.when(a));
