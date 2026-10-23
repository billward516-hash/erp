# SC-001 Management of change (MOC)

**Requested by:** founder, 2026-10-21 ("We didn't scope in management of change but we'd better").
**Status:** scope addition approved by the founder in principle. Category placement and packaging below are proposals to confirm.
**Gate:** brief §12.9, items (a)–(g).

## (a) Target customer and workflow
Manufacturers and machine shops changing equipment, operating limits, materials and chemicals, controls software, procedures or staffing, and anyone who must show that those changes were reviewed before use. The workflow:
1. Request (anyone on the floor).
2. Screening questions decide risk, the reviewing disciplines, and whether a pre-startup safety review is required.
3. Cross-functional review, then authorization.
4. Implementation actions: document revisions, training, work orders, hazard review, tests.
5. Pre-startup safety review (PSSR) and startup sign-off.
6. In service, closeout, and expiry tracking for temporary changes.

## (b) Measurable value
- **Changes are visibly controlled.** Unreviewed changes are a leading cause of equipment damage, quality escapes and injuries.
- **Audit evidence without a separate system.** ISO 9001:2015 §8.5.6 requires controlling changes, and IATF 16949 extends this. OSHA PSM (29 CFR 1910.119(l) and (i)) requires MOC and PSSR at covered sites.
- **Measures we can track:** temporary changes past their end date, overdue change actions, and the share of changes with training or document updates verified before startup.

## (c) Reused entities and workflows
Assets, controlled documents, courses and training assignments, qualifications, work orders, parts, audit chain, RBAC and facility scoping, and the reporting service. New pieces:
- **Shared approval engine** (`approval_request` / `approval_step`): stage-ordered, role-addressed, with separation of duties and supersede-on-material-change. Purchasing (S5) reuses it as is.
- **MOC tables:** `moc_change`, `moc_affected`, `moc_action`, `moc_pssr_item`.

## (d) Implementation and ongoing cost
- **Build:** about 1 week, done in this slice (migration 0006, approval engine, MOC module, report, tests, seed).
- **Ongoing:** low. The screening rules and PSSR checklist are versioned code and need occasional review. No regulatory content is maintained: we provide the workflow, and the customer owns its procedure.

## (e) Usability and implementation impact
- One screening form with nine yes/no questions. The action plan is generated from the answers and the affected items, so coordinators edit rather than start from scratch.
- **New stock roles** (EHS reviewer, quality reviewer, operations manager) must be assigned during onboarding. Small sites can give one person several roles. Separation of duties still requires two different signers per request.

## (f) Native vs integration vs defer
- **Native:** the core MOC workflow. It is tightly coupled to native documents, training and work orders, and integrating a separate MOC tool would lose the automatic verification of actions.
- **Deferred:** PSM-grade packs (P&ID redline management, process safety information registers, PHA software integration), customer/PPAP change notification portals, configurable screening questionnaires per tenant, MOC analytics.

## (g) Dependencies and test plan
- **Dependencies:** documents, learning, maintenance and RBAC roles (all built).
- **Tests** (`test/moc.test.ts`, `test/api-reports.test.ts`):
  - deterministic screening
  - stage order, role membership, no self-approval, distinct signers, final decisions
  - material change voids approvals and requires re-approval
  - action verification against document, training and work-order records
  - startup blocked by open actions and by any failed PSSR item; startup sign-off
  - temporary-change restore action cannot be dropped; temporary duration capped at 180 days
  - rejection requires a reason and returns the change for rework
  - facility scoping, HTTP flow, register report

## Proposed placement
- **Category 1 (Quality, Safety & Risk):** core MOC (request, screening, reviews and authorization, action plan with verification, PSSR, temporary changes, register report). This is the basic control ISO 9001 users need, and it makes the existing document, training and work-order data more valuable.
- **Category 2:** PSM-grade packs and the deferred items in (f).
