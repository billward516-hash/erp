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

**Built since:** OpenID Connect single sign-on (D-140), the backup and restore drill (D-142), and rate limits, security headers, request ids, metrics and probes (D-150, §12aj).

**Not yet implemented (tracked in ROADMAP):** MFA (with the identity provider), SAML, S3 storage with SSE and signed URLs, encryption-at-rest configuration. Retention of working data is built (D-151); retention or legal hold of business records is not.

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

## 12o. Property licence (D-086, D-112, D-127)

- **Table:** `tenant_license.property_cap` (default 100, `CHECK` 0–100; migration `0035` replaced the bands). It is readable by the tenant and written only by the control plane.
- **Database trigger:** `facility_property_licence` (security definer, so it counts all the tenant's sites regardless of what the user can see) refuses an insert or update that would make active property sites exceed the cap. It locks the licence row so concurrent additions are serialized.
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

## 12t. 8D problem solving (S16a)

- **Migration `0034`:** `corrective_action.format` plus the 8D fields (champion, `is_is_not` jsonb, containment verification, escape point and root cause, root-cause verification, prevention note, recognition); `capa_team_member`; `capa_read_across`; `action_item.discipline` (containment, corrective, preventive).
- **Module** `src/modules/quality/eight-d.ts`:
  - `disciplines()` is pure: one statement of what D1–D8 each need, used by the gates, the page and the PDF
  - `GATE` maps each step to the disciplines needed to leave it; `advanceCapa` checks it for 8Ds
  - team, read-across and recognition services
- **Report:** `eight-d-pdf.ts` renders the 8D report (`GET /api/corrective-actions/:id/8d.pdf`); `quality-status` lists open 8Ds and their step.
- **Page:** the corrective action page shows the disciplines, team, is / is not table, D4 fields, action kinds, D7 and D8 when the format is 8D.
- Decision: D-126.

## 12u. Policies and the employee handbook (S17b)

- **Migration `0036`:** `policy`, `policy_version` (published text frozen by trigger; one draft per policy), `policy_acknowledgement` (append-only), `expense_category`, `expense_policy`; permission `policies.manage`; role `hr_manager`.
- **Module** `src/modules/policies`:
  - `templates.ts` holds the template sections; `placeholders()` finds `[[...]]` markers
  - `service.ts` covers drafts, publish (placeholder and change-summary checks, notices), acknowledgements, the handbook, and the expense rules
- **Acknowledgement:** an acknowledgement counts if it is for the latest revision that required one, or a later revision (SQL fragment `ACKED`).
- **Web:** `components/Markdown.tsx` renders a safe Markdown subset as React elements (no HTML injection), highlights placeholders and fills `{{expense_rules}}`. Pages `/policies` (handbook, all policies, expense rules) and `/policies/:id`.
- Decisions: D-128, D-129.

## 12v. Intranet (S17c)

- **Migration `0037`:**
  - `announcement` (site or everyone; kind; event date; pinned; expiry; withdrawal) and `quick_link` (https or an internal path)
  - `employee.work_phone`, `employee.office_location`
  - `people_directory()`, a security-definer function returning work contact columns only
  - permission `announcements.post`
- **Module** `src/modules/intranet`: announcements, upcoming events, quick links, the directory, and `search()`. Search covers people, policies and announcements for everyone; record groups are added only with the matching view permission, and row-level security limits them to the user's sites.
- **Web:** `components/Layout.tsx` is the intranet shell (sidebar `nav[aria-label=Main]`, drawer under 900 px, skip link, top-bar search). `pages/Home.tsx` is the portal; `pages/Intranet.tsx` holds News, People and SearchResults.
- Decision: D-130.

## 12w. Expense reports (S17d)

- **Migration `0038`:**
  - `expense_report`; `expense_line`, frozen unless the report is a draft (trigger); `expense_approval_rule`
  - `department.head_user_id`; `approval_step.assignee_user_id`
  - permissions `expenses.submit`, `expenses.view_all`, `expenses.manage`
- **Approval engine:** a step with an assignee is shown to, notified to and decided by that person, or their active delegate (`personalStep`, `delegatesOf`); role steps are unchanged.
- **Module** `src/modules/expenses`:
  - `policy-check.ts` is the pure `checkLines()` / `lineReady()`
  - `service.ts` covers reports, lines, receipts (blob store), `approvalRoute()`, submit / withdraw / revise / cancel, the approval callback (outbox `expense.report.approved`, finance notice), reimbursement (`expense.report.paid`), rules and department heads
- **Accounting:** the file export writes `expense-reports-*.csv`; the MOCK system records an employee bill. Expense account keys (travel, meals, supplies, training, telecom, other, employee reimbursements payable) are mapped like the others.
- **Report:** `expense-summary`. **Pages:** `/expenses` (my reports, all reports, approval rules and department heads) and `/expenses/:id` (lines, receipts, flags, route, inline approval, reimbursement).
- Decisions: D-131, D-132.

## 12x. Budgets and spend history (S17e)

- **Migration `0039`:**
  - `spend_category` (account keys, unique across categories by trigger), `spend_history` (imported, keyed for re-import)
  - `budget` (one approved per fiscal year), `budget_target`, `budget_line` (twelve amounts), `budget_submission`; lines and targets frozen once approved (trigger)
  - permissions `budgets.view`, `budgets.manage`; account keys for production materials, utilities and contract services
- **Engine** `src/modules/budgets/engine.ts` (pure): `allocate` (largest remainder, to the cent), `seasonality`, `spread`, `proposeFromHistory`, `historyStats`, `reconcile`, `variance`, `fiscalMonth(s)`.
- **Service:**
  - `actualSpend()` is one query over the sources in D-133; `commitments()`
  - `spendAnalysis()`; budgets, lines, proposals, targets and allocation, submissions, approval, `budgetVsActual()`
- **Import and report:** import target `spend_history` (profile `gl-monthly-actuals.json`); report `budget-vs-actual`.
- **Pages:** `/budgets` (spend history with monthly bars, budgets, spend categories) and `/budgets/:id` (bottom-up grid, targets and gaps, reviews, against actual).
- Decisions: D-133, D-134.

## 12y. Lite edition and built-in books (S17f)

- **Migration `0040`:**
  - licence: `edition`, `user_cap`, `site_cap`, `single_person_approval`, with triggers capping active users and sites; `tenant_edition()`
  - books: `ledger_account`, `books_settings`, `journal_entry` / `journal_line` (balanced by a deferred constraint trigger, immutable except the reversal link and the reconciliation mark, period lock), `bank_rule`, `bank_txn`, `bank_reconciliation`
  - provider `native_books`; permissions `books.view`, `books.manage`; role `bookkeeper`
- **Edition gate** `platform/edition.ts`: `LITE_AREAS`, `LITE_REPORTS`, cached `editionOf()`; the auth hook answers 403 `edition` outside Lite areas; `/api/me` carries the edition and limits.
- **Books** `src/modules/books`:
  - `chart.ts`: the starter chart
  - `posting.ts`: the pure posting rules
  - `ledger.ts`: `postEntry`, `reverseEntry`, `postEvent`, the inline adapter
  - `service.ts`: setup, accounts, manual entries, statements, banking, rules, reconciliation, export
- **Inline delivery:** `emit()` calls the delivery registered by the integrations module when the active adapter is inline; the delivery is recorded like a sync delivery.
- **Imports, reports, pages:** import target `bank_transactions`; reports `profit-and-loss`, `balance-sheet`; page `/books`; simple invoices on Receivables; "Enter a bill" with quick supplier on Payables in Lite.
- **Approvals:** `soleApprover()` in the approval engine, AP approval and expense reimbursement.
- Decisions: D-135 to D-138; overview in docs/EDITIONS.md.

## 12z. Books in every edition (S18a)

- **No gate change was needed:** only Lite restricts areas, so Standard already reaches `/api/books`; D-139 makes it a supported product choice. The starter chart has an account for every platform account key (tested), so every module's events post.
- **Open items** `bringInOpenItems()` (`books/service.ts`, also run by `setupBooks` unless `openItems: false`; `POST /api/books/open-items`): open invoice balances, approved bills and approved expense reports post against opening equity, keyed `invoice:<id>:issued`, `bill:<id>:approved`, `expense:<id>:<rev>:approved`, the keys their own postings use, so payment and void postings find them. Dated at the start, or the item's own date when later.
- **Import target** `opening_balances` (`imports/targets/opening-balances.ts`): one entry per account and as-of date against opening equity (`source = 'opening'`, `source_id` = the account); a changed amount reverses the current entry and posts the new one; control accounts refused; new accounts created from a type.
- **Page:** Books → Settings → "Starting partway through"; the import wizard takes `?target=`.

## 12aa. Single sign-on (S18b)

- **Migration `0041`:**
  - `tenant_sso` stores the issuer, client id, encrypted secret, email domains (unique across companies by trigger), linking and token switches
  - `app_user.sso_issuer` and `sso_subject` identify a linked person
  - `api_token.kind` is `api` or `session`
  - `sso_login` holds sign-ins in progress
  - SECURITY DEFINER functions run the steps that happen before a tenant context exists: `sso_config`, `sso_begin`, `sso_take`, `sso_resolve_user`, `sso_issue_session`, `auth_revoke_token`
  - `auth_resolve_token` also honours "API tokens off"
- **`platform/auth/sso.ts`:**
  - discovery (cached, issuer checked) and keys (cached, refetched once for an unknown key id)
  - ID-token verification with `node:crypto`
  - `startSignIn`, `finishSignIn`, `signOut`
  - secret encryption
- **Routes** (`modules/sso`): `GET /auth/sso/start`, `GET /auth/sso/callback` (outside `/api`, redirects to `/signed-in#token=…` or `#error=…`), `POST /api/session/sign-out`, `GET`/`PUT /api/sso` (`tenant.admin`).
- **Web:** the sign-in page asks for a work email, with the development token sign-in behind a disclosure; `/signed-in` takes the token from the fragment and clears it from the address bar; Admin → Sign-in holds the settings.
- **Configuration:** `APP_BASE_URL` (the redirect URL is `<APP_BASE_URL>/auth/sso/callback`) and `SSO_SECRET_KEY` (required in production).
- **Mock provider:** `scripts/mock-oidc.ts` checks the client, redirect URL and PKCE like a real provider. It is used by `test/sso.test.ts` and `npm run mock-idp`.

## 12ab. Excel export, drill-down map, backup drill (S18b)

- **`reporting/render/xlsx.ts`:** `reportToXlsx(result)` built with exceljs. `format=xlsx` is accepted on every report and audited like CSV and PDF.
- **`reporting/drill.ts`:**
  - `screenFor(apiPath)` maps a record's API path to its web page
  - `recordPath` and `rowLinks` resolve a report's `drillDown` template per row
  - one map serves the workbook links and the report screens
- **`scripts/backup-drill.ts`:**
  - the dump uses `pg_dump --snapshot` from a REPEATABLE READ transaction that also counts the rows
  - `pg_restore --exit-on-error` restores into `erp_drill_<stamp>`
  - checks run as owner, then as the runtime role
  - writes a report, and drops the scratch database unless `--keep`

## 12ac. Units of measure (S19a)

- **Migration `0042`:**
  - `part_uom` (part, unit, stock units per unit)
  - `supplier_part.uom`
  - `purchase_request_line.stock_per_unit`
  - `purchase_order_line.uom` and `stock_per_unit`, frozen when the line is written
  - `po_receipt.stock_qty`
- **`inventory/uom.ts`:** `STANDARD` factors, `normalizeUom`, `factorBetween`, `partUnits`, `requireFactor`.
- **Purchasing:**
  - request lines convert supplier prices to the line's unit
  - orders copy the conversion
  - receiving posts stock units at the price divided by the conversion
  - `incomingByPart` and the planning engine count in stock units
- **API:** `GET /api/parts/:id/units`, and `PUT` / `DELETE /api/parts/:id/units/:uom`.
- **Imports:** the `parts` import adds a purchase unit and pack size; `supplier_prices` adds a price unit.
- **Web:** a units panel on the storeroom part, a unit on request lines, "= N stock units" on order lines, and the price unit on supplier prices.

## 12ad. Report filters, saved views and drill-down (S19b)

- **`reporting/filters.ts`:** `describeParams(schema)` reads a report's zod parameters (unwrapping optional, default and effects) into filter definitions. They are served with `/api/reports` and with each JSON run (`filterDefs`); JSON runs also carry `links`, one screen path per row.
- **Migration `0043`:** `report_view` holds the report, name, params, owner and shared flag.
- **API:** `GET` / `POST /api/reports/:id/views` and `DELETE /api/report-views/:id`. Lite reaches them for its own reports.
- **Web:** the report page builds its filter bar from `filterDefs`, keeps the filters in the URL, offers a saved-view picker with save (and share) and delete, and adds an "Open" column for rows with a record.

## 12ae. Chart library (S19c)

- **`ReportResult.charts`:** `ReportChart` specifies the kind, title, category, at most 3 series, value type, unit, data and an optional reference line.
- **`reporting/render/chart.ts`:** `layoutChart()` produces neutral shapes (rects with rounded data ends, lines, polylines, dots, text) plus a summary. `chartSvg()` draws them for print HTML and `drawChartPdf()` for PDFKit, keeping each chart whole on a page. `niceTicks` and `axisLabel` are shared helpers.
- **`web/src/components/ReportChart.tsx`:** the same drawing rules with CSS variables `--series-1..3` (light and dark steps), a hover tooltip and crosshair, a legend, and SVG download.
- **PDF:** a table header always stays with its first rows.

## 12af. Credit memos, returns and refunds (S19d)

- **Migration `0044`:**
  - `customer_credit_memo` (site-scoped, as invoices are) and its lines (account key; part and storeroom for returns; the inventory transaction once issued)
  - `customer_refund`, append-only
  - `payment_allocation` gains a surrogate key, a nullable `payment_id`, a `credit_memo_id` (exactly one of the two) and `applied_on`
  - journal sources `ar_credit_memo` and `ar_refund`
- **`ar/credit-memos.ts`:** create and update the draft, `issueCreditMemo` (with returns and auto-apply), `applyCredit`, `refundCredit`, `voidCreditMemo`, the PDF (the invoice renderer with `kind: 'credit_memo'`).
- **Events:** `ar.credit_memo.issued`, `ar.credit_memo.voided` and `ar.refund.paid`. They post in the books (the mirror of an invoice; voids as reversals) and go to the file export (`ar_credit_memos` file).
- **Web:**
  - a Credit memos tab on Receivables
  - "Credit this invoice" on the invoice page
  - credits and a new-memo form on the customer account
  - `/receivables/credits/:id` to issue, apply, refund and void

## 12ag. Lot and serial tracking (S20a)

- **Migration `0045`:**
  - `part.tracking` and `shelf_life_days`
  - `stock_lot`: number, kind, status and hold reason, expiry, made-on date, supplier and supplier lot, source, the production order that made it
  - `lot_balance` per storeroom (site-scoped)
  - `inventory_txn_lot`, append-only
- **`inventory/lots.ts`:** `applyLots`, called by `postTxn` for tracked parts. It resolves lots into stock (given; returns last-issued first; finished goods default to the order number) and out of stock (named, or FEFO; consuming movements skip held and expired lots), moves the balances, and checks the per-lot sum against the storeroom balance.
- **Lots through movements:** `postTxn` takes `lots` and `supplierId` and returns the lots moved. Transfers carry them to the destination, and purchase receipts convert lot quantities from order units.
- **`inventory/lot-service.ts`:** `setTracking` (count existing stock into lots), `listLots`, `getLot` (movements, made from, went into, shipped, used on), `setLotHold`, `traceForward` (recall list).
- **API:**
  - `GET /api/lots`, `GET /api/lots/:id`, `GET /api/lots/:id/trace`
  - `POST /api/lots/:id/hold`
  - `PUT /api/parts/:id/tracking`
  - `lots` on receipts, adjustments, transfers, purchase receipts, shipments, production issues and finished-goods receipts, and work-order parts
- **Web:**
  - `LotEntry` and `LotPick` components (`components/Lots.tsx`)
  - Storerooms → Lots, and the lot page `/inventory/lots/:id`
  - tracking settings and lots on the storeroom part
  - lot entry on both receiving forms; lot choice on shipping and production issue; serials on finished-goods receipt

## 12ah. Lots on the remaining movements (S20b)

- **Migration `0046`:** `inventory_count_line.lot_number` (part of the key; `''` when untracked) and `customer_credit_memo_line.lot_numbers`.
- **Kits:** every transfer pair (kit staging, return, cancel, release) passes the lots that left as the lots arriving (`carried()`).
- **Counts:** `openCount` creates lines per lot; `recordCounts` takes a `lot` and adds lots found on the shelf; `postCount` posts per lot.
- **Credit memos:** return lines carry lot or serial numbers into the return movement; a void reverses with the lots from the original movement.
- **Quality:** `holdLotsForNcr` (`POST /api/nonconformances/:id/hold-lots`); `closeNcr` releases held lots for accepted or reworked material; `getNcr` lists the part's lots.
- **Import and report:** the `stock_balances` import accepts lot and expiry; the report is `lot-status`, with drill-down to `/inventory/lots/:id`.
- **Web:** lot lines and "found a lot" on the count sheet, a lot field on adjustments, lot or serials on credit memo returns, lot holds on the nonconformance page.

## 12ai. Feature visibility by role (S21)

- **Migration `0047`:** `tenant_feature` holds the feature key, mode (`all`, `roles` or `off`) and role keys. No row means everyone.
- **`platform/features.ts`:**
  - `FEATURES`: for each feature, the permissions it owns, its navigation paths, its API areas and its reports
  - `featureSettings()`: cached per company for 30 s and cleared on save
  - `applyFeatures(grants, settings)`: strips hidden features' permissions per grant by its roles, and returns the features hidden everywhere
  - `hiddenFeatureFor()`, `hiddenNav()`, `hiddenReports()`
- **Sign-in and requests:** `loadActor` applies the settings (`Actor.hiddenFeatures`). The auth hook refuses hidden features' areas and reports (403 `feature_off`). `/api/reports` filters the list, `/api/me` returns `hiddenFeatures` and `hiddenNav`, and search skips hidden features.
- **Admin API:** `GET /api/features` and `PUT /api/features/:key` (`tenant.admin`).
- **Web:**
  - `useAuth().feature(key)`
  - the sidebar filters out hidden paths; the layout shows a "not available" page for them
  - the Quality page hides the FMEA and SPC tabs; Home hides news and policies; the asset page hides PM
  - Admin → Features (`/features`)

## 12aj. Production hardening (S22)

- **`platform/http/hardening.ts`**, registered before authentication so refused requests never reach the database:
  - request ids (`genReqId`: a well-formed incoming `X-Request-Id` or a UUID), echoed on every response; the auth hook adds `tenantId` and `userId` to the request logger; the 500 handler returns `requestId`
  - security headers on every response (`CSP` constant)
  - rate limits in fixed one-minute windows, per token for `/api` and per address for `/auth`, `/public` and failed sign-ins (`failedSignIn`, called by the auth hook); 429 `rate_limited` with `Retry-After`
  - `Metrics`: counters and a latency histogram keyed by route pattern (never by id), rendered in Prometheus text format
  - `/health`, `/ready` (migration `0048` lets the runtime role read `schema_migration`), `/metrics` (bearer `METRICS_TOKEN`)
- **Options:** `buildApp({ hardening })` overrides the limits and token; limits are off under `NODE_ENV=test` unless a test sets them.
- **Logging:** pino JSON at `LOG_LEVEL`, with authorization, cookie and set-cookie redacted. `TRUST_PROXY=1` takes the client address from `X-Forwarded-For` behind a load balancer.
- **`server.ts`:** graceful shutdown on SIGTERM and SIGINT.

## 12ak. Data retention (S23)

- **Migration `0049`:**
  - `tenant_retention` holds overrides per category; no row means the default
  - `retention_run` records each sweep with its counts
  - `import_batch.rows_purged_at`
- **`modules/retention/service.ts`:**
  - `CATEGORIES`, plus the `FIXED` and `KEPT` lists
  - `DUE`: one SQL fragment per category, used both to preview and to delete, so the screen and the sweep agree
  - `getRetention` and `setRetention` (`tenant.admin`, audited `retention.period_set`)
  - `runRetention(tenantId)`: deletes in one transaction on the owner pool with `tenant_id = $1` in each statement; then the idempotency purge; then the run record and a `retention.swept` audit (when anything was removed) through `withTx` as the company
- **Schedule:** `scripts/run-reminders.ts` calls the sweep after reminders and mail.
- **Imports:** a problems file for a purged import answers 410 `rows_removed`.
- **Web:** Admin → Data retention (`/retention`).

## 12al. Reminder settings (S25a)

- **Migration `0050`:** `tenant_reminder` holds `enabled`, `lead_days`, `repeat` and `editor_roles` per reminder; no row means the catalogue defaults.
- **`modules/reminders/catalogue.ts`:** `REMINDERS`, 30 entries. Each has a label, group, recipients, a trigger text with `{lead}`, lead limits, the repeats allowed, the owning permission and the feature.
- **`modules/reminders/settings.ts`:**
  - `sweepSettings()` gives the sweep `on(key)`, `lead(key)` and `period(key)`
  - `listReminders`, `setReminder` and `setReminderEditors` (audited)
  - `canEditReminder()` and `canEditAnyReminder()`; the latter feeds `/api/me` `remindersEditable`
- **`modules/notifications/reminders.ts`:**
  - each block is wrapped in `R.on()`
  - hard-coded windows become `R.lead()`
  - dedupe periods become `R.period()`
  - seven new blocks at the end
- **Tests:** `test/reminder-settings.test.ts` parses the sweep's source and asserts it matches the catalogue in both directions.
- **API:** `GET /api/reminder-settings`, `PUT /api/reminder-settings/:key` and `PUT /api/reminder-settings/:key/editors`.
- **Web:** Admin → Reminders (`/reminders`).

## 12am. Periodic reviews (S25b)

- **Migration `0051`:**
  - `tenant_reminder` gains `interval_months` and `escalate_days`; review kinds use keys `review:<kind>`
  - `record_review` is append-only (`SELECT` and `INSERT` only), with the outcome, note and the due date answered
  - `review_interval` holds a record's own frequency
- **`modules/reviews/catalogue.ts`:** `REVIEWS`, 13 kinds. Each has an SQL query returning id, number, title, facility, owners, base date, fixed due date and link. A test runs every query.
- **`modules/reviews/service.ts`:**
  - `reviewItems()` computes the due date and status per record
  - `listReviews`, `recordReview`, `setRecordInterval` and `reviewHistory`
  - `remindReviews()`, called at the end of the daily sweep
  - settings: `listReviewSettings` and `setReviewSetting`; `setReminderEditors` also accepts `review:` keys
  - continuity: `recordReview` delegates to `confirmReview`, and `defaultContinuityMonths` feeds `createPlan`
- **API:**
  - `GET /api/reviews?status&type`
  - `POST /api/reviews/:type/:id`
  - `PUT /api/reviews/:type/:id/interval`
  - `GET /api/reviews/:type/:id/history`
  - `GET` and `PUT /api/review-settings`
- **Web:**
  - Reviews (`/reviews`), under My day for anyone managing a reviewed kind
  - the Periodic reviews section of Admin → Reminders (`components/ReviewSettings.tsx`)

## 12an. Performance reviews (S26)

- **Migration `0052`:**
  - `employee.manager_employee_id`
  - `performance_settings`, one row per company; none means the programme is not set up
  - `performance_review`: `kind` is review or check_in; `status` runs open → shared → completed, or cancelled; unique per employee, kind and due date
  - `performance_goal`
  - the `performance.manage` permission, given to admin and hr_manager
- **`modules/performance/service.ts`:**
  - `nextReviewDue()` is pure and unit-tested: calendar or hire anchor, first review after hire, the cycle
  - `openDueReviews()` is idempotent and runs in the daily sweep whatever the reminder settings
  - `listPerformance`; `getReview`, which shapes what the employee sees by role
  - self-assessment, assessment, share, acknowledge, HR actions and goals
  - `performanceReminders()`
- **Visibility:** by role on the record (employee, reviewer, HR); others get `not_found`.
- **Imports:** the employees target maps "reports to" or "manager" to `manager_employee_number`. It orders managers before their reports, warns on unknown managers and refuses self-management.
- **Reminders:** `performance_due` and `performance_overdue`, with `leadKind: 'after'`.
- **Web:** Performance (`/performance`: tabs for my reviews, my team, and for HR everyone and settings) and `/performance/:id`.

## 12ao. SPC rule selection and alarm summary (S27)

- **Migration `0053`:**
  - `spc_signal.rule` allows the four optional rules
  - `spc_characteristic.rules` holds a characteristic's own set; NULL means the company's
  - `spc_settings` holds `rules` and `notify_each_alarm`
- **`spc/engine.ts`:**
  - `RULES` is the catalogue, with labels, the charts each rule applies to and its default; `DEFAULT_RULES`
  - `evaluate()` and `evaluateAttribute()` take the set of rules that are on and check the new patterns
- **`spc/service.ts`:**
  - `spcSettings`, `saveSpcSettings`, `setCharacteristicRules`
  - `rulesOf(c)` is applied when recording subgroups and marking charts
  - `alarmSummary()` and `summarySentence()`, shared by the API and the sweep
- **API:** `GET` and `PUT /api/spc/settings`, `PUT /api/spc/characteristics/:id/rules`, `GET /api/spc/summary?days&silentDays`.
- **Sweep:** an `spc_summary` block, one notification per site with active characteristics.
- **Web:**
  - the SPC tab gains an alarm summary (last day or 7 days) and a Rules panel
  - each characteristic gets a "rules for this characteristic" section

## 12ap. Store cap and ISO 9001 change management (S28)

- **Store cap (`0054`):**
  - `tenant_license.store_cap` (default 5, at most 5), with trigger `facility_store_licence` and `store_licence_usage()`
  - `storeLicence()` and a check in `saveSite`
  - `/api/licence` returns `stores`, and the Sites page shows the count against the cap
- **Change management (`0055`):**
  - `moc_change` gains `origin`, `consequences`, `qms_impact`, `resources`, `responsibilities`, `customer_impact`, `customer_note`, `outcome_achieved` and `effectiveness_note`
  - new action kinds `customer` and `consequence_review`
  - a constraint enforces the outcome on new closures (`NOT VALID`, so earlier closures stand)
- **`moc/service.ts`:**
  - `checkPlanning()` runs at submit
  - `generateActions()` adds customer and consequence-review actions
  - `closeChange(…, outcome)` requires an outcome and evidence, and a follow-up when the change missed its purpose
- **Approvals:** `ApprovalSubject.commentRequired` makes the engine refuse an approval without a comment; `moc_change` sets it. The queue returns `commentRequired`, and the Approvals card labels the field and disables Approve.
- **Report:** the change register gains Origin, an "Unplanned, 12 months" KPI, and outcome insights.
- **Docs:** `docs/ISO9001.md` is the clause map.

## 12aq. Justification presentation (S29)

- **Migration `0056`:**
  - `attachment.purpose` (`justification_presentation`)
  - `moc_change` becomes an attachment subject, required to carry that purpose
  - `moc_change.justification_link` (https)
- **`quality/attachments.ts`:**
  - `PRESENTATION_MIME` and a 25 MB limit for decks
  - only while the change is a draft or rejected; requester, owner or `moc.manage`
  - PowerPoint is served as a download
- **`moc/service.ts`:**
  - `setJustificationLink`
  - `getChange` returns `presentations` (newest first) and `canEditDeck`
- **Approvals:** the queue's change subject carries `has_presentation` and `justification_link`.
- **Web:** the "Justification presentation" block under Why on the change page, and a link on the approval card.

## 12ar. CAPA and 8D module (S30)

- **Migration `0057`:**
  - `corrective_action.action_type` (corrective or preventive; 8D only for corrective)
  - more sources: `spc`, `change`, `management_review`, `risk`
  - `origin_type` and `origin_id`: spc_signal, moc_change, fmea or quality_audit
- **`quality/service.ts`:**
  - `CAPA_SOURCES`, `CAPA_ORIGINS`
  - `capaOrigin()` returns a label and link
  - `createCapa` checks preventive rules and that the origin exists at the same site
  - `updateCapa` refuses 8D for preventive actions
  - `getCapa` returns `origin`
- **`modules/capa/dashboard.ts`:** `capaDashboard()`, served at `GET /api/capa-dashboard`.
- **Feature:** `capa` (nav `/capa`, area `capa-dashboard`).
- **Web:**
  - `pages/Capa.tsx`: the dashboard and open list, and `NewCapaModule` (`/capa/new`, taking `?type&source&origin=type:id&facility&title`)
  - the CAPA detail shows the type and its origin
  - links from SPC alarms and from changes that missed their purpose

## 12as. Business cases: opportunity pro forma (S32)

- **Migration `0064`:**
  - `proforma`: site or company-wide, number `PF-`, revision, kind, start month, horizon, discount and tax rates, working capital days, the `scenarios` JSON, status, and `approved_summary`
  - `proforma_line`: section, method, amount, qty, growth, start and end month, ramp, life
  - a trigger freezes lines unless the case is a draft
  - row-level security by site (company-wide cases have no site)
  - `proforma.view` and `proforma.manage` added to the default roles
- **`modules/proforma/engine.ts`** (pure, imported by both the server and the web page):
  - `project(lines, assumptions, scenario)` returns months, years, totals, NPV, IRR, payback, breakeven, peak funding and gross margin
  - `sensitivity()` ranks the drivers by NPV spread
  - `npvOf` and `irrOf` (bisection)
- **`modules/proforma/service.ts`:**
  - create (from example drivers, lines passed in, or nothing), save (header and all lines, draft only), get (results for all three scenarios, the sensitivity ranking and the answer), list
  - submit (one `finance_approver` step, comment required), `onProformaDecided` (approve freezes and stores `approved_summary`; reject returns it to draft), reopen (new revision; pending approval superseded), copy, archive
  - `baselineFromBooks` (a site's last 12 full months by income, cost-of-goods and expense account)
- **Routes:**
  - `GET/POST /api/proformas`
  - `GET /api/proformas/starter/:kind`
  - `GET /api/proformas/baseline?facilityId`
  - `GET/PUT /api/proformas/:id`
  - `POST /api/proformas/:id/{submit,reopen,copy,archive}`
- **Report:** `proforma-portfolio`.
- **Feature:** `proforma` (nav `/proforma`, area `proformas`).
- **Web:** `pages/Proforma.tsx`:
  - the list
  - `NewProforma`
  - `ProformaDetail`: scenario tabs, KPIs, cumulative cash and profit-by-year charts (the shared `ReportChart`), the profit and loss table by year, the sensitivity ranking, an editor that recalculates live with the same engine, reopen, and the approval trail

## 12at. Business case sources, revisions and comparison (S33)

- **Migration `0065`:**
  - `proforma_revision`: the header, lines and base-case summary of each closed revision, with the reason
  - `proforma_line.source`
- **`proforma/service.ts`:**
  - `reopenProforma` snapshots the closing revision
  - `compareProformas(refs)` takes two or three `{id, revision?}` and returns each plan's base-case summary and years, the differences in assumptions and lines, and the answer
  - `importSources(facilityId)` lists what is available, by permission
  - `importLines({source, facilityId, refId, startMonth})` reads from books, budget, opportunity, rent roll, asset (via `assetCostHistory`) or labor
- **Routes:**
  - `GET /api/proformas/compare?plans=id[:rev],…`
  - `GET /api/proformas/sources`
  - `POST /api/proformas/import-lines`
- **Web:**
  - `PullIn` in the editor
  - "Earlier revisions" on the case
  - `CompareProformas` at `/proforma/compare`
  - compare checkboxes on the list

## 12au. Server-side form drafts (S34)

- **Migration `0066`:** `form_draft`, keyed by `(tenant, user, key)`, with row-level security on `app_user_id()`, 256 KB per draft.
- **Server:**
  - `modules/drafts`: `GET/PUT/DELETE /api/drafts[/:key]`, up to 200 per person (the oldest make room)
  - retention category `form_drafts` (90 days)
- **Web:**
  - `components/Autosave.tsx`: `FormAutosave` is mounted once in the layout. It saves the values of each `main form`, debounced by 1 s, and restores them by dispatching input and change events so React state follows. It retries selects until their options load, and shows a note with Discard.
  - It clears a draft on `erp:saved`, an event `api.ts` fires after any successful change request, within 15 s of a submit or button press. Cancel also clears it.
  - It skips passwords, files, hidden fields, token- or secret-named fields and `[data-no-draft]`.
  - `useServerDraft(key, value, label)` serves model editors (the business case editor).
  - Home has an "Unsaved entries" card.

## 12av. Company archives and restore (S35)

- **Migration `0067`:**
  - `company_archive` (kind scheduled, manual or pre_rollback; blob key, sha256, size, counts, schema version)
  - `archive_settings` (interval 1 to 90 days, keep 1 to 120)
  - `company_rollback`: request and confirmation by different administrators (CHECK), one pending per company
- **`modules/archives/service.ts`:**
  - `createArchive` runs on the owner connection in REPEATABLE READ READ ONLY: one `json_agg` per tenant table, newline-free, written as a manifest line plus one line per table, gzipped into the blob store
  - `runArchives` (daily job) archives when due, prunes beyond `keep_count` (blob removed) and expires rollback requests after 24 h
  - `archiveRows` compares archived JSON with `to_jsonb` of the current row by primary key
  - `restoreRecords` upserts via `json_populate_recordset` with `ON CONFLICT (pk)`, follows foreign keys to child rows up to 4 levels, keeps every trigger and FK, and names the reference on a 23503
  - `requestRollback` and `confirmRollback`: pre-rollback archive; `SET LOCAL session_replication_role = replica`; delete then insert every tenant table outside `KEEP`; orphan clean-up of FKs in kept tables (null if nullable, else delete); abort if restored data is inconsistent; audit event after `origin`
- **KEEP:** app_user, api_token, user_role_assignment, role, audit_event, tenant_sequence, tenant_license, tenant_sso, sso_login, form_draft, idempotency_record (cleared), retention_run, notification_sent_key and the archive tables.
- **`BlobStore.remove`** added (the local adapter deletes the file).
- **Routes:**
  - `GET /api/archives`, `PUT /api/archives/settings`, `POST /api/archives`
  - `GET /api/archives/:id/{download,contents,rows}`
  - `POST /api/archives/:id/{restore,rollback}`
  - `POST /api/rollbacks/:id/{confirm,cancel}`
- **Daily job:** `scripts/run-reminders.ts` runs archives after retention.
- **Web:** `pages/Archives.tsx` (`/archives` and `/archives/:id`), under Admin, in every edition.

## 12aw. The document server (S37)

- **Migration `0069`:**
  - `document`: new kinds and CHECK; `origin`, `issuer`, `issuer_doc_number`, `description`, `folder_id`, `read_roles`, `status` (active or obsolete) and `pending_version_id`
  - `document_folder` (tree, `read_roles`)
  - `document_version`: `effective_on`, `issuer_revision`, `received_on`, `submitted_by` and `submitted_at`
  - the guard also freezes `effective_on` and `change_summary` once released; a no-delete trigger on versions
  - `document_promote_due()` promotes pending versions whose date has come (called on read)
- **`documents/service.ts`:**
  - `createDocument` (automatic numbers via `nextSequence('doc:<prefix>')`), `updateDocument`
  - `addVersion` (reason required from revision 2; issuer revision for external)
  - `submitVersion`: approval request with stage 1 reviewers and stage 2 approver, as assignee steps; approver ≠ author and holds `documents.approve` at the site
  - `onDocumentDecided` (handler `document_version`), then `release()`: immediate, or pending until `effective_on`
  - `approveVersion` (one step, author excluded), `withdrawVersion`, `discardDraft`, `obsoleteDocument`
  - `readRolesOf` (document, else nearest folder) enforced in `getDocument`, `searchDocuments` and `downloadVersion`; every download audited
  - `repositoryOverview`, `saveFolder`, `documentPeople`
- **Visibility.** Without `documents.view_draft`, a reader sees only `approved` versions whose `effective_on` has come.
- **Routes:**
  - `GET /api/document-repository`, `GET /api/document-people`, `POST /api/document-folders`
  - `PATCH /api/documents/:id`, `POST /api/documents/:id/obsolete`
  - `GET /api/document-versions/:id`
  - `POST /api/document-versions/:id/{submit,approve,withdraw,discard}`
- **Report:** `document-master-list`.
- **Web:** `pages/Documents.tsx`: `Repository` (`/documents`), `NewDocument` (`/documents/new`), `Manage` panel on `DocumentView`, and `DocumentVersionRedirect` (`/documents/version/:id`, the target of approval links).

## 13. Web app

`web/` is a React 18 + TypeScript app built with Vite, served by the API server from `web/dist`. Unknown paths without a file extension get the app shell, so client-side routes and QR links (`/a/<qr token>`) work.
- **Data access:** a thin fetch client sends the bearer token, and `useApi()` / `useAction()` hooks handle loading, error and busy states. There is no client-side business logic. The server enforces every rule, and the UI shows the server's message (e.g. "not qualified to maintain this asset: Q-SPN (revoked)").
- **Navigation:** the intranet shell (§12v): a sidebar grouped by area, showing only what the user may open, with badges (approvals, notifications) refreshed on every navigation; a drawer on phones; search in the top bar.
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

- Built for it (D-150): `/health` for liveness, `/ready` for readiness, `/metrics` for the platform's scraper, JSON logs to standard output, `X-Request-Id` passed through, graceful shutdown on SIGTERM.

- Container image run on a managed platform (e.g. AWS ECS/Fargate or Fly/Render for pilots) with managed PostgreSQL (RDS/Aurora, PITR backups) and S3-compatible object storage.
- Two database roles: the migration owner (CI/CD only) and `erp_app` (runtime). Secrets come from the platform secret manager.
- Large imports and exports move to a job queue (Postgres-based such as pg-boss to avoid new infrastructure). Jobs run through `withTx` with an explicit tenant.

## 17. Known limitations

- Auth is development-grade bearer tokens (D-008). There is no UI yet: an API plus print/PDF outputs only (D-011).
- Import processing is synchronous, with a 50,000-row limit per file. Very large migrations need the job queue.
- User-supplied regex in mapping transforms runs on V8's linear-time fallback; backreferences and lookaround are refused (D-152, `platform/safe-regex.ts`).
- Part costs and quantities use JavaScript numbers (fine for operational costing). A decimal library is needed before any financial posting.
