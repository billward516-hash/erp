# Build log

## 2026-10-22: S9b FMEA

**Decisions** (D-075 to D-078):
- FMEA reuses the shared primitives.
- Action priority by default, RPN optional, priority always computed.
- High-priority rows need actions; approved analysis is frozen, with after-action evaluation and revisions.
- Equipment rows are checked against failure history.

**Built**
- Migration `0018`:
  - FMEAs (revisions under one number, one open revision at a time)
  - FMEA rows with a trigger that freezes the analysis after submission
  - actions, corrective actions and attachments can belong to an FMEA
- `quality/fmea`:
  - action priority table; method-aware priority
  - create; save worksheet (row ids preserved)
  - submit (high-priority rows need a response) → quality review through the approval engine → approve/supersede or back to draft
  - revise from after-action scores
  - evaluate a row after actions; corrective action from a row
  - read with failure history and occurrence check; list
- Report **FMEA risk register**.
- Web:
  - Quality gains an FMEA tab (list and start form)
  - FMEA page: worksheet editor and view with priority pills, per-row actions, after-action evaluation, failures in 12 months, revisions, files
- Seed:
  - an approved equipment FMEA for the CNC-104 turning cell (one high-priority mode reduced to low after its action; the turret sensor mode flagged as happening more than rated)
  - a draft process FMEA for HSG-220 assembly

**Verified (commands actually run)**
- `npm run typecheck` clean; `npm run web:build` succeeds.
- `npm test`: **219 tests passed**. The 6 new tests cover:
  - 18 action-priority table cases and RPN thresholds
  - permissions; equipment FMEA needs an asset; score validation; failure codes only on equipment FMEAs; failure-history count and occurrence flag
  - high-priority row blocks submission until it has an action; approval by the quality reviewer; frozen worksheet (service and database)
  - evaluation waits for actions and cannot raise severity
  - revision baseline from after-action scores; supersede on approval
  - corrective action from a row; RPN method; risk register headline
- UI smoke against a freshly seeded server: **135/135 checks passed** (5 new: failure-history flag, before/after summary, submission refused then accepted after adding an action, FMEA report).

**Not done:**
- FMEA structure, function and failure trees (rows are flat)
- linking rows to process FMEA control plans
- organization-specific S/O/D rating scales (the 1–10 scale with handbook meanings is assumed)

## 2026-10-22: S9a Maintenance materials: spares lists, repair templates, kits

**Decisions:** D-017 resolved as "both" (virtual and physical kits); D-071 to D-074.
- Spares and repair BOMs are linked to assets and asset categories.
- Kits reserve stock and can be staged.
- Staging stock and reservations are excluded from availability everywhere.
- Finishing or cancelling a work order releases an unissued kit.

**Built**
- Migration `0017`:
  - equipment parts lists (`asset_part`)
  - repair templates and their parts; `work_order.repair_template_id`
  - stock location kind (storeroom or staging)
  - kits and kit lines (one active kit per work order)
- `materials` module:
  - availability by location and at the site (net of reservations, excluding staging)
  - parts lists with availability and where-used
  - repair templates (machine or category); apply to a work order
  - kits: build, refresh, stage, issue, return and close, cancel, read, list
- PM generation builds kits.
- Maintenance releases unissued kits when a work order completes or is cancelled.
- Production material availability now subtracts kit reservations and excludes staging.
- Storerooms can be created as staging locations.
- Import target `asset_parts` with sample `11_oem_spares_list.csv`.
- Report **Kit readiness and critical spares**; reminder for short kits.
- Web:
  - asset page: spare parts card (availability, critical minimum, also-used-on, add/remove) and repair templates card (list, new template with part search)
  - work order: kit card (apply template, build, refresh, stage, issue, return unused, cancel)
  - Storerooms: Kits tab
- Seed:
  - a Dayton kit staging shelf; the OEM spares list imported (2 rows rejected with reasons)
  - two repair templates
  - PM work orders built with kits: one short of compressor oil, one staged

**Verified (commands actually run)**
- `npm run typecheck` clean; `npm run web:build` succeeds.
- `npm test`: **213 tests passed**. The 10 new materials tests cover:
  - spares availability, below-minimum flag, where-used, permission
  - category repair template applied once, with the labor estimate
  - kit reservation and shortage; reserved stock not offered to others
  - short kit can't be staged; refresh after receipt; staging only into a staging location, needs `inventory.manage`; ledger moves; staging stock not offered
  - issue from staging; return to the original storeroom; virtual-kit issue; cancel restores staged stock
  - work order cancel releases a staged kit; PM generation builds a kit
  - readiness report and critical spares
  - OEM spares import (match by manufacturer number, superseded and unknown parts rejected, re-import unchanged)
- UI smoke against a freshly seeded server: **130/130 checks passed** (5 new: short kit in the kit list, refresh after a delivery and staging on the shelf, spares and templates on the asset page).
- Found and fixed while checking: kits on work orders the seed had already completed kept stock reserved (now released on completion or cancellation); the short-kit reminder's 7-day window cut off work due later on day 7.

**Not done:**
- substitutions and alternates on kit lines
- kit lead times on PM plans (kits are built when the work order is generated)
- serial and lot tracking
- reliability analytics (MTBF/MTTR)

## 2026-10-22: S8c Calibration, internal audits, attachments

**Decisions** (D-067 to D-070):
- Instruments are assets under calibration control, and production is blocked when they are overdue.
- Out-of-tolerance results raise a nonconformance listing the affected runs; failed instruments go out of service.
- Audits record evidence per item, the auditor is independent of the area, and every finding is answered before close.
- Attachments follow the visibility of their record; incident files are restricted by default.

**Built**
- Migration `0016`:
  - calibration plans and immutable calibration records
  - audits and checklist items (database check: auditor ≠ area owner)
  - action items can belong to an audit and a checklist item
  - attachments
- `quality/calibration`: plan, record (impact assessment nonconformance, out of service / back in service), list with status (current, due soon, overdue, failed), plan detail with usage since the last good calibration; `assertCalibrated` called from production start.
- `quality/audits`: plan, start, record item, add item, report (area owner notified), corrective action for a finding, close (findings answered), read.
- `quality/attachments`: add, list, download with record-based access and the incident restriction.
- Reminders for calibration (overdue daily, due within 14 days weekly); the quality report now counts instruments overdue and unanswered audit findings.
- Web:
  - Quality gains Calibration and Audits tabs
  - calibration page: usage since the last good calibration, record form, history with nonconformance links, certificate upload
  - audit page: checklist recording, report, finding responses, close
  - an attachments panel on nonconformances, corrective actions, incidents (with "safety team only"), calibration and audits
- Seed:
  - the CMM, a micrometer (due in 5 days) and a bore gauge (3 days overdue) under calibration
  - an internal audit of the machining cell, reported with one minor finding and one observation
  - a planned maintenance and calibration audit

**Verified (commands actually run)**
- `npm run typecheck` clean; `npm run web:build` succeeds.
- `npm test`: **203 tests passed**. The 8 new tests cover:
  - calibration: overdue instrument blocks a production run; manage permission; future dates refused; next due date; immutable records
  - out of tolerance: notes required, can't be "in tolerance" as left, nonconformance with the suspect run listed
  - failed → out of service → passing returns it
  - audits: auditor ≠ area owner; start before recording; evidence required; report needs every item; area owner notice; findings answered before close by corrective action or action
  - attachments: incident photo restricted (manager can't list or download, safety staff and uploader can); nonconformance file visible to quality viewers; bad type refused; other facility refused
  - quality report instrument KPI
- UI smoke against a freshly seeded server: **125/125 checks passed** (8 new: photo upload on a nonconformance, recording a calibration, usage list, answering an audit finding with a corrective action and closing).
- Found and fixed while checking: "1 findings" on the audit page.

**Not done:**
- calibration labels and certificate parsing
- measurement uncertainty
- audit programs and auditor qualifications
- supplier audit scoring
- virus scanning of uploads (comes with the production storage adapter)

## 2026-10-22: S8b Quality and safety: nonconformances, corrective actions, incidents, shared actions

**Decisions** (D-061 to D-066):
- Concessions on major or critical nonconformances need a justification and a second person.
- Corrective actions require evidence at each step; the effectiveness check is independent of the owner and not done before its date.
- One action tracker serves corrective actions and incidents.
- Anyone can report incidents and near misses; private details are restricted to the safety team.
- A person decides recordability; there are no OSHA forms.
- The incident rate uses timesheet hours, and the report flags when there are too few.

**Built**
- Migration `0015`:
  - nonconformances, corrective actions, safety incidents, action items (all facility-scoped with RLS)
  - a database check that the effectiveness verifier is not the owner
  - one nonconformance per production run
  - `quality_manager` role; `quality.view/report/manage` and `safety.report/view/manage`, spread across existing roles (operators and technicians can report)
- `quality` module:
  - nonconformances: raise (from a production run, purchase order or sales order, or standalone), contain, disposition with concession rules and scrap costing, link, close, cancel
  - corrective actions: open (linking nonconformances or an incident), update, advance with evidence checks, verify, cancel
  - actions: add, complete, cancel; my actions; assignable users
- `safety` module: report, classify (recordability checks), investigate, close (decision, root cause and action checks), and reads with server-side redaction.
- Reminders: overdue actions (daily, to the owner); corrective actions ready for their effectiveness check (weekly, to quality staff other than the owner); incidents unclassified after a day (daily, to safety staff). New notification kinds.
- Reports **Nonconformances and corrective actions** and **Safety incidents and near misses**. The plural helper now handles "near misses" and "boxes".
- Production order page: "Raise NCR" on runs with scrap, linking to the nonconformance once raised.
- Web:
  - a Quality & safety menu group (Quality, Safety, Changes)
  - Quality: nonconformance list and form; nonconformance page (containment, disposition, corrective action link); corrective action page (step bar, containment and root cause, actions, effectiveness check); new corrective action form; my actions
  - Safety: report form (one tap for the kind), incident list, incident page (classification visible only to safety staff, investigation, corrective action, actions, close)
- Seed:
  - quality: two production nonconformances (one closed, one major under CA-000001 with an overdue action), a receiving nonconformance not yet contained, a customer nonconformance reworked, and CA-000002 waiting for its effectiveness check
  - safety: a closed first-aid case, a recordable strain with an open action, a closed near miss, and an unclassified near miss

**Verified (commands actually run)**
- `npm run typecheck` clean; `npm run web:build` succeeds.
- `npm test`: **195 tests passed**. The 9 new quality and safety tests cover:
  - nonconformance from a production run (fields derived, duplicate refused, reporter can follow it, quality notified)
  - concession rules (justification, not the reporter), return-to-supplier needs a supplier, scrap costing, closing needs a corrective action
  - corrective action step evidence, action owner rules and notices, the effectiveness date, owner can't verify, a failed check reopens, database check
  - incident reporting and notices without private details, redaction for managers, other-facility denial, future time refused
  - classification (days away imply recordable), closing rules, list visibility
  - safety report counts and "cannot compute" without hours, no names in rows
  - reminders for overdue actions and unclassified reports
  - quality report cost of poor quality and repeat part
- UI smoke against a freshly seeded server: **117/117 checks passed** (16 new):
  - quality containment and effectiveness check; owner finishing actions and moving to verification
  - safety team classifying, investigating and adding actions; a manager shown no injury details (asserted absent); an operator reporting a near miss
  - both reports
- Found and fixed while checking:
  - a corrective action with one open action said "complete at least one action" instead of "finish the open actions"
  - a nonconformance from a purchase order without a part was titled with only the PO number
  - the incident rate from a few hundred seeded hours (495 per 200,000 h) was shown without warning; it is now flagged as unstable

**Not done:**
- audits and calibration
- OSHA 300/300A/301 forms
- 8D and FMEA
- supplier corrective action requests sent to suppliers
- customer complaint intake as its own record
- attachments (photos) on nonconformances and incidents; the document store exists, the link does not
- incident reports from the asset page

## 2026-10-22: S8a Production: product revisions, production orders, shop floor

**Decisions** (D-055 to D-060):
- The BOM and routing are versioned together and frozen once released.
- Orders pin the revision at release; shortages are reported but don't block release.
- Shop-floor runs record good, scrap (with a reason) and rework, and quantities flow from operation to operation.
- Operators need the machine's operate qualification, and machines that are down can't run.
- Finished goods are valued at standard material cost.
- Short parts made in house lead to a production order, not a purchase request.

**Built**
- Migration `0014`:
  - work centers and their machines
  - product revisions with materials and operations (trigger freezes released ones)
  - production orders with copied materials and operations; production entries (one open run per operator and per machine; finished runs append-only)
  - scrap reasons; three production stock movements; `production` as an asset-state source
  - `production_supervisor` role; `production.view/manage/execute` (operators can view and execute, operations managers can manage)
- `production` module:
  - work centers; revisions (create as a copy, save whole, circular check, release)
  - orders: create (optionally for a sales order line), release with shortages, request shortages, cancel
  - materials: issue and return
  - shop floor: start/stop with checks (qualification, machine state, flow limits); finish operation
  - output: receive output, complete short, close with variance
  - reads: order detail with metrics, list, work-center floor queue
- Assets: `applyState` split out of `recordState`, so production records machine state after its own permission check.
- Import target `boms` (flat or indented, dotted or outline levels; unit mismatches rejected) with sample `10_engineering_bom_indented.csv`.
- Report **Production status and yield**.
- Sales order lines show their production orders and a "Make" action; the rep is notified when a make-to-order production order finishes.
- Web:
  - a Production menu group with Production orders and Shop floor
  - tabs for orders, shop floor, products and work centers
  - order page: operations, materials with issue and shortages, receiving, shop-floor record, stock movements, complete short or close
  - product revision page: routing and materials editor, release, new revision
  - shop floor: machines and qualification needs, the operator's running job with a stop form, queue with start, running now
- Seed:
  - Carlos (production supervisor); raw materials; the legacy BOM imported (2 rows rejected with reasons)
  - routings added and released; four Dayton work centers; a CMM operator qualification held by Tolu
  - a closed order with scrap and rework history; a make-to-order order for Miami Valley in progress (milling running live on CNC-101, short of seal kits); a planned order

**Verified (commands actually run)**
- `npm run typecheck` clean; `npm run web:build` succeeds.
- `npm test`: **186 tests passed**. The 12 new production tests cover:
  - revisions: self-containment and circular structures refused; routing required to release; released revisions frozen in the database; new revision copies and supersedes
  - orders: release copies materials scaled with scrap allowance; shortages and the purchase request (not duplicated); made-in-house shortages refused for purchase
  - materials: issue and return through the ledger
  - shop floor: machine required and must belong to the work center; one job per machine and per operator; supervisor-only recording for others; scrap reason; flow limit between operations; rework ≤ good; finished runs immutable; qualification and machine-down checks; floor queue
  - output: receipt at standard material cost; complete short reason; close; per-line material variance
  - report: yield and scrap reason
  - BOM import: indented sample; flat file; level parsing
- UI smoke against a freshly seeded server: **101/101 checks passed** (15 new: supervisor, operator on the shop floor, production report).
- Found and fixed while checking:
  - a shortage of an in-house part would have become a purchase request
  - report percentages were on a 0–100 scale instead of the platform's fractions
  - an operation still receiving units looked like it had nothing to do (now "more to come")
  - a seeded run spanned a night shift and skewed hours

**Not done:**
- MRP (multi-level explosion), scheduling and capacity
- labor from production runs is not yet fed into timesheets
- lot/serial traceability
- labor and overhead costing
- routing alternates
- work instructions are linkable in the data model but not yet in the routing editor
- quality records (S8b next)

## 2026-10-22: S7b Receivables: customer invoices, payments, credit hold and collections

**Decisions** (D-050 to D-054):
- Invoice shipped quantity only.
- Number invoices at issue.
- Credit hold over the limit, released by finance.
- Payments follow the accounting system of record.
- Payment reminders are started by a person.

**Built**
- Migration `0013`:
  - `qty_invoiced` on order lines (check ≤ shipped); credit hold on orders
  - customer invoices and lines, customer payments and allocations (append-only)
  - collections activities linked to invoices; payment-reminder emails to customer contacts
  - MOCK accounting customers and invoices
  - `ar_clerk` role; `ar.view` / `ar.manage` / `ar.credit` permissions (finance approvers get all three; sales managers and executives can view)
- `ar` module: draft from order, edit draft, issue (number, due date, stored PDF, outbox event), void, payments with allocation rules, payments from accounting, invoice PDF, to-invoice list, collections queue, call log with promises, payment reminders, customer account with credit exposure.
- Sales: credit check on acceptance, shipping refused while on hold, release with a reason; order page shows invoiced quantity and invoices.
- Integrations: AR topics in both adapters (separate receivables export file; MOCK customer find-or-create and invoices); payments pulled for open AR invoices; four new account keys.
- Notifications: credit-hold notice to credit approvers; weekly overdue-receivables reminder; promise-to-pay follow-ups link to the invoice.
- Report **Accounts receivable aging** (buckets, days sales outstanding, promises, shipped-not-invoiced, credit holds).
- Web:
  - Receivables (Sales menu): invoices, ready to invoice, collections queue, record payment
  - invoice page (edit draft, issue, PDF, collections call, reminder, payments, history, accounting status, void)
  - customer account page
  - credit-hold banner and release on the order page
- Seed: Casey (billing). Three invoices issued (one current, one overdue with a promise to pay, one older and partly paid in MOCK accounting), and a Tri-County order on credit hold.
- Report pages now format currency values (they showed raw numbers, also in the AP aging and pipeline reports).

**Verified (commands actually run)**
- `npm run typecheck` clean; `npm run web:build` succeeds.
- `npm test`: **174 tests passed**. The 10 new receivables tests cover:
  - drafting only shipped quantity; one draft per order
  - issue numbering, due date from terms, stored PDF, outbox payload accounts, invoiced ≤ shipped enforced by the database
  - void returns quantity, drafts never take a number
  - payment allocation rules (whole payment, customer match, balance cap), status transitions, append-only payments
  - credit hold, notification, release permission
  - collections queue, promise to pay, reminder email dedupe, weekly reminder
  - AR aging; file-export receivables CSV; MOCK customer and invoice records; payments from accounting, idempotent
- UI smoke against a freshly seeded server: **86/86 checks passed** (18 new: billing, collections, finance releasing a credit hold, AR aging report).
- Found and fixed while checking:
  - row lock on an outer join failed when issuing
  - the smoke test showed that Lakeshore's imported contact email had been rejected as invalid; the reminder button is now disabled with a note in that case, instead of failing
  - currency formatting on report pages

**Not done:**
- credit memos and customer returns
- unapplied cash and refunds (left in accounting)
- sales tax calculation (typed on the invoice)
- automatic dunning
- statements

## 2026-10-22: S7a CRM, quotes and sales orders

**Decisions** (D-047 to D-049):
- Pricing approval over 15% off list or under 20% margin.
- Customers are tenant-wide.
- The exact PDF sent for each quote revision is stored.

**Built**
- Migration `0012`:
  - customers, contacts (one primary), opportunities, activities
  - sales catalog
  - quotes (lines, sent PDFs), sales orders (lines), shipments (append-only lines)
  - a `shipment` stock movement
  - RLS and grants; sales rep / sales manager roles; `crm.*` / `sales.*` permissions
- `crm` module: customers, contacts, opportunities (stage probabilities, lost reason, automatic advance from quotes), activities and follow-up tasks, pipeline.
- `sales` module:
  - catalog
  - quotes: draft, pricing check, approval through the engine, send (stored PDF and email activity), revise, accept (creates the order, wins the opportunity, makes the prospect a customer), decline with reason
  - orders: promised date; shipments from storerooms through the ledger; cancel only before anything ships; the rep is notified of shipments
- Quote PDF (customer-facing; drafts watermarked).
- Approvals inbox shows quote pricing requests with their reasons.
- Reminders for overdue follow-up tasks and sent quotes about to expire.
- Report **Sales pipeline**.
- Import target `customers`, with sample `09_crm_company_export.csv` and its profile.
- Report wording: a shared plural helper ("opportunities", "people").
- Web:
  - Customers: list, pipeline board, my follow-ups, customer page with contacts, opportunities (stage moves), activity log, quotes and orders.
  - Quotes and orders: lists, catalog, quote editor with list-price discount badges, quote page with internal margin, next-step actions, sent PDFs and approvals; order page with promised date and shipping (defaults capped at stock on hand).
  - A "Sales" menu group.
- Seed:
  - Riley (rep) and Taylor (manager); the CRM export imported; a finished-goods storeroom and catalog.
  - Five opportunities, activities including an overdue follow-up.
  - Quotes: accepted with a partly shipped order now late; one waiting on pricing approval; one sent and expiring; one declined.

**Verified (commands actually run)**
- `npm run typecheck` clean; `npm run web:build` succeeds.
- `npm test`: **164 tests passed**. New tests (sales and unit) cover:
  - primary contact, lost reason
  - in-limit quote ready at once; sent PDF stored; opportunity to proposal; activity logged
  - discount and margin reasons; manager rejection back to draft, then approval
  - revisions keep their own PDFs; expired acceptance refused; decline reason
  - acceptance creates the order (lines, ship-to), wins the opportunity, converts the customer
  - shipping requires a storeroom for stocked items, refuses over-shipping, writes the ledger, notifies the rep; shipment lines are immutable
  - pipeline KPIs; follow-up reminders; customer import with contacts and idempotency; plural wording
- Seeded pipeline: $29,260 weighted across 4 open opportunities, win rate 50%, 1 order late to ship.
- UI smoke against a freshly seeded server: **68/68 checks passed** (11 new: rep, sales manager, order desk).
- Found and fixed while checking:
  - quote lines lost their unit of measure on the PDF (regression test added)
  - "opportunitys" in report text
  - shipping defaulted to more than was in stock

**Not done (S7b next):**
- customer invoices, payments, AR aging and collections queue, export to accounting
- credit-limit checks (need AR)
- customer returns
- taxes (left to accounting)

## 2026-10-22: S3b Notifications and grouped navigation

**Why now:** notifications are a Category 1 shared service in the brief, and every workflow built so far depends on people learning that something waits for them. The admin menu had also outgrown one row.

**Decisions** (D-045, D-046):
- In-app notifications plus an optional daily email digest.
- Email goes through a development adapter only, until a provider is chosen and security-reviewed.
- Reminders are deduplicated per day or per week.
- "Waiting" notices close themselves once the step is decided.

**Built**
- Migration `0011`: notifications (per-user dedupe), preferences (digest on/off, muted kinds), email queue; RLS and grants.
- `platform/notify`: `notify()` inside the caller's transaction (skips muted users and the person who caused the event); recipients by role at a facility (including active delegates), by permission, and by employee.
- Producers:
  - the approval engine: next stage's approvers on create and stage change, requester on decision, and auto-closing waiting notices (subjects register their label and link)
  - work-order assignment, training assignment, timesheet sent back, delivery received for a request
- Reminder sweep (system scope, 10 rules), digest queue and retrying sender, `DevFileMailSender`, `scripts/run-reminders.ts`.
- Web:
  - bell with unread count
  - notifications page (open marks read and goes to the record; mark all read; settings: digest and per-kind mutes)
  - main menu grouped into Maintenance / Supply / People / Admin dropdowns, positioned so they work inside the sideways-scrolling bar on phones
- Seed: runs the reminder sweep after loading the demo.

**Verified (commands actually run)**
- `npm run typecheck` clean; `npm run web:build` succeeds.
- `npm test`: **154 tests passed** (6 new). They cover:
  - stage-by-stage approver notices and the requester's outcome
  - no repeat notice for someone who already signed; waiting notices close once signed
  - delegate notified; assignment notifies the technician, not the assigner; muted kinds skipped
  - users can clear only their own
  - the reminder sweep is idempotent
  - one digest per user per day, with opt-out respected and failed sends retried
- UI smoke against a freshly seeded server: **57/57 checks passed**. The smoke test navigates through the grouped menus. Writing it caught and fixed the bug where "waiting" notices stayed unread after the request was signed.
- `scripts/run-reminders.ts` against the demo data wrote 10 digest files; the content was reviewed.

**Not done:**
- a hosted email provider (D-045)
- push or SMS
- action items as a shared service (MOC has its own actions)
- per-facility quiet hours

## 2026-10-21: S6b Time capture, approval and payroll-ready export

**Decisions taken to keep moving** (D-042 to D-044):
- Weekly timesheets with two-person approval.
- Overtime flagged, not calculated (Category 2).
- Generic payroll CSV until the pilot's payroll provider is known.

**Built**
- Migration `0010`:
  - earning codes (defaults per tenant), timesheets, time entries, payroll exports
  - a trigger that freezes entries of approved or exported weeks
  - RLS and grants; payroll administrator role; `time.approve`, `time.view_all`, `time.export`
- `time` module:
  - open or create a week (own, or on someone's behalf by an approver)
  - live work-order hours in drafts; manual entries with earning codes
  - submit (copies and locks work-order hours); approve, or send back with a note
  - second approver required when keyed on someone's behalf; reopen before export
  - overtime and long-day warnings; team week view
  - payroll preview (ready / exported / not ready) and export (summary or daily) with code mapping
- Work-order labor is refused for a week that is submitted, approved or exported.
- Report **Time and labor**: completion, waiting, worked and leave hours, wrench time (technicians), overtime-review weeks.
- Web:
  - Time page: my week with a day grid, entries, add time and submit; team view by week; timesheet review with approve, send back or reopen; payroll export with preview, files and earning-code mapping.
  - API client gained DELETE.
- Seed:
  - Lena (payroll).
  - Two weeks of routine work orders with labor for three technicians.
  - Two past weeks of timesheets: one fully approved and exported; one mixed (approved, waiting, sent back, not started).
  - A draft for the current week.

**Verified (commands actually run)**
- `npm run typecheck` clean; `npm run web:build` succeeds.
- `npm test`: **148 tests passed** (9 new time tests). They cover:
  - week boundaries; live work-order hours; date and code validation; who can see a sheet
  - submission locks work-order labor; send-back needs a note; approved entries are frozen at the database
  - reopen; on-behalf entry needs a second approver; overtime flag; team view
  - payroll preview and export content with mapped codes; exported weeks can't be reopened or exported twice
  - the time and labor report figures
- Seeded report: 64% of timesheets approved for the last 2 weeks, 1 waiting; wrench time 44% (88 of 198 h); 2 weeks flagged for overtime review.
- UI smoke against a freshly seeded server: **54/54 checks passed**. It caught and fixed:
  - the team view double-counted work-order hours on a week that had been sent back (regression test added)
  - the payroll file list did not show file names

**Not done:**
- payroll-provider formats or APIs (D-016)
- scheduling and availability
- PTO balances and accruals (Category 2)
- clock in/out
- a time tile on the home page

## 2026-10-21: S6a Accounts payable and the integration framework

**Decisions taken to keep moving** (D-038 to D-041):
- The accounting connector itself waits on the pilot's system (D-016). I built everything that does not depend on that choice instead of guessing a provider.
- Invoice approval uses two-person separation.
- Accounting owns payments once connected.
- Mocks exist only as labeled MOCK connections.

**Built**
- Migration `0009`:
  - supplier invoices and lines (duplicate-number guard), account mapping
  - integration connections (one active per tenant), outbox (append-only), delivery queue, export files
  - MOCK accounting records
  - RLS and grants; AP clerk role; `ap.view` / `ap.manage` / `integrations.manage` permissions
- `ap` module:
  - capture (from an order's received-not-invoiced quantities, or by hand) with the scanned file
  - due dates from payment terms
  - basic match against order and receipts
  - approval by a second person, with a reason required for mismatches
  - dispute, void (sends a void to accounting if already exported), due-date override
  - manual payment only in file-export mode
- Platform outbox (`emit()` with idempotency keys) and adapter interface.
- `integrations` module:
  - connections with optional backfill
  - sync runner (claim with SKIP LOCKED, deliver, record, backoff 1/5/30/120/720 minutes, dead after 6 tries, payments pulled back)
  - retry and resolve-by-hand
  - export-file download, account mapping
  - MOCK controls (pay a bill "in accounting", simulate an outage)
- Adapters:
  - generic AP CSV export
  - MOCK accounting: vendor find-or-create via the external-ID crosswalk, idempotent bill creation, voids, payments
- `scripts/run-sync.ts` for scheduling.
- Report **Accounts payable aging**.
- Web:
  - Payables page: KPIs, list, capture form pre-filled from the order with file upload, invoice detail with match warnings, approval, payment, dispute/void and accounting status.
  - Accounting page: connect, MOCK banner, sync queue with retry/resolve, export files, a view inside the MOCK system, chart-of-accounts mapping.
  - "Capture invoice" and the invoice list on purchase orders.
- Seed:
  - Ana (AP clerk).
  - Four invoices: one paid through the MOCK system, one 20 days overdue, one billed before delivery waiting for approval, one disputed.
  - The account mapping, and the MOCK connection with one payment returned.

**Verified (commands actually run)**
- `npm run typecheck` clean; `npm run web:build` succeeds.
- `npm test`: **139 tests passed** (12 new AP/integration tests plus an HTTP flow). The tests cover:
  - payment-terms parsing; capture from an order with accounts by line and the file
  - duplicate numbers refused (case-insensitive); mismatch rules; capturer cannot approve
  - exactly-once outbox emission; outbox immutability
  - unmapped account → failure → fix → backoff respected → delivery
  - a delivered-but-unrecorded retry does not duplicate
  - outage → dead after 6 tries → shown in aging KPIs → manual retry succeeds
  - payments from accounting; manual payment refused with an API connection
  - void propagates to accounting; paid invoices cannot be voided
  - file export CSV content with account codes; manual payment in file mode
  - tenant isolation
- Seeded AP aging: $4,793 open, $645 overdue (the hose repair, 20 days), 1 waiting for approval, 1 disputed.
- UI smoke against a freshly seeded server: **46/46 checks passed**. It caught and fixed:
  - the accounting page did not refresh its queue and MOCK bill list after "Sync now"
  - the admin menu overflowed off-screen on desktop (it now wraps)
  - the approvals badge stayed stale after a decision (it now refreshes on navigation)

**Not done:**
- QuickBooks Online / Xero connector (D-016)
- time capture and payroll-ready export (S6b)
- early-payment discounts
- credit memos
- recurring bills
- grouping the growing admin menu into sections

## 2026-10-21: S5 Purchasing (on the shared approval engine)

**Decisions taken to keep moving** (D-034 to D-037, all reversible):
- Approval routing is tenant data, with starter rules:
  - budget owner for every amount
  - plant manager from $2,500
  - finance from $10,000 and for all capital requests
- Any change after submission needs re-approval.
- Buyers may order up to 10% above the approved total.
- Delegation is dated and recorded on each signature.
- Purchase orders are printed, not transmitted. Invoices stay in accounting.

**Built**
- Migration `0008`:
  - suppliers and supplier prices (one preferred per part)
  - purchase approval rules
  - purchase requests and lines
  - purchase orders and lines, append-only receipts
  - approval delegation, plus `on_behalf_of` on approval steps
  - RLS and grants, new roles (buyer, finance approver), `purchasing.*` permissions, default rules for existing tenants
- Approval engine: delegation (decide, queue, history). Separation-of-duties checks cover both the delegate and the delegator.
- `purchasing` module:
  - supplier and price management
  - requests: draft, submit with a computed route, material change → superseded, cancel
  - approval callback
  - orders split by supplier with the price tolerance; cancel frees the request lines
  - receiving through the stock ledger at the order price (storeroom required for parts stocked at the site, over-receipt refused)
  - request from a work order's uncovered parts, and from the reorder report
  - printable PO PDF
- Parts-to-reorder now uses the stock position (on hand + on order + requested), with "on order" and "requested" columns.
- Work orders show their purchases.
- New report **Purchasing status**: awaiting approval and who it waits on, approved not ordered, open and late orders, committed spend, supplier on-time delivery.
- Imports:
  - `suppliers` and `supplier_prices` targets.
  - Samples `07_accounting_vendor_list.csv` (Tax ID column deliberately ignored by its profile, malformed email, inactive vendor) and `08_supplier_price_list.xlsx` (quote workbook with banner rows, text lead times, and supplier/our part-number headers that read backwards). Both have profiles.
  - A real gap found and fixed: "Item" was not recognized as our part number.
- Web:
  - Purchasing page: requests, orders and suppliers tabs; new request with line editor; request detail with route preview, edit (with a re-approval warning), submit, cancel, order placement with price check, sign-off history with on-behalf-of.
  - Purchase order detail with PDF, receiving per line into storerooms, receipts, cancel.
  - Supplier detail with prices.
  - Approvals inbox shows purchase requests (amount, spend type, requester) and a delegation panel.
  - Work order shows purchases and "Request parts not in stock".
- Seed:
  - Kim (buyer) and Morgan (finance). Alex also covers Fort Wayne.
  - Vendor and price-list imports.
  - A replenishment request from the reorder report, approved and ordered, with the Koval order received.
  - An OEM encoder for the on-hold PRS-01 work order, signed in two stages and now a late order.
  - A capital spindle request waiting on finance.
  - A draft.

**Verified (commands actually run)**
- `npm run typecheck` (API + web) clean; `npm run web:build` succeeds.
- `npm test`: **126 tests passed** (12 purchasing tests, a sample-file import check, an HTTP purchasing flow). The tests cover:
  - routing by amount and spend type, no self-approval, distinct signers, staged order, rejection needs a comment
  - re-approval after change
  - delegation (recorded, not usable for the delegator's own request, ends when revoked)
  - price tolerance, split by supplier, cancel frees lines
  - receipts posting to the ledger with average cost, over-receipt and storeroom rules, receipt immutability
  - work-order shortage requests without duplicates
  - reorder position and drafting a request from it
  - status report; vendor and price-list imports with idempotency
- `npm run seed` completes. Purchasing status on seeded data: 1 late order (the PRS-01 encoder), 1 request awaiting finance, on-time delivery 100% (1 of 1).
- UI smoke: **38/38 checks passed** (10 new: requester, finance, buyer ordering and receiving). It caught a real bug, fixed before commit: "Create purchase order" had no click handler. Screenshots reviewed.

**Not done:** department-based routing, escalation reminders, blanket/standing orders, returns to supplier, supplier portal or email/EDI sending, invoice matching (S6 accounting adapter).

## 2026-10-21: S4 Preventive maintenance + inventory essentials

**Decisions taken to keep moving** (D-029 to D-033, all reversible):
- Stock is an append-only ledger and negative stock is refused.
- A stocked part must be issued from a named storeroom.
- PM plans advance on verification.
- One open work order per plan.
- No reservations or kits until D-017 is answered.

**Built**
- Migration `0007`:
  - storerooms, stock balances, the stock ledger (immutability trigger), cycle counts
  - meter readings, PM plans and their parts lists
  - `work_order.pm_plan_id` with a one-open-work-order-per-plan index
  - RLS, grants, and `inventory.view` / `inventory.manage` permissions
- `inventory` module: receipts with moving-average cost, issues, returns, transfers, adjustments with a reason, reorder settings, cycle counts with a stale-snapshot guard, ledger queries.
- Maintenance changes:
  - Using a stocked part requires its storeroom and posts an issue.
  - Unused parts can be returned.
  - Verifying a PM work order advances its plan.
- `pm` module: calendar/meter plans, completion vs fixed schedules, lead windows, a schedule with parts availability, idempotent work-order generation (planned parts plus the current approved procedure), and meter readings that cannot go backwards.
- Import target `stock_balances`: sets on-hand by posting the difference. Re-imports are no-ops.
- Reports:
  - **Preventive maintenance compliance**: on time / late / open past due, plans due and overdue now, parts shortages.
  - **Parts to reorder**: at/below reorder point or short for PM demand in the next N days, with a suggested quantity and estimated cost.
- Web:
  - PM page: schedule, generate, new plan with parts list, plan detail with history and pause/resume.
  - Storerooms page: stock with low-stock filter, per-part ledger, adjust, reorder settings, receiving, cycle counts with the moved-stock confirmation.
  - Work order: storeroom choice when recording parts, and returns.
  - Asset page: PM plans and meter reading entry.
- Seed:
  - Dayton and Fort Wayne storerooms.
  - The storeroom export imported a second time as opening stock (new profile `storeroom-stock.json`). The rejected compressor-oil row is then added by hand with a quoted price.
  - Reorder points.
  - Six PM plans. CNC-101's monthly plan has three cycles of history (on time, late, on time). CMP-01 has a 2000-hour meter plan with readings.
  - Generated PM work orders.

**Verified (commands actually run)**
- `npm run typecheck` (API + web) clean; `npm run web:build` succeeds.
- `npm test`: **113 tests passed**. 13 are new: ledger math and average cost, negative stock refused, append-only at both layers, transfers and facility scope, work-order issue/return and the storeroom rule, counts with the moved-stock guard, opening-stock import idempotency, due states and next-due rules, generation without duplicates, plan advance on verification, both reports, and an HTTP test of the new endpoints.
- `npm run seed` completes. Results:
  - PM compliance on the seeded data reads **50.0% (2 of 4 on time; HMC-201 quarterly overdue)**.
  - Parts to reorder lists 4 parts. Compressor oil is short for the upcoming 2000-hour service.
- UI smoke: **28/28 checks passed** (13 new), with no page or console errors. Screenshots and both report PDFs reviewed visually. Fixed after review:
  - Storeroom KPI tiles counted only filtered rows.
  - Part numbers wrapped mid-number.
  - Report meter wording.

**Not done:** PM calendar view; stock reservations and kits (D-017); lot/serial tracking; meter replacement/reset; scheduled (nightly) PM generation, which waits on the job queue; purchase orders (S5).

## 2026-10-21: S3 web app, first increment

**Decisions taken to keep moving** (founder had not answered; both reversible):
- React + Vite (D-011).
- A clearly labeled development sign-in that takes a demo API token until an identity provider is chosen (D-008 stays open).

**Built**
- `web/`: app shell with permission-aware navigation and an approvals badge.
- Screens:
  - Home: my work orders, my sign-offs, my training, KPI tiles.
  - Assets: search, detail with open-change warning, documents, components, state buttons, problem report form; QR route `/a/:token`.
  - Work orders: list filters; detail with start, labor, parts, complete, verify, close and assign. Server qualification errors are shown inline.
  - Approvals inbox: approve, or reject with a comment.
  - Changes: list, request form, screening questionnaire, sign-off history, action plan with completion and work-order linking, pre-startup review checklist, close.
  - Training: my training, my qualifications with certificate PDFs, team records, enrollment detail with self-completion, trainer and evaluator sign-off, and quiz taking.
  - Reports: list, native rendering of every report with facility filter, CSV/PDF export.
  - Data import wizard: choose file, match columns with confidence, translate code values, dry run with problems file, partial import, save the mapping as a profile.
- API additions: `GET /api/work-orders?assigned=me`; the API server serves the built app with client-route fallback.
- `scripts/ui-smoke.ts` (Playwright) and `npm run ui:smoke`. CI now also builds the web app.

**Verified (commands actually run)**
- `npm run typecheck` (API + web) clean; `npm run web:build` succeeds (235 kB JS, 73 kB gzipped).
- `npm test`: 100 backend tests passed.
- UI smoke against a freshly seeded server: **15/15 checks passed**, no page or console errors, no horizontal scroll at 390 px. Screenshots reviewed visually.
- **Bugs found and fixed:** stale data briefly rendered on tab switches (crashed the qualifications tab); rebuilt asset files served as HTML; and the value-translation step listed values the server already recognizes.


## 2026-10-21: S2b Management of change (scope change SC-001)

**Scope:** MOC was not in the original brief. The founder asked to add it, and the §12.9 gate analysis is in `docs/scope-changes/SC-001-management-of-change.md` (proposed: core MOC Category 1, PSM-grade packs Category 2).

**Built**
- Migration `0006`: shared approval engine tables, MOC tables, RLS, new stock roles (operations manager, EHS reviewer, quality reviewer), MOC permissions.
- `platform/approvals`: staged, role-addressed approvals with no self-approval, distinct signers, final decisions, supersede on material change, approver queue.
- `moc` module: create/revise (material change → re-approval), versioned screening rules, generated action plan, verified action completion, PSSR checklist and startup sign-off, temporary-change controls, close and cancel. Asset detail shows open changes.
- Report: Management of change register.
- Seed: four changes in different stages (high-risk change mid-implementation, temporary change in service and ending soon, chemical change waiting on EHS, draft at Fort Wayne) and three reviewer users.

**Verified (commands actually run)**
- `npm run typecheck` clean. `npm test`: **100 tests passed** (9 MOC tests, an HTTP MOC test).
- Seeded the dev database, ran the server, checked the EHS reviewer's approval queue and the register report (JSON and PDF, reviewed visually).


## 2026-10-21: S2 LMS → qualification → equipment gating

**Built**
- Migration `0004`: courses, versions (frozen once published), learning events of six kinds, assessments, enrollments, append-only completions/attempts/evidence, qualifications, grants (never deleted; revocation recorded), certificates, external credentials, asset qualification requirements, training reviews, RLS and new role permissions. Migration `0005`: staged import rows can come from one source column (unpivot).
- `learning` module: catalog and publishing, assignment (individuals, job title, facility), completion rules per event kind, assessment delivery and deterministic grading, evidence upload/download, eligibility, grant/revoke, certificates (PDF), training reviews raised by document revisions.
- Maintenance now enforces `maintain` qualifications on assignment, start of work and labor entry.
- Imports: generic `unpivot` option and a `qualification_records` target. New sample `06_training_matrix.xlsx` with saved profile.
- Reports: Qualification status & expiries (with single-person coverage risk), Training compliance.
- Seed: 5 qualifications, the training matrix import, a 6-event spindle course and a LOTO refresher. One technician is taken through to a granted, certified qualification and one is part-way. HMC-201 requires the spindle and LOTO qualifications. A revised troubleshooting guide leaves an open training review.

**Verified (commands actually run)**
- `npm run typecheck` clean. `npm test`: **90 tests passed** (13 new LMS tests, a training-matrix import test, an HTTP test for the learning endpoints).
- Brief §13.4 LMS acceptance tests are now covered: mixed event types each recorded; assessment delivered, graded, attempt history and limit; evaluator sign-off required; completion alone grants nothing; authorized grant and revoke; validity checked before restricted assignment; revision flags training without overwriting history.
- Confirmed with `psql` as the table owner that triggers block editing training records and editing or deleting grants.
- Seeded the dev database, ran the server, and fetched both new reports and a certificate PDF. Reviewed the rendered PDFs visually.


## 2026-10-21: S0 foundation + S1 first vertical slice

**Repository audit (before work):** the repository contained only `README.md` (`# erp`) and one commit. There was no existing code, stack, auth, integrations, migrations or tests, so the build is greenfield (D-001).

**Built**
- Migrations `0001` (tenancy, identity, RBAC, entitlements, audit chain, RLS), `0002` (documents, assets, locations, state log, parts, maintenance), `0003` (import profiles, batches, rows, external-ID crosswalk).
- Platform: tenant-scoped transactions, permission model + role templates, hashed API tokens, audit append and verify, blob storage interface (local adapter), tenant provisioning.
- Modules and HTTP API: org/employees, assets (incl. utilization), documents, maintenance, parts, imports, reporting.
- Import framework: CSV/XLSX/JSON parsers, auto-mapping, declarative mapping profiles, coercion (numbers, dates with per-column order inference, facility-time-zone timestamps), 5 targets, staging/dry-run, commit with savepoints, problems CSV, re-import idempotency.
- Reports: maintenance backlog and asset availability/utilization, rendered as JSON, CSV, print HTML and PDF.
- Sample data: generator for 5 messy Ridgeline files + 1 Northgate file, 4 saved mapping profiles, demo documents. The seed loads everything through the import pipeline, then creates documents, 30 days of state history and work orders in every lifecycle state.
- CI workflow (GitHub Actions with a PostgreSQL 16 service).

**Verified (commands actually run)**
- `npm run typecheck`: clean.
- `npm test`: **75 tests passed** across 5 files:
  - unit: utilization math, coercion, transforms, auto-mapping, parsers, CSV safety
  - security: tenant isolation incl. document download, cross-tenant writes, no-scope connections, audit immutability, facility scoping, consolidated access, read-only roles
  - maintenance: document approval/visibility/revision/immutability; full corrective work-order lifecycle with costs, separation of duties and return to service; pinned procedure versions
  - imports: dry run, partial commit, idempotent re-import, explicit mappings, Excel banners, hierarchies, duplicate/overlap detection, problems file, permissions, all bundled samples
  - API + reports: auth, scoping, error mapping, document upload/download, HTTP import flow, report consistency across formats, export permissions, empty-scope messaging
- `npm run seed` against the dev database completed. All sample imports produced the expected created/rejected counts (one intentionally bad parts row and one work order for a no-longer-registered machine are rejected with reasons).
- Started the server and exercised the asset, document search, import-suggest and report endpoints with curl. Rendered both PDFs to images and reviewed them visually (fixed header wrapping, unsupported glyphs, and blank pages from the footer).

**Brief §13.4 acceptance tests: status**

| Acceptance test | Status |
|---|---|
| Tenant A cannot read/write Tenant B data, incl. document downloads and background operations | ✅ tested |
| Facility-restricted user cannot access other facility; corporate user sees consolidated | ✅ tested |
| Asset has controlled searchable documents; users see only authorized approved versions from asset/work-order views | ✅ tested |
| Corrective WO links asset, technician, parts/labor, procedure, state changes, immutable audit | ✅ tested |
| LMS mixed learning events, assessments, qualification gating, revision → training review | ✅ tested in S2 (see entry above) |
| Reporting (a) consistent metrics across formats, (b) facility-restricted exports, (f) empty data messaging | ✅ tested. (c) print without clipping / (d) units + sources checked visually. (e) drill-down path provided, UI pending |

**Not done / known gaps:** web UI; production identity provider; S3 storage adapter; async jobs for very large imports; XLSX export; PM scheduling; inventory (LMS followed in S2). See ROADMAP and ARCHITECTURE §9.
