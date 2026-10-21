# Build log

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
