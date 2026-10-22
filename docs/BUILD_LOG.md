# Build log

## 2026-10-22: S3b Offline-capable technician app

Technicians can keep working without a connection (D-121).

**Built**
- **Idempotency keys** on every authenticated write (migration `0030`, `platform/http/idempotency.ts`): the first 2xx response is stored and replayed; a reused key for another request is refused; errors are not stored; purged after 7 days.
- **Client offline module:**
  - saved copies of my work orders and opened work orders
  - an outbox for labor, parts used and status changes, sent in order with idempotency keys when the connection returns
  - refusals kept with their reason (`/outbox` page: try again or discard)
  - an offline bar; a pending list and optimistic status on the work order
  - sign-out warns about unsent changes and clears device copies
- **Installable app:** manifest, icon and a service worker that keeps the app shell (network first for pages, cache first for assets).

**Verified**
- 2 new API tests: replay returns the first response and posts once; keys are per user; a reused key is refused; failures are not stored; keyless requests are untouched.
- UI smoke: offline labor waits in the outbox, the offline bar shows, and on reconnect it is sent and appears exactly once.
- 300 tests, web build, fresh seed, 212 UI smoke checks.

## 2026-10-22: S3c Controlled document viewer

Documents now open in the browser instead of downloading (D-120).

**Built**
- **Viewer page** `/documents/:id`:
  - shows PDF (browser viewer), images and text; other formats download
  - the revision in force by default; banners for superseded and draft revisions
  - a revisions list for people allowed to see them
  - a controlled-copy notice, and a print stamp "UNCONTROLLED WHEN PRINTED" with the revision and date
- **Links:** "Open" on asset pages, work orders (the pinned revision), training and the shop floor now go to the viewer.
- **API helper:** `api.blob` loads protected files for in-page viewing.

**Verified**
- 209 UI smoke checks: a technician opens a troubleshooting guide in the viewer and does not see superseded revisions.

## 2026-10-22: S13a Supplier performance and corrective action requests

Advanced supplier quality (brief Category 2), built on records already kept.

**Decisions** (D-117 to D-119):
- **Scorecards:** on-time delivery, rejected ppm, price against quote and invoice, and corrective action requests; the rating is the worst of them.
- **Corrective action requests:** a corrective action addressed to the supplier, emailed, answered by staff entry, chased when late.
- **History:** delivery history imported from the previous system counts in the scorecards.

**Built**
- **Migration `0029`:** supplier fields on corrective actions; `supplier_delivery_history`.
- **Service:** scorecards, `issueScar`, `recordSupplierResponse`.
- **Reminders and report:** `reminder.scar_overdue`; report `supplier-performance`.
- **Import target `supplier_deliveries`:** profile `vendor-delivery.json` for an old ERP's vendor delivery report.
- **UI:**
  - Purchasing → Supplier performance tab
  - supplier page: scorecard and request form
  - corrective action page: supplier section with the answer
  - nonconformance page: link to the supplier

**Seed (Ridgeline)**
- 86 lines of vendor delivery history across three suppliers.
- A corrective action request to Ridgeway for the seal kits held at receiving.
- Result: Ridgeway poor (57% on time, 65% rejected), Great Lakes watch, Koval good.

**Fixed while building**
- **ppm denominator:** lots held at receiving were left out of the denominator, which produced impossible ppm figures. Rejected ppm now divides by received + rejected at receiving.

**Verified**
- 3 new tests: scorecard measures (hand-built orders and receipts), the request through reminder and answer, and the history import.
- 298 tests, web build, fresh seed, 207 UI smoke checks.

## 2026-10-22: S12b Attribute control charts

SPC now covers shops that count rather than measure: leak-test failures, paint defects, missing labels.

**Decision** (D-116):
- **Charts:** p, np, c and u, with binomial or Poisson limits; per-sample limits for p and u.
- **Rules:** three of them (beyond a limit, 9 in a row, 6 trending).
- **In place of capability:** the average rate (% defective and ppm, or defects per unit).

**Built**
- **Migration `0028`:** chart type, sample sizes; the immutability trigger covers the sample size.
- **Engine:** functions for attribute centers, points and rules.
- **Service:** attribute recording (whole counts, defective ≤ inspected, fixed or per-sample n), limits from a baseline, chart view with stepped limits, list rate.
- **Import:** `spc_measurements` takes a sample size.
- **Report:** a "Defect rate" column.
- **UI:**
  - setup by what is recorded
  - p, np, c and u page with stepped limits on the chart (`ControlChart` bands)
  - count and sample-size entry; samples table

**Seed (Ridgeline)**
- HSG-LEAK: leak test failures per lot (40–90 parts), about 1.9% defective, in control, limits from 25 lots.

**Verified**
- 4 new tests: engine tests for p, np, c and u (hand-computed) plus varying-limit rules, and a database test.
- 295 tests, web build, fresh seed, 203 UI smoke checks.

## 2026-10-22: S11d Consumables, chemicals and PM parts in the plan

The material plan now covers what the brief lists beyond BOM materials (§12.8): production consumables and chemicals, and maintenance parts from PM plans, with a cost forecast.

**Decisions** (D-114, D-115):
- **Consumption rates:** per machine hour, per unit made, or per month (site-wide allowed).
- **PM parts:** parts lists of calendar PM plans projected on their schedule.
- **Projection and cost:** both feed the purchased-material projection, costed as production consumption.

**Built**
- **Migration `0027`:** `consumption_rate`.
- **Engine:**
  - purchased materials netted after the load (per-hour usage follows machine hours)
  - units per work center
  - `consumption`, `maintenanceParts` and `consumablesCost` outputs; a source breakdown on each material
- **Service:** rate list and save (replace or remove); PM parts projected in `planInput`; unit costs.
- **Import target `consumption_rates`:** "quantity per N" and basis words; profile `consumables-usage.json` for a maintenance lead's usage sheet.
- **UI:**
  - Plan tab: "Consumables, chemicals and PM parts" section with monthly cost; "For" column on materials.
  - Consumables tab: manage rates.
- **Report:** consumables and PM parts cost insight.

**Seed (Ridgeline)**
- Coolant, inserts and wash detergent with opening stock, imported from a usage sheet in the plant's own wording.
- Result: $6,010 of consumables and $1,224 of PM parts over six months; coolant short from November.

**Verified**
- 2 new tests: an engine test (hand-computed) and a database test (rates, import with "1 per 120", plan).
- 291 tests, web build, fresh seed, 200 UI smoke checks.

## 2026-10-22: S11c Qualified labor in the plan

The plan now checks whether there are enough qualified people to run the load, not just enough machine hours (brief §12.8 "qualified workforce").

**Decision** (D-113):
- **Who counts:** a person counts for a work center when they hold every qualification its machines require to operate, valid in that month.
- **Hours:** demonstrated from approved timesheets, else 40 a week assumed.
- **Sharing:** shared people are allocated by maximum flow.
- **Setting:** operators per machine hour, per work center.

**Built**
- **Migration `0026`:** `work_center.labor_ratio`.
- **Engine:** `maxFlow`, `planLabor` (shortfall per work center and month, one-person warnings, qualifications lapsing in the horizon).
- **Service:** gathers requirements, holders and timesheet hours.
- **Report:** capacity-plan insights on operator shortfalls and single-person work centers.
- **UI:**
  - Planning page: a "Qualified operators" section and an operator-shortfall key figure.
  - Calendars tab: an operators-per-machine-hour field.
- **Header menu:** fits on one line on medium desktops (tighter spacing from 761 to 1439 px; wrapping remains the fallback).

**Seed (Ridgeline)**
- Three CNC operators; CNC-TURN required on the lathe, CNC-MILL on the machining centers; six weeks of approved timesheets (one operator works 48 h).
- Tolu's turning sign-off lapses on 21 November, which leaves the lathe with one qualified operator; it is then 2 h short in February and 10 h short in March.

**Verified**
- 4 new tests: max flow, shared people vs per-center sums (hand-computed), operators per machine hour, lapses, and a database test.
- 289 tests, web build, fresh seed, 198 UI smoke checks.

## 2026-10-22: Property licensing in bands of up to 100

The founder decided D-086 for property management: pricing is based on bands of up to 100 properties rather than per facility.

**What changed**
- **Rule (D-112):** active property sites ≤ bands × 100.
- **Defaults:** one band per tenant; provisioning takes `propertyBands`.
- **Enforcement:**
  - The 101st property (new, reactivated, or another site turned into a property) is refused, with a message saying how to make room.
  - Inactive properties free their place.
  - A database trigger enforces this for screens, imports and provisioning alike.
- **Visibility:** the Sites page shows "Properties licensed n of 100" (amber at 90%, red when full); also at `GET /api/licence`.
- **Not changed:** tenants cannot change their own licence. Stores and other site kinds are not counted (still open).

**Verified**
- 2 new tests: band fill, deactivation, reactivation, kind change, the trigger as a backstop, tenant cannot write the licence, and a second band.
- 285 tests, fresh seed, 196 UI smoke checks.

## 2026-10-22: S12a Statistical process control

SPC is in the approved Category 2 scope (brief §12.7, PRODUCT_SCOPE). It is built on records that already exist: parts and operations, machines, calibrated gauges, production orders, nonconformances and notifications.

**Decisions** (D-107 to D-111):
- **Charts and rules:** X̄–R and I–MR charts with four run rules.
- **Limits:** set from a baseline of at least 20 subgroups, kept as history; trial limits raise no signals.
- **Measurements:** append-only, refused when the gauge was out of calibration, flagged as suspect after an out-of-tolerance calibration.
- **Capability:** reported with its qualifications.
- **Signals:** answered by quality, optionally raising an NCR. No automatic holds.

**Built**
- **Migration `0024`:** characteristics, subgroups (append-only trigger), limits, signals; RLS by site.
- **`spc/engine.ts`:** limits, rules, capability.
- **`spc/service.ts`:** setup, recording with the gauge check and signals, limits, exclusion, answers with an NCR, chart and list views.
- **Import and report:** import target `spc_measurements` with value splitting; report `spc-summary` ("1 characteristic of 2 has open control-chart signals; lowest Cpk 1.16 (HSG-BORE)").
- **UI:** Quality → SPC list; characteristic page with X̄/R or I/MR charts, open signals and answers, recording, limit setting, the measurement table.
- **Seed (Ridgeline):**
  - **HSG-BORE:** the seal bore, measured with BG-250. A 25-subgroup study sets the limits, then the boring insert wears and signals open. This ties to the FMEA row "Bore oversize" and the audit finding on BG-250.
  - **HSG-FLAT:** sealing-face flatness imported from a CMM export with profile `cmm-results.json`.

**Verified**
- **Engine tests:** 10, against the published constants and hand-computed cases.
- **Database tests:** 8 (setup, immutability, trial vs set limits, signals, answers with NCR and exclusion, run of 9, gauge refusal and suspect flags, import and report).
- **Totals:** 283 tests, web build, fresh seed, 194 UI smoke checks (signal answered with an NCR, reading recorded).

## 2026-10-22: S11b Acting on the plan

The plan now leads to action, and capacity accounts for planned maintenance.

**Decisions** (D-105, D-106):
- **Drafts, not commitments:** the plan drafts a purchase request (normal approvals apply) and creates production orders in status `planned`. Only the plan as it stands, never a scenario.
- **PM off capacity:** calendar PM plans' estimated hours come off their machines' work-center capacity; meter-based plans and plans without hours are listed as assumptions.

**Built**
- **Engine:**
  - open production orders' unissued materials are dependent demand (this was a gap: open orders' materials were not counted)
  - open purchase requests reduce `toRequest`
  - `projectMaintenance` and a `maintenance` column per work-center month
- **Service:** `requestPlanShortages`, `createPlannedOrders`; `planInput` gathers allocations, requested quantities and PM plans.
- **Routes:** `POST /api/plan/purchase-request`, `POST /api/plan/production-orders`.
- **UI:** a "Requested" column and a button for the purchase request; "create order" per part and month; PM hours in the load grid.

**Verified**
- 5 new tests: engine (allocations, requests, PM projection) and database (request once, orders netted with materials kept, PM deducted).
- 265 tests, web build, fresh seed, UI smoke (plan actions).

## 2026-10-22: S11a Demand, capacity and material plan

The brief calls capacity and resource planning the flagship Category 2 capability (§12.8). This is its first slice, built on what is already recorded (routings, BOMs, stock, orders, machine state, production runs) rather than on typed-in rates.

**Decisions** (D-101 to D-104):
- **Forecasts:** versioned, reviewed and activated; firm orders consume forecast per customer and month.
- **Plan:** a pure, deterministic plan with stated assumptions.
- **Scenarios:** store adjustments only.
- **Later:** what the engine does not see yet is listed.

**Built**
- Migration `0023`:
  - work-center calendars (hours per week, machines or crews)
  - customer forecasts and lines (active versions frozen)
  - planning scenarios
  - `planning.view` / `planning.manage` on stock roles
- **`planning/engine.ts`:**
  - demand with forecast consumption
  - low-level-code netting, lot for lot
  - routing load with demonstrated or standard rates and yields
  - capacity from calendar, machines and demonstrated availability
  - purchased-material projection with need-by and order-by dates
  - bottleneck and assumptions
- **`planning/service.ts`:**
  - plan inputs for a site
  - forecast drafts, lines, activation, version view with the change and firm orders
  - calendars
  - scenarios
  - plan with scenario comparison
- **Imports:** `customer_forecasts` target with a month-header parser.
- **Report:** Capacity and material plan.
- **Web:** Planning page with plan, forecasts and calendars (load grid by work center and month, materials, planned production, assumptions, scenarios); forecast version page.
- **Seed (Ridgeline):**
  - a customer forecast spreadsheet (a column per month, generated with current months) imported for two customers and activated
  - calendars for the four work centers
  - a "Second shift on the lathe" scenario
  - The plan shows CNC-104's lathe going over capacity in late months and four purchased materials short.

**Found on the way**
- Forecast month headers (`2026-11`) were rejected by the date parser: customers write months, not dates. There is now a month parser for `Nov-26`, `Nov 2026`, `11/2026`, `2026-11-15` and similar.
- Load from seal kits made for housings was all labelled "forecast": the firm/forecast split now flows from parent to component.
- Manual work centers were listed as "no machine state history" assumptions; there is no machine to measure, so they are not.
- A shortage in the current month had a need-by date on the 1st (already past); it is now today.
- The report's "largest load there" summed the whole horizon while naming one month; reworded.

**Verified (commands actually run)**
- `npm run typecheck` clean; `npm run web:build` succeeds.
- `npm test`: **260 tests passed**. The 10 new tests cover:
  - **Engine** (7, hand-computed):
    - firm consuming forecast per customer; netting through two levels
    - lathe load with a demonstrated rate, firm/forecast split
    - mill with no calendar, seal kits with a demonstrated yield, the bottleneck
    - material shortfall with need-by, order-by and lateness
    - the exact assumptions list
    - a scenario with extra hours and forecast growth that leaves firm orders alone
    - past-due firm orders and demand beyond the horizon
    - the month-header parser
  - **Database** (3):
    - forecast versions (draft, activate, frozen, superseded)
    - a wide forecast imported into the draft with the change from the previous version and firm orders above it
    - the plan from real tables: demand, production, load, assumptions, materials
    - calendar permissions, scenario comparison, report headline
- UI smoke against a freshly seeded server: **186/186 checks passed**. The 7 new checks cover:
  - the plan: load grid, the lathe, materials, assumptions
  - the second-shift scenario compared with the plan as is
  - the forecast version page
  - the report headline naming the bottleneck

**Not done (D-104):**
- labor qualifications as a constraint
- PM and downtime calendars beyond demonstrated availability
- production lead-time offsets, safety stock, lot sizes
- finite scheduling and sequencing
- consumables and chemicals, shelf life
- cross-site supply
- creating purchase requests or production orders from the plan (a planner does that today)

## 2026-10-22: S10c Store operations (retail)

**Decisions** (D-097 to D-100):
- **Conditions:** condition logs separate from meters; one request per excursion; missed readings after 1.5 × the interval.
- **Site visits:** light checklists with scoring, repeats and follow-up.

**Built**
- Migration `0022`:
  - condition points, append-only readings, excursions (one open per point)
  - visit templates, visits and items (final once completed)
  - actions on visit items; request sources `condition` and `visit`
  - visit permissions; district manager role
  - the public-request constraint narrowed to public requests: as written in S10a it blocked any request without a requester name
- **`storeops` service:**
  - condition points, record reading (excursion and request), list with state, history
  - checklist templates, start visit, answer item, complete (score, requests or actions, notify the store), visit view with repeats, list
- **Imports:** `condition_points` and `condition_readings` targets.
- **Report:** Store standards and conditions.
- **Reminders:** daily missed-readings reminder.
- **Web:**
  - Conditions & visits page: conditions with quick logging, visits, checklists editor
  - visit page: answer, change, complete
  - condition log panel on the asset page (QR flow)
- **Seed:** a fourth tenant, **Northwind Market**:
  - five stores in two districts, 11 pieces of equipment, 8 temperature logs and 3 contractors, all imported
  - three days of the temperature form (generated with recent dates, imported): a warm produce cooler sent to refrigeration with a not-to-exceed, a freezer defrost excursion that closed, and an Express store that stopped logging
  - three store walks, one dropping from 92% to 75% with a critical miss

**Found on the way**
- The standards report counted expected readings over the whole 30 days even when logging began three days ago (every store showed ~10%). It now counts from when logging began.
- The checklist kept Pass/Fail controls on answered items, so it was unclear what was left. Answered items now collapse with a "change" link.
- A visit with a critical miss showed a green score; now red.

**Verified (commands actually run)**
- `npm run typecheck` clean; `npm run web:build` succeeds.
- `npm test`: **250 tests passed**. The 5 new tests cover:
  - limits by asset managers only
  - one excursion and one request for three warm readings; closing when back in range; readings immutable
  - temperature log import (valid, out-of-limit warning, unknown equipment rejected) in store-local time; missed-reading reminder to the store
  - visit permissions, fail needs a reason, all items answered, owner for non-maintenance fails; score with n/a excluded; equipment fail → request, other fail → action due next day for a critical item; completed visit final
  - repeat failure flagged on the next visit; standards report headline and row
- UI smoke against a freshly seeded server: **179/179 checks passed**. The 8 new checks cover:
  - the store manager sees only their store's logs; a warm reading raises a request
  - the district manager sees the open excursion and the missed logs
  - a 12-item store walk with a critical equipment failure scored 91.7% and raising a request
  - the store standards report

**Not done:**
- sensor feeds (D-008)
- food-safety discard rules
- photos on visit items
- recurring scheduled checklists (opening and closing)
- per-item weights

## 2026-10-22: S10b Leasing (landlords)

**Decisions** (D-092 to D-096):
- **Leases:** rental units on spaces; renters are customers. One lease in force per unit, with holdover until move-out.
- **Billing:** rent billed as ordinary invoices with day proration and account keys.
- **Not built:** late fees, deposits, owner statements and payment portals.
- **Unit turns:** made of work orders.

**Built**
- Migration `0021`:
  - rental units, leases (exclusion constraint), lease charges, lease billing, unit turns
  - invoice line account keys and the invoice's lease
  - renter party type
  - leasing permissions on stock roles (property managers also get receivables)
- `leasing` service:
  - units; lease create, activate, cancel, notice, move-out, renew; lease view with invoices and balance
  - rent roll
  - billing preview and run (issue or draft)
  - unit turns: list, add work, ready
- Receivables payload uses the line's account key (`rental_income`, `tenant_charges` added to the account catalog).
- **Imports:** `rental_units` and `leases` targets.
- **Report:** Rent roll and occupancy.
- **Reminders:** weekly leasing reminder (leases ending without renewal, late turns).
- **Web:**
  - Leasing page: rent roll with new-lease form, unit turns, rent billing with preview
  - lease page: notice, move-out, renewal, charges, invoices
- **Seed (Harborview):**
  - the unit directory loaded a second time as rental units (common areas rejected on purpose)
  - a 13-lease rent roll: a holdover, a notice, two company tenants
  - a move-out with a late turn: painting with a contractor, carpet still open
  - two months of rent billed and paid, except one renter on notice ($3,590 past due) and one this month

**Verified (commands actually run)**
- `npm run typecheck` clean; `npm run web:build` succeeds.
- `npm test`: **245 tests passed**. The 6 new tests cover:
  - renter created as a customer with a primary contact; a second lease on the same unit refused
  - proration of a mid-month move-in (rent and charges); one invoice per lease per month; `rental_income` and `tenant_charges` in the accounting payload; due date the 1st
  - rent roll occupancy, vacancy, past due after grace; payment clears it; report headline
  - notice, a future move-out refused, the turn with work, ready refused while work is open
  - occupied on move-out day, vacant the day after; ended lease not billed again
  - renewal the day after with charges carried and no turn
  - rent roll and unit imports, with holdover detection and an unchanged re-run
- UI smoke against a freshly seeded server: **171/171 checks passed**. The 10 new checks cover:
  - holdover and past due on the rent roll
  - a new lease signed on a vacant unit
  - the late turn with its jobs
  - next month's rent run
  - a renewal
  - the rent roll report

**Not done:**
- late fees and scheduled rent increases
- deposit accounting and refunds
- move-in and move-out inspections with photos
- a renter portal and online payment
- owner statements
- commercial CAM reconciliation

## 2026-10-22: S10a Sites, portfolios and contractors (landlords and retail)

The question was whether the software works for landlords with many properties, and for retail operations. **Answer** (docs/FIT_PROPERTY_RETAIL.md): the maintenance and compliance side fits both, once four gaps are closed.
- **The gaps:**
  - properties are costly to set up and to price
  - units are not assets
  - work goes to contractors
  - there is no rent or leasing
- **Scope limits:**
  - POS, merchandising and replenishment are not built; they belong to the retailer's systems
  - owner statements, screening and listings are not built
- **This slice:** closes the shared gaps. Leasing (S10b) and store operations (S10c) follow.

**Decisions** (D-085 to D-091):
- Site kinds.
- Licensing per kind is an **open founder question** (D-086).
- Groups with expanded grants.
- Spaces as assets.
- Contractors with insurance and not-to-exceed.
- Wall-clock service levels.
- Request links without sign-in and a request inbox.

**Built**
- Migration `0020`:
  - facility kind, address and active flag
  - facility groups and group grants; `user_role_scope` view
  - asset class `space`
  - contractor fields on suppliers and work orders; invoices tied to work orders
  - service levels with defaults
  - public request links with a resolver function
  - request source, requester and decision fields
  - property and store manager roles
- **`sites` module:**
  - sites (list, create, edit) and groups
  - user grants on a site or a group
  - request links (create, list, revoke)
  - public form and intake (throttled)
- **`maintenance`:**
  - request inbox and decline
  - `vendors.ts`: dispatch, vendor updates, contractor details, service levels, `slaOf`
  - contractor completion replaces labor entries
  - service-level state on work orders and lists
- **Payables:** invoices tied to a work order, with the not-to-exceed in the match check (the work order authorises the lines, so they are not flagged as off-order).
- **Imports:**
  - new `sites` target
  - asset import understands property and store columns and space words
  - supplier import takes trades and certificate dates
- **Report:** Service levels by site and contractor.
- **Web:**
  - Sites page: list, add and edit, groups, request links
  - public request page at `/r/:token`
  - Requests tab on Work orders
  - contractor panel and service-level pills on work orders
  - contractor details on suppliers
- **Seed:** a third tenant, **Harborview Property Group**:
  - four properties in two portfolios, 19 units and common areas, 9 pieces of building equipment and 6 contractors, all imported from property-management style exports
  - two property managers with portfolio grants and a finance approver
  - resident requests through lobby links
  - a dispatched leak, a garage door past its response target
  - an HVAC job invoiced $120 over its not-to-exceed and approved with a note

**Found on the way**
- **Matching:** invoice lines tied to a work order fell into the purchase-order price check ("above order price null"). Fixed.
- **Sample data:** the sample vendor list had a certificate that had already lapsed (08/15/2026, today is 2026-10-22). Dispatch correctly refused it; the sample now has a current date, and one vendor with no certificate shows the refusal.
- **Request links:** places on the public form are labelled by building (location) as well as parent space.

**Verified (commands actually run)**
- `npm run typecheck` clean; `npm run web:build` succeeds.
- `npm test`: **239 tests passed**. The 8 new tests cover:
  - a portfolio grant reaches only member sites (RLS, notifications); admin-only site creation and validation
  - the request link shows only its site's spaces, takes a request into the inbox and notifies managers; revoked and unknown links fail alike; a space at another site is refused; decline with a reason
  - dispatch refused without a certificate or with a lapsed one; email with the not-to-exceed
  - acceptance and contractor completion; verification by someone else
  - an invoice over the not-to-exceed needs a variance note; an invoice from another contractor is refused
  - service-level states; report by contractor
- UI smoke against a freshly seeded server: **161/161 checks passed**. The 11 new checks cover:
  - a resident request without sign-in
  - the portfolio-only site list
  - a missed response target
  - the request inbox with contact and entry permission
  - request → work order → dispatch with not-to-exceed (lapsed contractor disabled)
  - the service-level report, including the over-limit spend

**Not done:**
- leasing and rent (S10b), store readings and visits (S10c)
- business-hour service calendars
- a contractor portal (contractors reply by phone or email; staff record it)
- photos on public requests
- per-kind licensing (D-086)

## 2026-10-22: S9d Reliability analytics

**Decisions** (D-083, D-084):
- **Definitions:** a failure is a merged unplanned stop. MTBF and MTTR are measured over observed time, with coverage shown. When state history is thin, work orders give a labelled estimate. No failures means no MTBF.
- **Trends:** a trend is shown only between periods on the same basis, and flagged only with 3 or more failures. Repeat failures are the same code within 30 days.

**Built**
- `assets/reliability.ts`: pure `computeReliability` and `mergeStops`.
- `reliabilityInputs` loader; `assetReliability` (current window, previous window, 12 months); `GET /api/assets/:id/reliability`.
- Report **Equipment reliability (MTBF / MTTR)**: bad-actor headline, Pareto share, MTBF falls, repeat codes, longest repairs, data basis per asset.
- Asset page: reliability panel (30/90/365 days, comparison with the previous period, failure-code pills with repeats, 12 months).
- Seed: machine state history extended from 30 to 60 days. The first 30 days use different failure rates (HMC-201 getting worse, PRS-01 improving after hydraulic work), so trends have something to show.

**Found on the way**
- My first basis rule required 50% coverage. With 30 days of history, the 90-day report fell back to sparse work orders and showed fewer failures than the 30-day report. MTBF and MTTR are ratios over observed time, so the rule now needs one week of records and reports the coverage.

**Verified (commands actually run)**
- `npm run typecheck` clean; `npm run web:build` succeeds.
- `npm test`: **231 tests passed**. The 6 new tests cover:
  - stop merging and the MTBF/MTTR/availability arithmetic
  - observed-time basis on partial coverage
  - work-order fallback (cancelled orders and sub-minute repairs ignored); no data
  - repeats across the window start
  - no failures gives no MTBF
  - report headline, trend, repeats and exceptions on a worsening asset
  - the asset view matches the report; other-site users refused
- UI smoke against a freshly seeded server: **150/150 checks passed**. The 4 new checks cover the asset panel basis, the comparison with the previous period, the report headline, and coverage.

**Not done:**
- life-data analysis (Weibull), MTBF by failure mode, reliability targets per asset class
- linking stops to their work orders (stops and work orders are counted separately; the work-order failure code is the link)
- telemetry-fed state (D-008 still open)

## 2026-10-22: S9c Business continuity

**Decisions** (D-079 to D-082):
- Continuity plans reuse the FMEA pattern: revisions, plant-manager approval, frozen approved body, shared actions and attachments.
- Dependencies are typed references checked live; gaps are shown, never block approval.
- Only timed exercises can demonstrate the RTO; results are final; shortfalls need an action.
- The call list stays editable on the approved plan (audited); review without change is a recorded confirmation.

**Built**
- Migration `0019`:
  - continuity plans (revisions under one number, one open revision, owner ≠ alternate)
  - dependencies, scenarios and contacts, frozen by trigger once submitted (contacts editable while approved)
  - exercises, final once recorded
  - actions and attachments can belong to a plan (and actions to an exercise); `continuity.view` and `continuity.manage` on stock roles
- `continuity` module:
  - create, edit draft header, save body, save call list
  - submit → approval by the operations manager → approve/supersede or back to draft; revise; confirm review
  - schedule, record and cancel exercises
  - `assessPlan` (live gap checks, readiness); read; list; editor pick lists
- Report **Continuity readiness**; weekly reminder when a review or an unscheduled exercise is due.
- Approvals inbox now names and links any registered subject (FMEA approvals previously showed a bare type); "my actions" links to every subject type.
- Web: Continuity page (list, new plan) and plan page (gaps, dependencies with live status, scenarios, call list, exercises with results and evidence, actions, review and revision).
- Seed:
  - BCP-001, the approved critical plan for HSG-220 supply to Lakeshore, with five dependencies, three scenarios (one estimated over the RTO), a call list, a tabletop, a simulation that took 52 h against a 48 h RTO with an action, and a scheduled full test
  - BCP-002, a draft press-brake plan at Fort Wayne with no call list yet
  - Carlos (E1008), terminated in the payroll export, is recorded as rehired, so he is no longer an active supervisor linked to a terminated employee (found by the continuity people check)

**Verified (commands actually run)**
- `npm run typecheck` clean; `npm run web:build` succeeds.
- `npm test`: **225 tests passed**. The 6 new tests cover:
  - permissions; owner ≠ alternate
  - typed dependency validation; every live gap (machine out of service, one qualified holder of two, a person with no cover, a sole-source supplier, an estimate over the RTO, no call list); a second qualified holder clears the skills gap
  - call list required and validated; approval by the plant manager; frozen body (database); call list editable after approval
  - a timed result over the RTO cannot be "met"; findings required; results final; an unanswered finding is a gap until an action is linked; a full test within the RTO demonstrates it
  - revision carries body, contacts and open actions; supersede; exercise history across revisions; call-list edits blocked while a revision is open
  - review-due gap, reminders to owner and alternate, review confirmation, readiness report headline
- UI smoke against a freshly seeded server: **146/146 checks passed**. The 11 new checks cover:
  - the plan list and three live gaps
  - recording a full test within the RTO, and confirming the review
  - a draft refused without a call list, then sent for approval
  - the approval card naming the plan
  - the readiness report

**Not done:**
- business impact analysis across processes (RTO is entered, not derived)
- notifying the call list from the platform
- per-tenant choice of approver role (fixed to `operations_manager`)
- importing existing plans from documents

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
