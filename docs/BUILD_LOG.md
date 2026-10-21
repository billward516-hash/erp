# Build log

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
