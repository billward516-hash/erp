# Architecture

Status: **Phase 0 foundation + slices S1 (assets/documents/maintenance/onboarding/reporting) and S2 (LMS → qualifications → equipment gating) implemented** (see `BUILD_LOG.md`). Everything marked *future interface* is documented here so later slices fit without rework, but is deliberately **not built**.

## 1. Shape of the system

**Modular monolith**: one deployable TypeScript service and one PostgreSQL database. Modules own their tables and expose service functions. Nothing reaches into another module's tables except through those functions or documented read joins. Splitting out services is deferred until load or team size requires it (decision D-002).

```
src/
  platform/            cross-cutting services every module reuses
    db/                pool (runtime vs owner roles), tenant-scoped transactions, migrations
    auth/              permission catalogue, role templates, Actor, token auth
    audit/             append-only hash-chained audit events
    storage/           BlobStore interface (local dev adapter; S3-compatible next)
    tenancy/           tenant provisioning (control plane only)
    http/              validation + response helpers
  modules/
    org/               facilities, entitlements, employees (directory only)
    documents/         controlled documents, versions, approval, links
    assets/            asset registry, locations, state log, utilization math
    maintenance/       requests, work orders, labor, parts usage, procedures
    parts/             part master (stock/inventory arrives with Inventory slice)
    learning/          courses, learning events, assessments, enrollments, evidence, qualifications, certificates, training reviews
    imports/           customer-data onboarding: parsers, mapping, targets, staging
    reporting/         report definitions + renderers (JSON, CSV, HTML print, PDF)
db/migrations/         plain SQL, applied in order by src/platform/db/migrate.ts
```

| Choice | Selected | Why | Alternatives considered |
|---|---|---|---|
| Language/runtime | TypeScript on Node 22 | One language across API, import tooling and the future web UI; strong typing for a large domain model | Python/Django (strong admin, weaker shared UI types), Go (fast, slower domain iteration), extending Odoo/ERPNext (D-001) |
| HTTP | Fastify 5 | Fast, schema-friendly, small | Express, NestJS (heavier DI framework) |
| Database | PostgreSQL 16 | Relational integrity for transactions, **row-level security** for tenant isolation, exclusion constraints, JSONB for customer-specific fields, full-text search | MySQL (no RLS), per-tenant databases (ops cost at SMB price point) |
| Data access | Parameterized SQL through a thin helper; no ORM | RLS and transaction scope stay explicit and reviewable | Prisma/Drizzle (possible later; must not hide `set_config` scoping) |
| Validation | Zod at API boundaries and for mapping profiles | Same schema validates requests and saved import profiles | JSON Schema/Ajv |
| Tests | Vitest against a real PostgreSQL | Security properties (RLS, triggers) can only be proven against the real database | Mocked DB (would not test isolation) |

## 2. Tenancy and security model

**Hierarchy:** `tenant → legal_entity → facility → department`. One multi-tenant deployment with shared tables, and every row carries `tenant_id`.

**Enforcement is in the database, not only in the UI or services:**

1. The application connects as `erp_app`: not the table owner, `NOBYPASSRLS`.
2. Every request or job runs inside `withTx(scope, fn)` (`src/platform/db/tx.ts`). That function opens a transaction and sets transaction-local settings `app.tenant_id`, `app.facility_ids`, `app.all_facilities` and `app.user_id`. A pooled connection cannot leak scope to the next caller.
3. RLS policies on every table:
   - tenant-wide tables use `tenant_id = app_tenant_id()`
   - facility-scoped tables also require `app_can_see_facility(facility_id)`, where NULL facility means a tenant-wide record
   - child tables (document versions, work-order labor, import rows…) check that the parent row is visible, so facility scope cannot be bypassed through a child id.
4. A connection with no scope sees **zero rows**. Background jobs must call `withTx` with an explicit tenant (tested).
5. Services add **permission** checks (`requirePermission(actor, perm, facilityId)`) on top of RLS **visibility**. A user's grants are role bundles assigned per facility, or with `facility_id NULL` for corporate scope. Corporate users see consolidated data. Facility users see only their facilities.
6. Authentication runs before tenant context exists. A narrow `SECURITY DEFINER` function, `auth_resolve_token`, maps a token hash to a user and tenant. Tokens are stored only as SHA-256 hashes.

**Audit:** `audit_event` is append-only. The runtime role can INSERT and SELECT only, and triggers reject UPDATE, DELETE and TRUNCATE even for the owner. Events are **hash-chained per tenant**: each hash covers the previous hash and the event content, appends are serialized with an advisory lock, and timestamps are hashed as epoch microseconds so the chain does not depend on the session time zone. `GET /api/audit/verify` recomputes the chain. Every domain mutation writes its audit event in the same transaction as the change.

**Controlled documents:** released versions are immutable at the database level (trigger `document_version_guard`). Status can only move approved → superseded → obsolete. Non-privileged users only ever see the current approved version. Drafts and superseded history require `documents.view_draft`. Restricted documents require `documents.view_restricted`, and every download of one is audited. Safety-critical documents need an approver other than the author. Blob content is fetched only after the owning record passes RLS and permission checks. Cross-tenant download is tested.

**Sensitive HR data:** the employee table holds directory data only. Pay, assessment results and certification evidence go into separate tables with stricter permissions when Workforce/LMS slices land (D-010).

**Not yet implemented (tracked in ROADMAP):** production identity (OIDC/SAML SSO, MFA), S3 storage with SSE and signed URLs, rate limiting, encryption-at-rest configuration, backup/restore drills, data retention policies.

## 3. Domain model

### Implemented (this slice)

| Entity | Table(s) | Notes |
|---|---|---|
| Tenant, LegalEntity, Facility, Department | `tenant`, `legal_entity`, `facility`, `department` | Facility has IANA time zone (used to read customer timestamps) |
| Entitlement | `facility_entitlement` | Per facility + module, effective-dated; `hasModule()` helper |
| User, Role, assignment, token | `app_user`, `role`, `user_role_assignment`, `api_token` | Roles are tenant-editable permission bundles seeded from templates |
| Employee | `employee` | Directory only; linked to user optionally |
| Document, DocumentVersion, DocumentLink | `document`, `document_version`, `document_link` | One versioned source document is linked to assets, work orders and later courses. Links can pin a version |
| Functional location | `functional_location` | building / area / line / cell / storeroom hierarchy under a facility |
| Asset, AssetComponent | `asset` (`parent_asset_id`) | Components are assets with a parent in the same facility; cycle-checked |
| Asset state log | `asset_state_event` | Intervals; a GiST exclusion constraint forbids overlaps per asset |
| Downtime reasons | `downtime_reason` | planned / unplanned categories |
| Part | `part` | Master data plus a tenant-wide moving-average cost updated by receipts |
| StockLocation, InventoryBalance, InventoryTxn | `stock_location`, `inventory_balance`, `inventory_txn` | See §7. The ledger is append-only; the balance is a projection maintained in the same transaction |
| InventoryCount | `inventory_count`, `inventory_count_line` | Expected quantities snapshotted when the count opens |
| PM plan, meter readings | `pm_plan`, `pm_plan_part`, `asset_meter_reading` | Calendar or meter trigger; the parts list is a reference, actual use stays on work-order part lines |
| Supplier, SupplierPart | `supplier`, `supplier_part` | Price, lead time, supplier part number; at most one preferred supplier per part |
| PurchaseRequest (+lines), approval rules, delegation | `purchase_request`, `purchase_request_line`, `purchase_approval_rule`, `approval_delegation` | See §8 |
| SupplierInvoice (+lines) | `supplier_invoice`, `supplier_invoice_line` | One invoice number per supplier (unique, case-insensitive) unless voided; scanned file in blob storage |
| Timesheet, TimeEntry, EarningCode, PayrollExport | `timesheet`, `time_entry`, `earning_code`, `payroll_export` | One sheet per employee per Monday-start week; entries frozen by trigger once approved or exported |
| Customer, Contact, Opportunity, Activity | `customer`, `contact`, `opportunity`, `activity` | Tenant-wide (customers are shared across sites); one primary contact per customer |
| SalesItem, Quote (+lines, sent PDFs), SalesOrder (+lines), Shipment | `sales_item`, `quote`, `quote_line`, `quote_sent`, `sales_order`, `sales_order_line`, `shipment`, `shipment_line` | Quotes/orders belong to the selling facility; shipment lines are append-only and link to the stock-ledger movement |
| Notification, preferences, email queue | `notification`, `notification_preference`, `email_message` | Per-user; dedupe key per user stops repeats |
| Outbox, deliveries, connections | `outbox_event`, `sync_delivery`, `integration_connection`, `account_mapping`, `export_file` | See §9. `mock_accounting_record` is the MOCK provider's data |
| PurchaseOrder (+lines), receipts | `purchase_order`, `purchase_order_line`, `po_receipt` | Receipts are append-only and link to the stock-ledger row they created |
| MaintenanceRequest, WorkOrder (+assignment, labor, part lines, pinned procedures) | `maintenance_request`, `work_order*` | Reference (planned) vs actual consumption on each part line; substitutions recorded |
| AuditEvent | `audit_event` | See §2 |
| Course, CourseVersion, LearningEvent, Assessment | `course`, `course_version`, `learning_event`, `assessment` | Events reference the same controlled `document` used by assets. Published versions and their content are frozen by triggers |
| Enrollment, EventCompletion, AssessmentAttempt, TrainingEvidence | `enrollment`, `event_completion`, `assessment_attempt`, `training_evidence` | Append-only (runtime role has no UPDATE/DELETE; triggers block even the owner). Completion records the exact document version trained on |
| Qualification, EmployeeQualification, Certificate, ExternalCredential | `qualification`, `qualification_course`, `employee_qualification`, `certificate`, `external_credential` | Grants are never edited or deleted: revocation is recorded, renewal is a new row |
| Asset qualification requirement | `asset_qualification_requirement` | `operate` / `maintain` scope; enforced on work-order assignment, start of work and labor entry |
| TrainingReview | `training_review` | Opened when a document used by a published course is revised; a person decides |
| Import profile, batch, row, external reference | `import_*`, `external_ref` | See §4 |

### Future interfaces (designed, not built)

| Entity | Will attach to | Key rule already respected |
|---|---|---|
| PM kit, stock reservation | `pm_plan_part`, `inventory_balance` | Kits and reservations wait on D-017. The plan's parts list is already a reference list kept apart from consumption |
| ProductionOrder, EquipmentPerformance, CustomerForecast, CapacityScenario | `asset_state_event`, `asset.rated_capacity` | Utilization is already computed from recorded states, with nameplate kept separate from demonstrated capacity |
| FMEA, ContinuityPlan | `asset`, `document`, shared action items | No separate GRC platform |

## 4. Customer data onboarding (format flexibility)

Prospects arrive with spreadsheets, CMMS exports, payroll extracts and paper-derived logs, each formatted differently. The import framework turns those files into platform records **without custom code per customer**. Full user-level reference: `docs/DATA_ONBOARDING.md`.

```
file ──parse──► table ──map──► canonical values ──validate──► staged batch (dry run) ──commit──► domain services
 CSV/TSV/XLSX/JSON   columns+rows   saved/auto mapping     duplicates, references,      review, fix,            same rules, audit,
 delimiter/encoding  header row     transforms, value maps  facility access, overlaps   re-stage                external-ID crosswalk
 sniffing                          type coercion
```

- **Parsers** (`imports/parsers`): CSV with delimiter sniffing (`,` `;` tab `|`) and encoding detection (UTF-8, UTF-16 BOM, Windows-1252 fallback). XLSX (sheet choice, formula results, rich text, date cells). JSON (arrays or wrapped arrays; nested objects are flattened to `a.b` columns). Report banners above the header row are skipped automatically, and duplicate or blank headers are made unique.
- **Mapping spec** (`imports/mapping/spec.ts`): declarative JSON, never code. Per field it takes `source` (one column, or several with first non-blank winning), `template` (`"{Bldg} > {Line}"`) or `constant`, followed by transforms (`trim`, `upper`, `replace`, `regex_extract`, `split`, `multiply` for unit conversion, `default`, `null_if`…) and a `valueMap` (customer codes → platform values). Options cover unmapped columns (preserve in `custom_fields` or ignore), date order, decimal separator and upsert/create/update mode. Profiles are saved per tenant and versioned.
- **Auto-mapping** (`imports/mapping/suggest.ts`): normalizes headers (`Equip #` → `equipment number`, `S/N` → `serial number`, `Crit (A/B/C)`), scores them against each field's label and synonyms, and checks the sample values against the field type. A header match whose values don't fit is demoted and flagged. Every suggestion carries a confidence level, and unmatched enum values are listed for a decision.
- **Coercion** (`imports/mapping/coerce.ts`): handles currency, thousands separators, decimal commas, parentheses negatives, many date formats, Excel serials, and booleans/enums through synonym tables. **Date order is inferred per column.** One unambiguous value decides, and a fully ambiguous column produces an explicit warning naming the assumption. Zone-less timestamps are read in the **row's facility time zone**, found via its facility code or asset.
- **Targets** (`imports/targets`): employees, assets (locations are created from paths; parents can appear in any row order), parts, legacy work-order history, and downtime/state logs. Each target declares fields, synonyms, a natural key, batch validation and a commit function that **calls the same domain services as the API**. Permissions, facility checks, audit and business rules therefore apply equally to imported data.
- **Staging and commit**: staging writes nothing to operational tables. Commit re-evaluates the batch against current data inside one transaction. By default any error blocks the batch. With `allowPartial`, error rows are skipped and each good row is written under a savepoint. A problems CSV returns each failing row with its original values and the reasons, so the customer can fix their own file.
- **Idempotency**: `external_ref` maps `(source_system, entity_type, legacy_id)` to a platform id, so re-importing updates records instead of duplicating them. Legacy work-order history is never overwritten, and blank cells never erase existing data on update.

## 5. Learning and qualifications (S2)

Five states are recorded separately, and none implies the next:

| State | Recorded as | Who can create it |
|---|---|---|
| Training completed | `enrollment.status = completed`, once every learning event is satisfied | derived |
| Assessment passed | `assessment_attempt.passed` | the learner, by submitting answers; graded server-side |
| Competency verified | `event_completion` of a `practical_evaluation` with outcome `passed` and a written attestation | a user with `learning.evaluate`, never the learner |
| Qualification authorized | `employee_qualification` row | a user with `qualifications.grant`, never for themselves, and only when the training record is complete (`eligibility()`) |
| Certification issued | `certificate` row and PDF | a user with `qualifications.grant`, for the current active grant only |

- **Who records what:** the learner self-attests video and self-study. An instructor records classroom attendance and on-the-job shadowing. An evaluator signs practical evaluations. Assessments are graded deterministically; multi-select questions are all-or-nothing. The answer key never leaves the server for learners, either from the catalog or from results.
- **Equipment gating:** `assertAssetQualified()` runs on technician assignment, again when work starts (a grant may have lapsed or been revoked since), and on every labor entry. The error names the missing qualification and its state (not held, expired, revoked).
- **Document revisions:** approving a new version of a document that a published course teaches from opens a `training_review`. Past completions keep the document version they were trained on. A manager decides between "no retraining" and "assign retraining", which assigns a chosen published course version to everyone who completed the old one. Existing grants are not revoked automatically.
- **Privacy:** people always see their own records. Seeing anyone else's records, scores or evidence needs `learning.view_records` at that person's facility. RLS on all learner tables follows the employee's facility visibility. Evidence downloads are audited.
- **Boundaries kept:** internal workforce training only. No SCORM/xAPI, live video, proctoring or external accreditation. Video files are documents in object storage.

## 6. Approvals and management of change

**Approval engine** (`src/platform/approvals/engine.ts`): a request belongs to any subject (`subject_type`, `subject_id`, `subject_revision`, `purpose`) and is made of stages. Stages run in order and the steps inside a stage run in parallel. Each step is addressed to a **role** at the subject's facility (or a role held at corporate scope), so tenants decide who reviews by assigning roles.
- **Built-in controls:** the requester cannot approve; with `distinct_approvers`, one person signs at most one step per request; a rejection needs a comment and ends the request; decisions are final (trigger); a material change supersedes pending *and approved* requests.
- **Hooks:** subject modules react to outcomes through `decideApproval()` (`src/modules/approvals/service.ts`), in the same transaction as the decision.
- `GET /api/approvals/queue` lists what the caller can sign right now.

**MOC** (`src/modules/moc`). Lifecycle: `draft → review → approved → (startup_review) → in_service → closed`, with `rejected` and `cancelled` as exits.
- **Screening** (`screening.ts`, rule set `moc-screening/1`) maps nine yes/no answers to a risk level, the reviewing roles, and whether a PSSR is required. Final authorization is always by `operations_manager`.
- **Generated action plan** from the answers and affected items: document revisions, training, an implementation work order, hazard review, safety-device test, shift communication, and restoration for temporary changes.
- **Action completion is verified where the platform has the evidence.**
  - A document action needs an approved revision released after authorization.
  - A training action needs a course version published after authorization and assigned.
  - A work-order action needs the work order verified or closed.
  - Other actions need a written note.
- **Startup:** blocked while startup actions are open. A PSSR "no" blocks startup. When every item is yes or n/a, startup sign-off goes to EHS and operations.
- **Visibility:** asset detail lists open changes touching the asset. The `moc-register` report shows stage, who it is waiting on, overdue actions and temporary changes nearing or past their end date.

## 7. Preventive maintenance and inventory (S4)

**Stock ledger** (`modules/inventory`). Stock changes only through `postTxn()`. It locks the balance row, refuses a negative result (`422 insufficient_stock`), and appends an `inventory_txn` row with the signed quantity and resulting balance. Movement types: opening, receipt, issue, return, transfer out/in (a matched pair with one reference), adjustment (reason required) and count. The ledger has two layers of protection. The runtime role has no UPDATE/DELETE grant, and a trigger stops even the table owner. Corrections are new transactions.
- **Work orders.** Using a part that is stocked at the work order's facility requires naming the storeroom it came from, and posts an issue linked to the work order. Unused parts are returned to the same storeroom. Non-stock items (nothing on record at that site) are recorded without a movement.
- **Cycle counts** snapshot expected quantities when opened. Posting writes the variance against current on-hand. If anything moved in the meantime, posting is refused (`409 stock_moved`) until someone recounts or confirms.
- **Cost** is a tenant-wide moving average updated by receipts and costed opening balances. It is operational costing; the accounting system stays the book of record.

**PM scheduling** (`modules/pm`). A plan is calendar-based (`interval_days`) or meter-based (`meter`, `interval_meter`), with a lead window. Rules live in pure functions in `pm/schedule.ts` and are unit-tested:
- due from (due date − lead days), or from (due reading − lead allowance); overdue past the due date or reading
- next due on a **completion** basis counts from when the work was done; on a **fixed** basis it steps from the previous due point and skips missed cycles, so the anchor dates hold.

`POST /api/pm/generate` creates one preventive work order per due plan, carrying the planned parts and the current approved procedure. It is safe to run repeatedly: a unique partial index allows one open work order per plan. The plan moves forward when its work order is **verified**, not when the technician marks it complete (D-031). Meter readings may not go backwards.

## 8. Purchasing (S5)

**Approval routing.** A submitted request's estimated total, spend type (operating/capital) and facility select rules from `purchase_approval_rule`. Each matching rule adds a role-addressed step; rules that share a stage are signed in parallel. Defaults are copied to every tenant and can be edited by an administrator:
- budget owner (maintenance manager) for every amount
- plant manager from $2,500
- finance from $10,000, and for all capital requests

Requests go through the shared approval engine (§6), so its controls apply: no self-approval, distinct signers, final decisions, and supersede on change. Any edit after submission raises the revision, voids approvals already given, and returns the request to draft (D-034).

**Delegation.** An `approval_delegation` lets a stand-in sign steps addressed to roles the delegator holds, between two dates. The step records `on_behalf_of`. A delegate can never approve the delegator's own request, and distinct-signer rules count both people.

**Orders.** A buyer turns an approved request into purchase orders, one per supplier. The order price may differ from the estimate, but the request's ordered total may not exceed the approved total by more than 10%; beyond that the request must be revised and re-approved (D-035). The platform prints the PO as a PDF and does not transmit it (no supplier integration).

**Receiving.** Stocked lines are received into a storeroom at the order's facility as stock-ledger receipts at the order price, which also updates average cost. A part stocked at the site must name its storeroom. Non-stock lines are recorded as direct use. Over-receipt is refused. Receipts are append-only.

**Demand into purchasing.**
- "Request parts not in stock" on a work order drafts a request for planned parts not covered by on-hand stock, open orders or open requests.
- The parts-to-reorder report computes a stock position (on hand + on order + requested) and can draft a replenishment request.

Invoices, payments and three-way match stay in the accounting system (S6 adapters).

## 9. Accounts payable and the integration framework (S6a)

**System-of-record split.**
- The platform owns purchase orders, receipts and supplier-invoice capture and approval.
- The accounting system owns bills once they are sent, payments, and the general ledger.
- So payment status comes back from accounting through the sync. It can be typed in only when the connection is a file export.

**Invoices.**
- **Capture:** from a purchase order (pre-filled with what was received and not yet invoiced) or line by line, with the scanned file attached.
  - An invoice number can't be entered twice for the same supplier (enforced by a unique index).
  - The due date comes from the supplier's terms ("Net 30", "2% 10 Net 30", "COD"), or is set by hand.
- **Basic match (informational):** per order line, the quantity invoiced so far is checked against the quantity received, and the price against the order price (2% tolerance). Full three-way match with exception routing is Category 2.
- **Approval:**
  - The approver is not the person who captured the invoice (D-038).
  - A mismatched invoice can be approved only with a written reason.
  - Approval writes an `ap.bill.approved` outbox event in the same transaction.
  - Voiding an invoice that has already been sent queues `ap.bill.voided`.

**Outbox and delivery.**
- Domain services call `emit()`. The idempotency key names the business fact (`bill:<id>:approved`), so the same fact is never queued twice.
- `runSync()` (from `scripts/run-sync.ts` on a schedule, or "Sync now"):
  - queues new events for the active connection, from the connection's start point (now, or a backfill of everything)
  - claims due deliveries oldest first with `FOR UPDATE SKIP LOCKED` and hands them to the adapter
  - records each result
  - pulls payment status for bills that have been sent
- Failures retry after 1, 5, 30, 120 and 720 minutes. After six attempts, or a permanent error, the delivery is parked as **dead**. A person retries it (e.g. after mapping an account) or marks it resolved with a note (e.g. "entered by hand as bill 1043").
- Adapters must pass the idempotency key to the provider, so a delivery that succeeded but was not recorded cannot create a duplicate when retried. This is tested.

**Adapters** (`platform/integration/adapter.ts` interface):
- `file_export` writes one CSV of bill lines per sync run, with mapped account codes and generic column names. Someone downloads it and imports it into any accounting system. Payments are then recorded by hand.
- `mock_accounting` is a **MOCK** provider inside the database:
  - It finds or creates vendors through the external-ID crosswalk.
  - Its idempotency, outage simulation and "pay in accounting" exist for demos and tests.
  - It is labeled MOCK everywhere it appears.
- QuickBooks Online and Xero adapters will implement the same interface once a pilot chooses (D-016). D-039 records why no provider adapter was built yet.

**Account mapping.** Platform keys (`inventory`, `maintenance_expense`, `capital_projects`, `freight`, `sales_tax`) map to the tenant's chart of accounts. They are resolved at delivery time, so fixing a mapping and retrying works. Line defaults:
- received into a storeroom → inventory
- capital request → capital projects
- otherwise → maintenance expense

## 10. Time capture and payroll export (S6b)

**What is in scope.** The brief's Category 1 workforce essentials: basic time capture and approvals, plus a payroll-ready export. Overtime rules by jurisdiction, shift differentials and PTO accruals are Category 2 ("Advanced Time & Labor"). The payroll provider stays the system of record for pay.

**Timesheets.**
- One per employee per week (Monday to Sunday, at the employee's home facility).
- Hours booked on work orders flow in automatically. While the week is a draft, they are read live from `work_order_labor`.
- Employees add other time with an earning code (REG, OT, PTO, HOL, SICK, UNPAID; tenant-editable).
- An approver at the facility may enter a week on someone's behalf, e.g. from a paper timecard. That week then needs a different approver.

**Submission and approval.**
- **Submit:** copies the week's work-order labor into the timesheet and freezes it. New work-order labor for that week is refused until a supervisor sends the week back.
- **Approve or send back:** done by someone with `time.approve` at the facility, never the employee. Sending back requires a note.
- **Reopen:** an approved week can be reopened, but not once it has been exported.
- **Freeze:** a trigger blocks any change to entries of approved or exported weeks, even by the table owner.

**Warnings.** More than 40 worked hours with no OT coded is flagged for review under the customer's pay policy. A day over 12 hours is also flagged. Neither is calculated.

**Payroll export** (`time.export`, payroll administrator role):
- A preview for a range of weeks shows what is ready (approved), already exported, and not ready (draft, submitted, sent back, or never started for an active employee).
- The export writes a CSV in one of two layouts, one line per person-week-code or one per person-day-code, using the provider's code where mapped.
- Exported weeks are marked and frozen; later corrections are made in payroll.
- Provider-specific formats or APIs (ADP, Paychex, Gusto…) are not built (D-016).

**Report.** *Time and labor* covers the last N complete weeks:
- timesheet completion
- weeks waiting for a supervisor
- hours worked and paid leave
- wrench time (work-order hours ÷ worked hours, for people who booked work-order time)
- overtime-review weeks

## 11. Notifications (shared service)

**Producers.**
- **Event notices** are written in the same transaction as the change, via `platform/notify`:
  - the approval engine tells everyone who can sign the current stage (role holders at the facility, plus active delegates), and tells the requester the outcome
  - "waiting" notices close themselves once their step is signed, skipped or superseded, so nobody is told about work someone else already did
  - work-order assignment tells the technician
  - training assignment tells the learner
  - a timesheet sent back tells the employee
  - receiving a delivery tells whoever requested it
  - the person who caused an event is never notified of it
- **Reminders** come from a daily sweep (`modules/notifications/reminders.ts`, run by `scripts/run-reminders.ts`):
  - PM due without a work order
  - overdue assigned work
  - training due within 7 days or overdue
  - qualifications expiring within 30 days
  - late purchase orders
  - invoices waiting for approval
  - last week's timesheet missing, or timesheets waiting for approval
  - accounting sync failures
  - temporary changes ending within 14 days

  Dedupe keys hold each reminder to once a day per summary, or once a week per item. The sweep runs without a user (system scope) and changes no business records.

**People control it.** Users read and clear only their own notifications, mute kinds they don't want, and turn the daily email digest on or off.

**Email.** `queueDigests` writes at most one digest per user per day, covering unread items not yet emailed. `sendQueued` hands messages to a `MailSender` and retries up to 5 times. Only `DevFileMailSender` exists: it writes `.eml` files under `.storage/mail` and sends nothing (D-045).

## 12. CRM and sales (S7a)

**Customers** are tenant-wide records, not tied to a facility. Contacts sit under customers; one can be primary. Opportunities move lead → qualified → proposal → negotiation → won or lost:
- the default probability comes from the stage
- "lost" requires a reason
- sending a quote moves the linked opportunity to proposal, and acceptance moves it to won (never backwards)

Activities cover calls, emails, meetings, notes and follow-up tasks. A task has a due date, and the reminder sweep tells its owner when it is due.

**Quotes.**
- Belong to the selling facility.
- Catalog lines carry list price and standard cost; free-text lines are allowed.
- Finishing a draft checks pricing (D-047). If any line is more than 15% below list, or the margin on costed lines is under 20%, it goes to a sales manager through the shared approval engine, with the reasons stored on the quote. Otherwise it is ready to send at once.
- Sending renders the PDF once, stores it with its SHA-256 per revision (`quote_sent`), and logs an email activity. The customer-facing PDF never shows cost or margin.
- Any change after finishing is a new revision, which supersedes pending approvals.
- Acceptance is recorded only for a sent, unexpired quote. It captures the customer PO, creates the sales order from the quote lines, turns the prospect into a customer, and wins the opportunity.

**Orders and shipments.**
- Shipments are append-only.
- An item linked to a part stocked at the order's site must ship from a named storeroom, through a `shipment` stock-ledger movement. Services and non-stock items record quantity only.
- Over-shipping is refused. An order with shipments cannot be cancelled.
- The rep who wrote the quote is notified of shipments.

## 12b. Receivables (S7b)

**Invoices** are drafted from an order's shipped, not-yet-invoiced quantity (D-050). A draft can bill less (for a partial invoice) and add freight, sales tax and a note. Issuing:
- assigns the number from the tenant sequence (D-051), sets the invoice date and the due date from the order's terms (Net 30 when the terms are not recognized)
- checks again, under row locks, that each line is still shipped and uninvoiced, and raises `qty_invoiced` on the order line (a database check keeps it ≤ shipped)
- renders the PDF once and stores it with its SHA-256
- emits `ar.invoice.issued` to the outbox; voiding an issued invoice emits `ar.invoice.voided` and returns the quantity to the order. An invoice with payments applied cannot be voided

Invoice lines carry account keys (`sales_revenue` for products, `service_revenue` for services); freight and tax go to `freight_income` and `sales_tax_payable`. Each tenant maps these to its chart of accounts like the AP keys.

**Payments** (D-053) follow the system-of-record rule: with an API connection, the sync pulls payments for delivered invoices and applies them idempotently (one record per external payment); otherwise a person records a payment and applies all of it across the customer's open invoices. Payments and allocations are append-only. Invoice status (issued → partially paid → paid) is derived from the allocations.

**Credit** (D-052): exposure = open invoice balances + order value not yet invoiced. When accepting a quote takes a customer with a limit over it, the new order goes on credit hold, people with `ar.credit` are notified, shipping is refused, and release needs a reason that stays on the order.

**Collections.** The queue lists customers with overdue balances, oldest first, with the primary contact, last collections contact and any promise to pay. A logged call can record a promise date, which becomes a follow-up task (reminded through the existing task reminder, linked to the invoice). Payment reminders (D-054) are queued emails to the primary contact. The weekly sweep tells `ar.manage` users at each site how much is overdue.

**Sync.** Both adapters accept the AR topics. The file export writes a separate `ar-invoices-*.csv` (customer columns, revenue accounts) alongside the AP file. The MOCK system creates a customer record on first use (remembered in `external_ref`), stores invoices and can mark them paid in full or in part.

## 12c. Production (S8a)

**Structure.** A work center belongs to a facility and lists the machines (assets) that can run its work; none means manual work. A product revision (D-055) is the bill of materials (component parts, quantity per unit, scrap allowance, consuming operation) plus the routing (operations at work centers with setup and run minutes, optional work-instruction document). Drafts are edited as a whole; circular structures are refused by walking current structures recursively. Released revisions are frozen by a trigger; releasing a new one obsoletes the old. Standard material cost and minutes roll up from current part costs.

**Orders** (D-056) are created against a part with a released revision, optionally for a sales order line (whose rep is told when it finishes). Release copies the revision's materials and operations onto the order. Material status per line = remaining need against site on-hand net of other open orders' remaining needs; shortages of bought parts can become a purchase request, of made parts a component production order (D-060). Materials are issued and returned through the stock ledger (`production_issue` / `production_return`).

**Execution** (D-057, D-058). A run is a `production_entry`: operator, machine (required when the work center has machines, and one of them), kind (setup or run), start and stop. Starting checks the order is open, the machine is not down or out of service, the operator holds the machine's `operate` qualifications, and neither operator nor machine already has an open run (partial unique indexes). Stopping records good, scrap (reason code) and rework; an operation can process at most what the previous one passed, and it is done when its input is final and fully processed (or a supervisor finishes it). Live starts and stops set the machine running/idle through the asset state model, so utilization reports include production.

**Output and close** (D-059). Good units from the last operation are received into a finished-goods storeroom (`production_receipt`, which updates the part's average cost). Receiving the full quantity completes the order; a supervisor can complete short with a reason. Closing records material variance, first-pass yield and actual vs standard hours in the audit trail.

**Report** `production-status`: open orders with progress, current operation, material state and lateness; first-pass yield, scrap rate and top scrap reason; actual vs standard hours by work center; demonstrated throughput per machine (units per recorded run hour).

## 12d. Quality and safety (S8b)

**Nonconformances** (D-061) can be raised by anyone with `quality.report`. Raised from a production run with scrap, the order, part, quantity, machine and scrap reason fill in automatically (one per run). Raised from a purchase order, the supplier fills in; raised from a sales order, the customer does. Quality staff at the facility are notified. Quality (`quality.manage`) records containment and then the disposition: scrap, rework, repair, use as is, or return to supplier (only when a supplier is linked). Repair and use-as-is on major or critical ones are concessions (justification required, and not by the reporter). Scrap is costed at quantity × part unit cost unless a cost is entered. Major and critical nonconformances close only with a corrective action linked.

**Corrective actions** (D-062) are owned by one person (anyone with access to the facility) and managed by quality, or by safety for incident-sourced ones. Each step checks its evidence before moving on: containment, then root cause with its method (5 whys, fishbone, 8D), then at least one action done with none left open. The effectiveness check has a date (default 30 days after actions finish). It is recorded by quality but never by the owner, enforced by a database check. "Not effective" sends it back to actions.

**Actions** (D-063) belong to a corrective action or an incident. Each has an owner and due date, and a note is needed to mark it done. Owners are notified, overdue actions remind daily, and "My actions" lists them across subjects.

**Incidents** (D-064, D-065) are reported with kind, time, place and optional equipment. Safety staff are notified, and for injuries and illnesses so are people with `safety.view` at the site; notices never contain names. Safety staff classify the incident: severity, person involved, injury, treatment beyond first aid, days away and restricted, and recordable (a person's decision). Then come the investigation (root cause, contributing factors) and actions; a corrective action can also be opened. Closing requires the recordability decision for injuries and illnesses, a root cause unless it is a low-severity near miss or first aid, and no open actions. For readers without `safety.manage`, private fields are removed from responses on the server, not hidden in the UI.

**Reports.** `quality-status`: open nonconformances; cost of poor quality (disposition costs plus production scrap not written up, at standard material cost); repeat parts and suppliers; corrective actions overdue or waiting for their check; the share verified effective. `safety-summary`: recordable cases; incident rate per 200,000 hours worked from approved timesheets (D-066, flagged when hours are too few); days since the last recordable; near-miss ratio; unclassified reports; overdue actions. It never shows names.

## 12e. Calibration, audits and attachments (S8c)

**Calibration** (D-067, D-068). A calibration plan puts an asset under control: interval, tolerance, method, in house or external lab, next due date. `assertCalibrated` is called when a production run starts on a machine, so an overdue instrument cannot be used. Each calibration record (immutable) has as-found and as-left results:
- **As found out of tolerance** creates a major nonconformance before the record is written. Its description lists every production run on the instrument since the last in-tolerance as-found result (order, operation, part, good units, dates), so quality can assess the product.
- **As left failed** sets the asset out of service. The next passing record returns it to available.

Reminders tell quality staff about overdue instruments daily and those due within 14 days weekly. The quality report counts instruments overdue or failed.

**Audits** (D-069). An audit has a scope, kind, planned date, lead auditor, owner of the audited area (never the lead auditor) and a checklist. The lead auditor (or quality) starts it, records a result and evidence per item (findings and observations need evidence), and issues the report once every item has a result; the area owner is told how many findings to answer. A finding is answered with a corrective action (source `audit`, owned by the area owner by default) or with actions in the shared tracker, linked to the checklist item. Closing checks every nonconformity is answered.

**Attachments** (D-070) are stored in the blob store with their SHA-256 and listed per record. Access follows the record (quality or safety visibility, or being its reporter, owner or auditee). Incident files default to restricted. Uploads are checked for type and size.

## 12f. Maintenance materials: spares, repair templates, kits (S9a)

**Equipment parts lists** (D-071) link assets to parts: quantity installed, position, critical, minimum to keep. The asset page shows each spare's availability at the site, flags critical spares below their minimum, and lists the other machines that use the same part. The `asset_parts` import accepts OEM recommended-spares lists and matches parts by our part number or the manufacturer's (with a warning when matched that way).

**Repair templates** (D-071) are a repair BOM plus labor estimate and procedure, for a machine or every asset of a category. Applying one to a work order adds missing planned parts, fills the labor estimate when it is empty, and attaches the procedure's current version. Planned parts stay the reference; usage is recorded separately as before.

**Kits** (D-072 to D-074). A kit belongs to a work order. Building it creates one line per planned part not yet used and stocked at the site. Each line reserves up to what the best storeroom has available.
- **Availability** everywhere is on-hand in storeroom-kind locations minus open kit reservations (`availabilityByLocation`, `availableAtSite`). Production's material status uses the same rule.
- **Statuses:** `reserved` (the virtual kit: stock on its shelf, no longer available), `staged` (a complete kit moved to a staging location by ledger transfers, never available to others), `issued` (posted to the work order from staging or straight from the storeroom), then `closed` after unused quantities are returned (back through staging to the original storeroom). `cancelled` releases the kit and returns staged stock; completing or cancelling a work order releases an unissued kit automatically.
- **PM generation** builds the kit when the new work order has stocked planned parts.

The `kit-readiness` report lists upcoming work orders with parts (no kit, short, reserved, staged, issued) and critical spares below their minimum. Reminders flag short kits for work due within seven days.

## 12g. FMEA (S9b)

An FMEA (D-075) has a number shared by its revisions, a kind (process, design, equipment), a scope, a scoring method (D-076), an owner, a team and optional links: an asset (required for equipment FMEAs), a part and the SOP covered. Rows hold:
- the item or step, failure mode, effect and severity
- the cause and occurrence
- prevention and detection controls, and detection
- the computed priority
- for equipment FMEAs, a failure code and the PM plan that acts as a control
- a corrective action link
- after-action S/O/D and priority

`actionPriority(s, o, d)` implements the AIAG-VDA table; `priorityOf` applies the FMEA's method.

**Workflow** (D-077):
- **Draft:** the owner (or quality) edits the whole worksheet. Row ids are kept by sequence, so actions stay attached.
- **Submit:** refused while a high-priority row has neither an action nor a corrective action. It opens an approval request for `quality_reviewer`, and the engine prevents self-approval.
- **Approval:** releases the revision and supersedes the previous one; rejection returns it to draft.
- **After approval:** a trigger allows only the after-action columns and the corrective action link to change. Evaluation needs the row's actions finished and cannot raise severity.
- **Revise:** copies rows, with after-action scores as the new baseline, and moves open actions to the new rows.

**Evidence** (D-078): for equipment FMEAs, each row with a failure code shows corrective work orders on the asset with that code in the last 12 months, and flags optimistic occurrence ratings. The `fmea-risk` report lists open high-priority modes across FMEAs, actions overdue, reviews overdue and under-rated failure modes.

## 12h. Business continuity (S9c)

Module `src/modules/continuity`. A continuity plan (D-079) protects one critical process at one facility: RTO, optional RPO, criticality, owner and alternate (database check that they differ), review and exercise intervals. Its body is:
- **dependencies**, each typed: equipment (asset), supplier, skill (qualification, with the number of holders needed), person (employee) or other, with an optional workaround
- **scenarios**: the disruption, impact, recovery steps, recovery owner, estimated recovery hours and an optional controlled procedure
- **call list**: name, role, phone or email

**Workflow:**
- **Draft:** the owner, alternate or `continuity.manage` edits the header and the whole body.
- **Submit:** needs a scenario and a call list. It opens an approval request for `operations_manager`.
- **Approval:** supersedes the previous revision and sets the review date. A trigger freezes dependencies and scenarios on any non-draft revision. Contacts stay editable on the approved revision (D-082).
- **Revise:** copies the body and contacts, and moves open actions.
- **Review:** `confirmReview` records the note and sets the next review date.

**Exercises** (D-081) belong to the revision exercised; history is read across revisions of the plan number. Results are final (trigger). Findings become actions in the shared tracker (`subject_type = continuity_plan`, `continuity_exercise_id`). Evidence attaches to the exercise.

**Assessment** (D-080): `assessPlan` reads the plan against live records — asset state, current non-expired, non-revoked qualification grants of active employees at the site, employee status, supplier status and parts with no other active supplier — plus review date, exercise due date, whether a timed exercise recovered within the RTO and unanswered exercise findings. The plan page, the plan list and the `continuity-readiness` report all use it, so they always agree. The weekly reminder tells the owner and alternate when a review or an unscheduled exercise is due within 30 days.

Permissions: `continuity.view` (managers, quality, production supervisors, buyers, executives) and `continuity.manage` (operations manager, EHS, admin). Plan owners and alternates can always see and edit their plan. `/continuity-plans/:id/options` serves the editor's pick lists so an owner needs no purchasing or HR permissions.

## 12i. Reliability (S9d)

`assets/reliability.ts` is a pure function, like `utilization.ts`, and reuses it. `computeReliability(intervals, correctiveWorkOrders, window)` merges unplanned-downtime records into stops (D-083). It picks the basis:
- `state`: at least 168 recorded hours
- `work_orders`: otherwise
- `none`: no data

It returns failures, MTBF, MTTR, uptime, downtime, availability, coverage, failure codes and repeats. Repeats look back 30 days before the window (D-084). `reliabilityInputs` loads intervals and corrective work orders for many assets in two queries.

The `reliability` report runs the function on the current and previous windows for each active top-level asset. `GET /api/assets/:id/reliability?days=` returns the current window, the previous window and 12 calendar months; the asset page shows it. Failure codes come from corrective work orders (the same codes equipment FMEAs use, §12g), so a bad actor in this report can be followed into its FMEA.

## 12j. Sites, portfolios and contractors (S10a)

**Sites and access** (D-085, D-087):
- `facility.kind` and `facility.address` describe a property, store or plant.
- `facility_group` and `facility_group_member` group sites. `user_role_assignment.facility_group_id` grants a role on a group.
- `loadActor` expands group grants into per-facility grants. The `user_role_scope` view, a security-invoker union of direct and expanded grants, replaces `user_role_assignment` wherever the code asks who holds a role at a facility.
- Row-level security is untouched; the site list itself is filtered by it.
- `sites` module: sites and groups (`tenant.admin`), grants, request links. The `sites` import target and the role templates `property_manager` and `store_manager` support it.

**Spaces** (D-088): asset class `space`. The unit-directory profile builds tags as `{Property}-{Unit}`.

**Requests without sign-in** (D-091):
- `public_request_link` stores a token hash. `public_request_resolve()`, a security-definer function like `auth_resolve_token`, returns only the tenant, facility and link ids.
- `/public/requests/:token` sits outside `/api` and its auth hook. It runs in a transaction scoped to that tenant and that one facility, and inserts a `maintenance_request` with `source = 'public'`.
- The managers at the site are notified. `listRequests` and `rejectRequest` make up the inbox.

**Contractors** (D-089):
- **Suppliers** gain `trades` and `insurance_expires_on`.
- **Work orders** gain the vendor, a not-to-exceed amount, vendor status, the vendor's reference, and `dispatched_at`, `vendor_accepted_at` and `responded_at`.
- **`maintenance/vendors.ts`:**
  - `dispatchVendor` (insurance check, `email_message` kind `vendor_dispatch`)
  - `recordVendorUpdate` (accepted, declined, on site, completed; drives the normal transitions)
  - `vendorSpend`, `saveContractor`, `listContractors`
- **Completion:** accepts the contractor's completion instead of labor entries.
- **Payables:** `supplier_invoice.work_order_id`; `matchCheck` adds the not-to-exceed test across all non-void invoices on the work order.

**Service levels** (D-090):
- `service_level` holds targets per priority, provisioned with defaults.
- `slaOf` gives the met, missed, at-risk or on-track state for response and completion, shown on work-order lists and pages.
- The `service-levels` report runs by site or by contractor, with spend over the not-to-exceed.

## 12k. Leasing (S10b)

`leasing` module:
- `rental_unit` (one per space, D-092) and `lease` (renter = `customer`, with a new `party_type`).
- `lease_charge`, `lease_billing` (lease and month → invoice) and `unit_turn` (with `work_order.unit_turn_id`).
- The exclusion constraint on `lease` is `daterange(start_date, move_out_on)` for leases in force (D-093).

**Lifecycle:**
- `createLease` (creates the renter when needed) and `activateLease` (closes an open turn).
- `giveNotice` and `recordMoveOut` (opens a turn).
- `renewLease`: ends the old lease the day before and copies the current charges.

**Billing** (D-094):
- `billingPreview` computes proration per lease.
- `runRentBilling` inserts `customer_invoice` (with `lease_id`) and lines carrying `account_key`. It records `lease_billing` and optionally calls the receivables `issueInvoice` (numbering, PDF, outbox).
- `invoicePayload` now prefers the line's account key, so rent posts to `rental_income`.

**Reading:**
- `rentRoll` gives the status per unit at a date: occupied, notice, vacant or offline.
- It also shows the lease in force, rent and charges, balance and past due (grace days), the next lease, days vacant and the open turn.
- The `rent-roll` report and the weekly `reminder.leasing_due` are built on it.

Import targets `rental_units` and `leases` load units and rent rolls from other systems; balances stay in the old system.

## 12l. Store operations (S10c)

**`storeops` module:**
- `condition_point`: asset, measure, unit, low and high limits, interval.
- `condition_reading`: append-only, enforced by a trigger.
- `condition_excursion`: one open excursion per point.
- `recordReading` (D-098) is the only write path; the `condition_readings` import goes through it, so imported logs raise requests exactly like readings taken in the app.
- `listPoints` derives ok, out, missed or no-readings.
- Missed readings feed the `reminder.readings_missed` notification (D-099).

**Site visits** (D-100):
- `visit_template` holds JSON items. `site_visit` and `site_visit_item` copy those items, and a trigger makes completed visits final.
- `completeVisit` scores the visit. Failed items become a `maintenance_request` (source `visit`) or an `action_item` (subject `site_visit`, `site_visit_item_id`).
- `getVisit` compares with the previous visit of the same checklist at the same site.

**Supporting pieces:**
- The `store-standards` report covers latest and previous scores, critical misses, open fixes, readings on time and excursions.
- Import targets: `condition_points` (limits from an equipment list) and `condition_readings` (form or paper logs, in store-local time).
- The asset page's condition panel lets staff log a reading from the equipment's QR code.

## 12m. Demand, capacity and material plan (S11a)

`planning` module:
- `customer_forecast` and `customer_forecast_line` hold forecast versions (D-101); a trigger freezes active versions.
- `work_center.hours_per_week` and `units` are the calendar. `planning_scenario` stores adjustments only.
- `planInput` gathers the plan's inputs for one site:
  - active forecasts and open sales order lines (part through `sales_item.part_id`, month by promised, requested or order date)
  - the part tree through released revisions
  - available stock (kit reservations excluded), open production and purchase orders by month
  - preferred supplier lead times
  - work centers with their machines' availability (`computeUtilization`, last 90 days, ≥ 30% coverage)
  - demonstrated run minutes, good and scrap per part and operation (production entries, 180 days)
- `computePlan` (D-102) returns:
  - demand (firm and forecast)
  - planned production
  - per work center and month: scheduled, capacity, committed, firm, forecast, required, utilization, shortfall
  - the bottleneck
  - materials with projected balance, need-by and order-by
  - the list of assumptions
- `getPlan` runs it with and without a scenario for comparison (D-103).

Supporting pieces:
- The `capacity-plan` report.
- The `customer_forecasts` import target, which parses month headers like `Nov-26`, `11/2026` or `2026-11` and unpivots wide sheets through the profile.
- The engine is unit-tested against hand-computed numbers (`test/planning-engine.test.ts`).

**Acting on the plan (S11b).** Always the plan as it stands, never a scenario:
- `requestPlanShortages` drafts one purchase request for the short materials. The quantity is the shortfall less what open, unordered purchase requests already ask for (`toRequest`). Lines are received where the part is stocked, needed by the earliest need-by date.
- `createPlannedOrders` creates production orders in status `planned` for the chosen part-months, due at the start of the month (today for the current month).
- Neither can create the same thing twice: open requests reduce `toRequest`, and new orders are open production the plan nets.
- Open production orders' unissued materials are dependent demand (`allocations`): a released order's own material lines, or a planned order exploded through the released BOM. Without this, creating orders would hide their material needs.
- Preventive maintenance comes off capacity. Calendar PM plans on a work center's machines are projected through the horizon at their estimated hours (`projectMaintenance`); an overdue occurrence counts now and restarts the cycle from today. Meter-based plans and plans without estimated hours are listed as assumptions, not guessed (D-105, D-106).

**Qualified labor (S11c, D-113).** The plan's `labor` section lists, for each work center that has operate requirements, the qualified people per month, the operator hours needed and available, and the shortfall:
- **Inputs:** `planInput` gathers each work center's operate requirements, the active people at the site holding any of them (with effective and expiry dates), and their demonstrated weekly hours from approved timesheets.
- **Calculation:** `planLabor` runs a small maximum flow (`maxFlow`, Dinic) per month: source → person (hours) → work center they qualify for → sink (machine hours × `work_center.labor_ratio`).

**Consumables, chemicals and PM parts (S11d, D-114, D-115).**
- **Rates:** `consumption_rate` (migration `0027`) holds the rates; `planInput` passes them, together with PM plan parts projected by `projectMaintenance` (counted per occurrence), as `consumption` and `maintenanceParts`.
- **Netting order:** the engine nets purchased parts **after** computing the load, because per-hour usage follows machine hours and per-unit usage follows the units routed through each work center (`units` per work center and month).
- **Outputs:** material rows carry `bySource`; `consumablesCost` gives the monthly cost of consumption and of PM parts.
- **Import:** the `consumption_rates` target reads "quantity per N" with basis words such as hrs, pcs or monthly.

## 12n. Statistical process control (S12a)

Module `src/modules/spc`, migration `0024`. Permissions reuse quality: `quality.view` reads, `quality.report` records measurements (operators), `quality.manage` sets up characteristics, sets limits, excludes subgroups and answers signals.

- **Tables:**
  - `spc_characteristic`: code, part, operation, work center, machine, gauge, unit, nominal, tolerance, subgroup size 1–10
  - `spc_subgroup`: measured time, values array, order, lot; append-only except the exclusion
  - `spc_limit`: limits with their baseline and reason; latest in force
  - `spc_signal`: one per subgroup, rule and chart; answered with cause, response and optional NCR
- **Engine** (`spc/engine.ts`, pure, unit-tested against the published constants and hand-computed cases):
  - `computeLimits`, `points`, `evaluate` (rules), `capability`
- **Recording:**
  1. Check the subgroup size and that the gauge was in calibration at the measured time.
  2. Insert the subgroup.
  3. Raise an out-of-tolerance signal if any value is outside the tolerance.
  4. Against set limits, for points after the baseline, evaluate the last 30 included subgroups and keep the rules completed by this point.
  5. Notify `quality.manage` at the site (`spc.signal`).
- **Reading:**
  - the chart window (last 50 by default) with limits in force or trial limits
  - rule markers on every point
  - suspect flags from out-of-tolerance calibrations of the gauge
  - capability and the warnings that qualify it
- **Supporting pieces:**
  - the `spc_measurements` import target
  - the `spc-summary` report
  - pages: Quality → SPC, and `/quality/spc/:id` with SVG control charts (`web/src/components/ControlChart.tsx`, with a hover tooltip; the measurement table is the table view)
- Decisions: D-107 to D-111.

**Attribute charts (S12b, D-116).**
- **Schema (migration `0028`):** `spc_characteristic.chart_type` (variables, p, np, c, u) and `sample_size` (the fixed n for np, or the unit size for c); `spc_subgroup.sample_size`. A sample's count is `vals[1]`.
- **Engine:** `attributeCenter`, `attributePoint` (per-point limits), `evaluateAttribute`.
- **Service and UI:** a separate chart view (`attributeChartOf`, `AttributeDetail`), with limits as steps (the `bands` prop of `ControlChart`).

## 12p. Supplier performance (S13a)

- **Scorecards:** `purchasing/supplier-performance.ts` computes them on request (no stored score) from:
  - order lines with cumulative receipts (window over `po_receipt`)
  - `supplier_delivery_history` (migration `0029`)
  - receiving and supplier nonconformances
  - `supplier_part` prices, and supplier invoice lines against order lines
  - open corrective actions with a `supplier_id`
- **Corrective action requests:** `issueScar` creates a corrective action through `createCapa` (source `supplier`, response due), links the nonconformances and queues an `email_message` of kind `scar`. `recordSupplierResponse` stores the answer and copies the root cause and containment.
- **Reminders and report:** the sweep reminds owners of unanswered requests (`reminder.scar_overdue`); report `supplier-performance`.
- Decisions: D-117 to D-119.

## 12o. Property licence (D-086, D-112)

- **Table:** `tenant_license` holds `property_bands` and `property_band_size` (default 1 × 100). It is readable by the tenant and written only by the control plane.
- **Database trigger:** `facility_property_licence` (security definer, so it counts all the tenant's sites regardless of what the user can see) refuses an insert or update that would make active property sites exceed bands × size. It locks the licence row so concurrent additions are serialized.
- **Service check:** `saveSite` runs the same check first, for a clear 409 error message.
- **Usage:** `property_licence_usage()` and `GET /api/licence` drive the Sites page count.
- **Other site kinds:** not counted (stores open, D-086).

## 12q. Shift passdown (S14a)

- **Module** `src/modules/shift`, migration `0031`:
  - `shift_handover`: facts as jsonb, frozen by trigger after hand-over; acknowledger ≠ writer
  - `shift_handover_item`: with `carried_from_item_id`
- **Functions:** `compileFacts` queries the records for the window; `startHandover` creates the draft and carries open items from the previous log for the same site and area; `handOver` recompiles, freezes and notifies (`shift.handed_over`); `acknowledge` records who read it.
- **Pages:** `/shift-log`, `/shift-log/:id`.
- Decision: D-123.

## 12r. Continuous improvement (S14b)

- **Module** `src/modules/improve`, migration `0032`:
  - the `improvement` table, with the stage, the metric (kind, name, unit, direction), baseline and result windows, and estimated and validated savings
  - `improve.submit` and `improve.manage` added to roles
  - `improvement` as an action-tracker subject
- **Measuring:** `measure()` computes record-based metrics for a date window. Unplanned downtime is the hours of overlap of `asset_state_event` with the window divided by weeks; scrap rate is scrap ÷ (good + scrap) from production runs at the work center.
- **Report and pages:** report `improvement-pipeline`; pages `/improvements`, `/improvements/:id`.
- Decision: D-124.

## 12s. Repair or replace (S15a)

- **Migration `0033`:** `asset.expected_life_years`, `asset.downtime_cost_per_hour`, `work_order.legacy_cost` (parts and contractor cost of jobs imported from a previous system).
- **Module** `src/modules/assets/lifecycle.ts`:
  - `repairOrReplace()` is pure: yearly totals, least-squares trend with a floor, capital recovery factor, verdict and crossover
  - `assetCostHistory()` walks the asset tree (recursive query) and sums labor, parts issued, vendor invoices, legacy cost and unplanned downtime by year
- **API and report:** `GET /api/assets/:id/lifecycle`; report `repair-or-replace` ranks assets with a replacement cost, replace first.
- **Page:** a Repair or replace section on the asset page.
- Decision: D-125.

## 13. Web app

`web/` is a React 18 + TypeScript app built with Vite, served by the API server from `web/dist`. Unknown paths without a file extension get the app shell, so client-side routes and QR links (`/a/<qr token>`) work.
- **Data access:** a thin fetch client sends the bearer token, and `useApi()` / `useAction()` hooks handle loading, error and busy states. There is no client-side business logic. The server enforces every rule, and the UI shows the server's message (e.g. "not qualified to maintain this asset: Q-SPN (revoked)").
- **Navigation:** grouped menus (Maintenance, Supply, People, Admin); a group with one visible item shows as a plain link. A bell shows unread notifications. Badges refresh on every navigation.
- **Permissions:** navigation and buttons follow `/api/me` permissions. Hiding a button is convenience only; the API remains the authority.
- **Design:** plain CSS with the same tokens as printed reports, light/dark via `prefers-color-scheme`, status shown with text pills (never color alone), keyboard-reachable table rows, phone-width layout (checked: no horizontal scroll at 390 px).
- **Protected files** (documents, certificates, report exports) are fetched with the token and handed to the browser as object URLs, never as unauthenticated links.
- **Accessibility:** `scripts/a11y-audit.ts` (`npm run a11y`) runs axe-core (WCAG 2.0 and 2.1, levels A and AA) over the main and detail pages as five roles in light and dark schemes, and fails on serious or critical violations (D-122).
- **Verification:** `scripts/ui-smoke.ts` (Playwright) signs in as technician, EHS reviewer, operations manager, maintenance manager and executive. It walks the main flows and fails on any page error, console error, missing text or phone-width overflow.

### 13a. Offline (S3b, D-121)

- **Client** (`web/src/offline.ts`):
  - a per-user read cache for a whitelist of GET paths (my work orders, a work order, me)
  - an outbox for whitelisted POSTs (work-order labor, parts, transition)
  - `syncOutbox` sends the outbox in order with `Idempotency-Key` headers
- **API client:** `api.get` serves the saved copy when the network is gone; `api.post` queues whitelisted writes and answers `{ queued: true }`.
- **Screens:** `useOutbox` drives the offline bar, the `/outbox` page and the pending list on a work order. A queued status change is shown at once and confirmed when it syncs.
- **Server** (`platform/http/idempotency.ts`): stores the first successful response per tenant, user and key (`idempotency_record`, migration `0030`, purged after 7 days by the daily sweep) and replays it.
- **Service worker** (`web/public/sw.js`): network first for pages (falls back to the saved shell), cache first for hashed assets; manifest and icon make the app installable.

## 14. Reporting and output (Section 15 of the brief)

A single shared service: a **report definition** computes one `ReportResult` (answer-first headline, KPIs with status, 3–5 insights, typed columns with units, rows, exception rows, drill-down path, definitions and notes, source, scope, filters and period). Renderers consume that same result, so **JSON, CSV, HTML print and PDF always show the same numbers** (tested).

- Design tokens live in `reporting/render/format.ts` and are shared by HTML and PDF. Status is shown with text labels, not color alone. Missing values render as "—" with a footnote and are never zero.
- CSV neutralizes formula injection, adds a BOM for Excel, and by default prepends a metadata block (`raw=1` for data only).
- Exports require `reports.export` and are audited with their filters. Scope is limited to facilities where the user holds `reports.view`, and RLS enforces the same boundary.
- Implemented reports: **Maintenance backlog**, **Asset availability & utilization**, **Qualification status & expiries** (including coverage: requirements resting on one person or none) and **Training compliance**, **Management of change register**, **Preventive maintenance compliance**, **Parts to reorder** (stock position below reorder point or short for PM demand in the next N days, with a suggested quantity) **Purchasing status** (awaiting approval, approved not ordered, open and late orders, committed spend, supplier on-time delivery) **Accounts payable aging** (buckets, due this week, waiting for approval, disputes, sync failures) **Time and labor** (timesheet completion, wrench time, overtime review) and **Sales pipeline** (weighted pipeline by stage, quotes awaiting a decision, win rate, bookings, late orders). Quotes print as PDF. Purchase orders print as PDF. Qualification certificates are rendered as PDF too. XLSX is the next shared adapter. PPTX/DOCX are deferred per the brief.

**Utilization definitions** (`assets/utilization.ts`, unit-tested):
- scheduled = recorded − planned downtime − out-of-service
- availability = (scheduled − unplanned) ÷ scheduled
- utilization = running ÷ scheduled (or ÷ calendar, configurable)
- coverage = recorded ÷ calendar

Unrecorded time is never assumed to be running, and assets below a coverage threshold get no ratios. OEE is intentionally not computed until performance and quality data are validated.

## 15. Integrations (approach)

External systems of record stay external: GL/accounting, payroll, payments, e-sign and tax. Each integration will be an adapter module with:
- explicit system-of-record ownership per field
- an outbox table written in the same transaction as the domain change
- idempotency keys
- a retry/reconciliation queue
- clearly labeled mock adapters for local development.

The import framework's `external_ref` crosswalk is the same mechanism integrations use for ID mapping (the MOCK adapter stores accounting vendor IDs there). The outbox, delivery queue and adapter interface are built (§9).

## 16. Runtime and deployment (proposed, not yet built)

- Container image run on a managed platform (e.g. AWS ECS/Fargate or Fly/Render for pilots) with managed PostgreSQL (RDS/Aurora, PITR backups) and S3-compatible object storage.
- Two database roles: the migration owner (CI/CD only) and `erp_app` (runtime). Secrets come from the platform secret manager.
- Large imports and exports move to a job queue (Postgres-based such as pg-boss to avoid new infrastructure). Jobs run through `withTx` with an explicit tenant.

## 17. Known limitations

- Auth is development-grade bearer tokens (D-008). There is no UI yet: an API plus print/PDF outputs only (D-011).
- Import processing is synchronous, with a 50,000-row limit per file. Very large migrations need the job queue.
- User-supplied regex in mapping transforms is length-limited but not time-boxed. Run transforms in a worker with a timeout before opening profile editing to untrusted users.
- Part costs and quantities use JavaScript numbers (fine for operational costing). A decimal library is needed before any financial posting.
