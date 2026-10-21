# Architecture

Status: **Phase 0 foundation + first vertical slice implemented** (see `BUILD_LOG.md`). Everything marked *future interface* is documented here so later slices fit without rework, but is deliberately **not built**.

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
| Part | `part` | Master only; stock arrives with Inventory |
| MaintenanceRequest, WorkOrder (+assignment, labor, part lines, pinned procedures) | `maintenance_request`, `work_order*` | Reference (planned) vs actual consumption on each part line; substitutions recorded |
| AuditEvent | `audit_event` | See §2 |
| Import profile, batch, row, external reference | `import_*`, `external_ref` | See §4 |

### Future interfaces (designed, not built)

| Entity | Will attach to | Key rule already respected |
|---|---|---|
| Course, CourseVersion, LearningEvent, Enrollment, Assessment, Attempt, Evidence | `document` (same versioned source), `employee` | `approveVersion()` already returns impacted links. Retraining review will consume them. Nothing is rewritten silently |
| Qualification, Certification | `employee`, `asset` (required qualification per asset/task) | Hook point: `assignTechnician()` (maintenance/service.ts). Completion ≠ qualification. The states completed / passed / verified / authorized / issued stay distinct |
| InventoryTransaction, StockLocation | `part`, `functional_location(kind=storeroom)`, `work_order_part` | `qty_used` on WO part lines becomes an issue transaction |
| Supplier, PurchaseRequest, PO, Approval | `part`, `work_order` | Shared approval engine. No auto-purchasing without approval |
| PM plan / PM kit | `asset`, `part`, `work_order(wo_type='preventive')` | The kit BOM is a reference list. Actual consumption stays on WO part lines |
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

## 5. Reporting and output (Section 15 of the brief)

A single shared service: a **report definition** computes one `ReportResult` (answer-first headline, KPIs with status, 3–5 insights, typed columns with units, rows, exception rows, drill-down path, definitions and notes, source, scope, filters and period). Renderers consume that same result, so **JSON, CSV, HTML print and PDF always show the same numbers** (tested).

- Design tokens live in `reporting/render/format.ts` and are shared by HTML and PDF. Status is shown with text labels, not color alone. Missing values render as "—" with a footnote and are never zero.
- CSV neutralizes formula injection, adds a BOM for Excel, and by default prepends a metadata block (`raw=1` for data only).
- Exports require `reports.export` and are audited with their filters. Scope is limited to facilities where the user holds `reports.view`, and RLS enforces the same boundary.
- Implemented reports: **Maintenance backlog** and **Asset availability & utilization**. XLSX is the next shared adapter. PPTX/DOCX are deferred per the brief.

**Utilization definitions** (`assets/utilization.ts`, unit-tested):
- scheduled = recorded − planned downtime − out-of-service
- availability = (scheduled − unplanned) ÷ scheduled
- utilization = running ÷ scheduled (or ÷ calendar, configurable)
- coverage = recorded ÷ calendar

Unrecorded time is never assumed to be running, and assets below a coverage threshold get no ratios. OEE is intentionally not computed until performance and quality data are validated.

## 6. Integrations (planned approach)

External systems of record stay external: GL/accounting, payroll, payments, e-sign and tax. Each integration will be an adapter module with:
- explicit system-of-record ownership per field
- an outbox table written in the same transaction as the domain change
- idempotency keys
- a retry/reconciliation queue
- clearly labeled mock adapters for local development.

The import framework's `external_ref` crosswalk is the same mechanism integrations will use for ID mapping.

## 7. Runtime and deployment (proposed, not yet built)

- Container image run on a managed platform (e.g. AWS ECS/Fargate or Fly/Render for pilots) with managed PostgreSQL (RDS/Aurora, PITR backups) and S3-compatible object storage.
- Two database roles: the migration owner (CI/CD only) and `erp_app` (runtime). Secrets come from the platform secret manager.
- Large imports and exports move to a job queue (Postgres-based such as pg-boss to avoid new infrastructure). Jobs run through `withTx` with an explicit tenant.

## 8. Known limitations of this slice

- Auth is development-grade bearer tokens (D-008). There is no UI yet: an API plus print/PDF outputs only (D-011).
- Import processing is synchronous, with a 50,000-row limit per file. Very large migrations need the job queue.
- User-supplied regex in mapping transforms is length-limited but not time-boxed. Run transforms in a worker with a timeout before opening profile editing to untrusted users.
- Part costs and quantities use JavaScript numbers (fine for operational costing). A decimal library is needed before any financial posting.
