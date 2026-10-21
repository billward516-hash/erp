# Decision log

Status key: **Approved** = founder decision in the brief · **Adopted (provisional)** = chosen by the implementation lead to unblock work, reversible, needs founder confirmation · **Open** = unresolved.

| ID | Decision | Status | Rationale / notes |
|---|---|---|---|
| D-000 | Product boundary: Category 1 / Category 2 / integration-only / excluded, as in brief §12 | Approved | Recorded in `PRODUCT_SCOPE.md`. End-state approval is not a release commitment |
| D-001 | Greenfield build rather than extending Odoo/ERPNext | Adopted (provisional) | Repository was empty. Extending an open-source ERP buys breadth but brings its tenancy model (database-per-tenant in Odoo), licensing (LGPL/AGPL implications for SaaS changes), and UX that the brief positions against. Asset-, LMS- and import-centric differentiation is easier greenfield. **Revisit** if time to a broad ERP launch becomes the priority |
| D-002 | Modular monolith, single PostgreSQL database | Adopted (provisional) | Per brief §13.2. Module boundaries live in code. Split only when measured need appears |
| D-003 | TypeScript / Node 22 / Fastify / PostgreSQL 16 / Zod / Vitest | Adopted (provisional) | See ARCHITECTURE §1 table. No stack existed to preserve |
| D-004 | Shared-schema multi-tenancy enforced by PostgreSQL row-level security with a non-owner runtime role | Adopted (provisional) | Isolation holds even if a service forgets a filter, and background jobs fail closed (zero rows). Database-per-tenant rejected for ops cost at the $499 price point |
| D-005 | Facility scope enforced in RLS as well as services; corporate access = role assignment with no facility | Adopted (provisional) | Meets "authorized facility and consolidated views" (§12.2) |
| D-006 | Append-only, per-tenant hash-chained audit log written in the same transaction as each change | Adopted (provisional) | Tamper-evident (§6). Verification endpoint provided. External anchoring (e.g. periodic hash export) is a later hardening option |
| D-007 | First vertical slices = tenant/facility RBAC + asset registry + equipment-linked controlled documents + corrective work orders + audit + customer data import + 2 reports | Adopted (provisional) | Brief §13.3 suggestion, extended with data onboarding because the founder asked for flexibility with prospects' existing data formats. LMS qualification is the next slice (S2) |
| D-008 | Development auth = hashed bearer tokens. Production auth = external OIDC/SAML identity provider | Open | Provider choice (WorkOS, Auth0, Entra ID, Cognito, Keycloak) is a blocking question before pilot |
| D-009 | Customer data onboarding through a declarative mapping + staging + commit pipeline that reuses domain services | Adopted (provisional) | Mapping profiles are data, not code, so they are safe to store per tenant and edit in a UI. Imported data obeys the same rules and audit as UI-entered data |
| D-010 | Employee table holds directory data only; HR-sensitive data (pay, assessment results, evidence) in separate restricted tables | Adopted (provisional) | §6, §13.2 |
| D-011 | API-first; web UI not started in this slice | Adopted (provisional) | Proving the security model, data model and onboarding first. UI framework proposal: React + TypeScript sharing Zod schemas. Needs founder agreement |
| D-012 | Utilization from recorded state intervals; unrecorded time is reported, never assumed; no OEE until performance/quality data is validated | Adopted (provisional) | §4.1, §15.2.4 |
| D-013 | Reporting: one computed result → many renderers (JSON/CSV/HTML print/PDF now; XLSX next; PPTX/DOCX deferred) | Approved (principle) / Adopted (implementation) | §15.3 |
| D-014 | Legacy work-order history import never overwrites; blank import cells never erase existing values | Adopted (provisional) | Protects history and avoids accidental data loss on partial exports |
| D-015 | Pricing, seat model, add-on packaging | Open | Out of scope for code. Entitlements per facility+module are implemented so any packaging can be enforced |
| D-016 | First pilot customer profile (industry, size, sites) | Open | Affects which slice follows S2 (PM/inventory vs purchasing) |
| D-017 | PM kits: physical, virtual, or both | Open | Data model keeps reference BOM vs actual consumption separate, so either works |
| D-018 | Hosting provider / region / compliance targets (SOC 2 timing) | Open | |
| D-019 | Qualification gating is a hard block on restricted equipment (assign, start, labor), with no override in this release | Adopted (provisional) | Brief §13.4: validity is checked before restricted assignments. An audited emergency-override flow can be added if pilots need it |
| D-020 | Legacy qualification records can be imported, marked origin=import, and need `qualifications.grant` to commit | Adopted (provisional) | Without this a customer would have to re-train everyone on day one. Reports label these records as legacy |
| D-021 | Document revisions open a training review; retraining is a human decision, and grants are never auto-revoked | Approved (principle, brief §12.3.7) / Adopted (mechanics) | |
| D-022 | Assessments: server-side grading, multi-select all-or-nothing, answer key never returned to learners, attempt limit per enrollment | Adopted (provisional) | Partial credit on safety content would reward guessing |
| D-023 | Practical evaluations need a written attestation by someone other than the learner. Grants need someone other than the grantee | Adopted (provisional) | Separation of duties for safety-critical authorization |
