# Integrated Business Operating Platform

A cloud ERP/CMMS/LMS platform for small and midsize manufacturers, built as a TypeScript modular monolith on PostgreSQL. `docs/BRIEF.md` is the master scope. This repository currently contains the **Phase 0 foundation and the first vertical slice**:

- **Multi-tenant security**: tenant → legal entity → facility hierarchy, isolation enforced by PostgreSQL row-level security, facility-scoped RBAC with corporate (consolidated) roles, and a tamper-evident hash-chained audit log.
- **Asset registry**: equipment, component hierarchy, functional locations, state history, and utilization/availability with honest data-coverage handling.
- **Controlled technical documents**: versioning, approval with separation of duties for safety-critical documents, immutable released versions, links to assets and work orders, search, and restricted access.
- **Corrective maintenance**: request → work order → technician assignment → pinned procedure version → labor and parts (planned vs actual, substitutions) → independent verification with return to service → close.
- **Internal LMS and qualifications**: courses mix video, classroom, self-study, on-the-job shadowing, graded quizzes and observed practical evaluations. Completion, a passed assessment, verified competency, authorization and a certificate are recorded as separate states. Work orders refuse technicians who lack a current qualification for the equipment. A procedure revision opens a training review instead of silently reassigning training.
- **Management of change**: change requests are screened into a risk level and review route, signed off through a shared approval engine (staged, role-based, no self-approval, re-approval after material changes), and implemented through an action plan the platform verifies against document, training and work-order records. Includes pre-startup safety review, temporary changes with expiry, and a change register.
- **Preventive maintenance and storerooms**: calendar and meter-based PM plans that generate work orders without duplicates and move forward when the work is verified. Storerooms with an append-only stock ledger: receipts, issues and returns on work orders, transfers, adjustments and cycle counts. Includes PM compliance and parts-to-reorder reports.
- **Purchasing**: suppliers and price lists, purchase requests approved by amount and spend type through the shared approval engine (with delegation and re-approval after changes), purchase orders capped at the approved amount (+10%), printable POs, and receiving into storerooms. Work orders and the reorder report draft requests for what is missing.
- **Accounts payable and accounting sync**: supplier invoices captured from the order (with the scanned file), checked against what was received, approved by a second person, and aged by due date. Approved bills go to the accounting system through an outbox with idempotent, retried delivery and a reconciliation queue; payment status comes back. Today's connectors: a generic CSV export and a clearly labeled MOCK accounting system. The QuickBooks Online / Xero connector waits on the pilot's choice.
- **Time and payroll export**: weekly timesheets where work-order hours appear automatically, supervisor approval with locking, overtime flagged for review, and a payroll-ready CSV with the provider's earning codes. A time and labor report includes wrench time.
- **Notifications**: approvers are told when something reaches their stage, requesters when it is decided, technicians when work is assigned or parts arrive. A daily sweep reminds people about PM, overdue work, training, expiring qualifications, late orders, invoices and timesheets. Each person can mute kinds and opt into a daily email digest (development mail adapter only so far).
- **Customer data onboarding**: CSV/XLSX/JSON in any reasonable shape. Auto-mapping and saved declarative profiles feed a dry-run staging step, then commit. See [`docs/DATA_ONBOARDING.md`](docs/DATA_ONBOARDING.md).
- **Reporting service**: one computed result rendered as JSON, CSV, print HTML and PDF, with answer-first headlines.
- **Sample data**: two fictional companies, loaded through the import pipeline from deliberately messy sample files.

- **Web app** (React): home dashboard, assets with QR deep links, technician work-order execution, approvals inbox, change requests with screening and pre-startup review, training with quizzes and evaluator sign-off, PM schedule and plans, storerooms (stock, ledger, receiving, cycle counts), purchasing (requests, orders, suppliers, receiving, delegation), payables (invoice capture, approval, payment status), accounting connection (sync queue, file downloads, account mapping), timesheets (my week, team approvals, payroll export), reports with CSV/PDF export, and the data import wizard. Works at phone width.

Not built yet: production SSO, a QuickBooks Online / Xero connector (waits on the pilot's system), a payroll-provider connector (waits on the pilot's provider), sales/CRM. See [`docs/ROADMAP.md`](docs/ROADMAP.md).

## Quick start

Requires Node 22+ and PostgreSQL 16 binaries. `scripts/dev-db.sh` starts a local cluster on port 54329 without Docker.

```bash
npm install
npm run db:start      # local PostgreSQL cluster in ./.pgdata (databases erp, erp_test)
npm run seed          # RESETS the dev db, migrates, loads sample tenants, prints API tokens
npm run web:build && npm start   # API + web app on http://localhost:3000 (sign in with a dev token)
# or, while developing: `npm run dev` (API :3000) and `npm run web:dev` (UI :5173 with hot reload)
npm test              # typecheck with `npm run typecheck`; tests run against erp_test
npm run ui:smoke      # drives the built UI as several demo users (needs a freshly seeded running server; BASE_URL)
npx tsx scripts/run-sync.ts        # one accounting sync for every tenant with a connection (schedule it, e.g. every 5 min)
npx tsx scripts/run-reminders.ts   # daily reminders + email digest (development mail adapter: .storage/mail/*.eml)
```

`npm run seed` writes dev tokens to `.storage/dev-tokens.json`. Users are Dana (admin, all facilities), Jordan (EHS reviewer), Alex (operations manager), Sam (quality reviewer), Marcus (maintenance manager, Dayton), Sean (manager, Fort Wayne), Kim (buyer), Ana (accounts payable clerk), Lena (payroll administrator), Morgan (finance approver), Priya, Thi and Luis (technicians), Tolu (operator), an executive with read-only consolidated access, and an admin of a second tenant for isolation checks.

```bash
TOKEN=$(node -e "console.log(require('./.storage/dev-tokens.json')['marcus (maintenance manager, DAY)'])")
curl -H "Authorization: Bearer $TOKEN" localhost:3000/api/assets?q=HMC
curl -H "Authorization: Bearer $TOKEN" "localhost:3000/api/reports/asset-availability?format=pdf" -o availability.pdf
curl -H "Authorization: Bearer $TOKEN" "localhost:3000/api/reports/maintenance-backlog?format=csv"

# Try the importer on any file: get a mapping suggestion, then stage a dry run
B64=$(base64 -w0 samples/imports/northgate/assets.csv)
curl -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d "{\"target\":\"assets\",\"fileName\":\"assets.csv\",\"contentBase64\":\"$B64\"}" localhost:3000/api/imports/suggest
```

## API overview

| Area | Endpoints |
|---|---|
| Identity / org | `GET /api/me`, `GET /api/facilities`, `GET/POST /api/employees`, `GET /api/audit/verify` |
| Assets | `GET/POST /api/assets`, `GET/PATCH /api/assets/:id`, `GET /api/assets/qr/:token`, `POST /api/assets/:id/state`, `GET /api/assets/:id/utilization?from&to&basis`, `GET /api/assets/:id/history` |
| Documents | `GET/POST /api/documents`, `GET /api/documents/:id`, `POST /api/documents/:id/versions` (raw body), `POST /api/document-versions/:id/approve`, `GET /api/document-versions/:id/download`, `POST /api/documents/:id/links` |
| Maintenance | `POST /api/maintenance-requests`, `GET/POST /api/work-orders`, `GET /api/work-orders/:id`, `POST /api/work-orders/:id/{transition,assignments,labor,parts,procedures}` |
| Parts | `GET/POST /api/parts` |
| Inventory | `GET/POST /api/stock-locations`, `GET /api/inventory?facilityId&locationId&partId&q&belowReorder`, `GET /api/inventory/ledger`, `POST /api/inventory/{receipts,adjustments,transfers}`, `PUT /api/inventory/settings`, `GET/POST /api/inventory/counts`, `GET /api/inventory/counts/:id`, `POST /api/inventory/counts/:id/{lines,post}`, `POST /api/work-order-parts/:id/return` |
| Purchasing | `GET/POST /api/suppliers`, `GET/PATCH /api/suppliers/:id`, `PUT /api/suppliers/:id/parts/:partId`, `GET/POST /api/purchase-requests`, `POST /api/purchase-requests/from-reorder`, `GET/PATCH /api/purchase-requests/:id`, `POST /api/purchase-requests/:id/{submit,cancel,order}`, `POST /api/work-orders/:id/purchase-request`, `GET /api/purchase-orders`, `GET /api/purchase-orders/:id[/pdf]`, `POST /api/purchase-orders/:id/{receive,cancel}`, `GET/POST /api/purchase-approval-rules`, `GET/POST /api/approval-delegations`, `POST /api/approval-delegations/:id/revoke`, `GET /api/users` |
| Payables | `GET/POST /api/supplier-invoices`, `GET /api/supplier-invoices/:id[/file]`, `POST /api/supplier-invoices/:id/{approve,dispute,void,due-date,payment}`, `GET /api/purchase-orders/:id/invoice-draft` |
| Accounting sync | `GET/POST /api/integrations`, `POST /api/integrations/:id/disconnect`, `POST /api/integrations/sync`, `GET /api/integrations/:id/{deliveries,files}`, `POST /api/sync-deliveries/:id/{retry,resolve}`, `GET /api/export-files/:id`, `GET /api/account-mappings`, `PUT /api/account-mappings/:key`, MOCK only: `GET /api/integrations/:id/mock/bills`, `POST /api/integrations/:id/mock/{pay,outage}` |
| Time | `GET /api/timesheets/mine`, `POST /api/timesheets/open`, `GET /api/timesheets/team?weekStart`, `GET /api/timesheets/:id`, `POST /api/timesheets/:id/{entries,submit,decide,reopen}`, `DELETE /api/time-entries/:id`, `GET/PATCH /api/earning-codes[/:code]`, `GET /api/payroll/preview`, `GET/POST /api/payroll/exports`, `GET /api/payroll/exports/:id` |
| Notifications | `GET /api/notifications`, `GET /api/notifications/unread-count`, `POST /api/notifications/read`, `GET/PUT /api/notification-preferences` |
| Preventive maintenance | `GET/POST /api/pm`, `GET /api/pm/:id`, `POST /api/pm/:id/active`, `POST /api/pm/generate`, `POST /api/assets/:id/meters` |
| Imports | `GET /api/imports/targets`, `POST /api/imports/suggest`, `POST /api/imports/stage`, `GET /api/imports/:id`, `POST /api/imports/:id/commit`, `POST /api/imports/:id/cancel`, `GET /api/imports/:id/problems.csv`, `GET/POST /api/import-profiles` |
| Learning | `GET/POST /api/courses`, `GET /api/courses/:id`, `POST /api/courses/:id/versions`, `POST /api/course-versions/:id/{events,publish}`, `POST /api/training/assign`, `GET /api/enrollments?mine=1`, `GET /api/enrollments/:id`, `POST /api/enrollments/:id/events/:eventId/complete`, `GET …/assessment`, `POST …/attempts`, `POST /api/enrollments/:id/evidence`, `GET/POST /api/training-reviews[/:id/decide]` |
| Qualifications | `GET/POST /api/qualifications`, `GET /api/qualifications/:id/eligibility?employeeId`, `POST /api/qualifications/:id/grant`, `POST /api/qualification-grants/:id/{revoke,certificate}`, `GET /api/certificates/:id/pdf`, `GET /api/employees/:id/qualifications`, `POST /api/employees/:id/credentials`, `PUT/DELETE /api/assets/:id/requirements`, `GET /api/assets/:id/qualified` |
| Change & approvals | `GET/POST /api/moc`, `GET /api/moc/screening-questions`, `GET/PATCH /api/moc/:id`, `POST /api/moc/:id/{submit,actions,startup,pssr,close,cancel}`, `POST /api/moc-actions/:id/{complete,cancel,work-order}`, `GET /api/approvals/queue`, `POST /api/approvals/steps/:id/decide` |
| Reports | `GET /api/reports`, `GET /api/reports/:id?format=json\|csv\|html\|pdf&…filters` |

## Repository map

```
db/migrations/        SQL schema, RLS policies, triggers
src/platform/         db scoping, auth/RBAC, audit, storage, tenancy provisioning
web/                  React web app (Vite); built to web/dist and served by the API server
src/modules/          org, assets, documents, maintenance, parts, inventory, pm, purchasing, ap, integrations, time, notifications, learning, moc, approvals, imports, reporting
scripts/              dev-db.sh, seed.ts, generate-samples.ts
samples/              fictional customer files + saved mapping profiles + demo documents
test/                 unit, security/isolation, maintenance workflow, import, API/report tests
docs/                 BRIEF, PRODUCT_SCOPE, ARCHITECTURE, DATA_ONBOARDING, DECISIONS, ROADMAP, BUILD_LOG
```

All companies, people, serial numbers and documents in `samples/` are fictional demo content, not OEM material or validated procedures.
