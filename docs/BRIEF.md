# Integrated Business Operating Platform — Product Scope & Claude Discovery Brief

**Version:** 2.1 — October 21, 2026  
**Status:** Approved provisional end-state scope and scope-control policy; implementation details and release commitments remain subject to validation  
**Audience:** Claude Opus 5 (implementation lead), founder, engineering contributors

> **Instruction to Claude Opus 5 — BEGIN IMPLEMENTATION:** This is the product's master scope brief. Read **Section 12 (approved scope amendment)**, **Section 13 (build execution protocol)**, and **Section 15 (approved reporting and presentation standard)** first: they override conflicting earlier proposals. Begin by auditing the repository and existing assets, identifying the smallest coherent vertical slice, producing a dependency-aware implementation plan, and then implementing that slice with tests. Ask at most five **blocking** questions at a time; do not hold all progress for nonblocking product decisions. Never interpret end-state scope as permission to build everything immediately. Do not invent existing integrations, test results, or production readiness. Preserve a decision log and show working code, migrations, tests, and setup instructions as progress is made.

## 1. Product thesis

Build a configurable, cloud-hosted, integrated business operating platform for small and midsize businesses. It combines ERP, CRM, operational finance workflows, workforce operations, asset utilization and maintenance, document management, quality/compliance, and business intelligence. The design goal is enterprise-grade operational usefulness at a much lower total cost of ownership, with guided self-implementation or a small vendor implementation team.

**Core commercial philosophy:** Customers should not pay for modules they do not need. The base subscription should include a generous, coherent set of high-frequency workflows and feel substantially more valuable than its price. Specialized or intensive capabilities are separately priced, with transparent limits and no surprise fees. Shared data, document storage, permissions, audit trails, and workflows remain consistent across modules.

**Competitive position:** Not a feature-for-feature NetSuite replacement at launch. Compete on integrated operational workflows, usability, rapid deployment, value, and workforce/asset intelligence. Initially rely on external providers for general ledger, payroll processing, payment movement, and e-signatures.

## 2. Target market and constraints

- Initial focus hypothesis: US-based manufacturers, machine shops, fabricators, industrial services, and distributors; approximately 10–150 employees and $1M–$30M revenue. Validate these boundaries.
- Limited internal IT resources; fragmented spreadsheets and point solutions.
- Cloud SaaS; strong tenant isolation, permissions, auditability, backup/recovery, encryption, and secure integrations.
- Basic onboarding should be self-guided. Complex manufacturing, finance, and workforce migrations may require assisted implementation.
- **Target base price:** approximately **$499/month per company**. Per-user pricing and add-on pricing remain hypotheses, not commitments.
- No independent payroll tax filing, check issuance/direct deposit, payment processing, or full general ledger in the initial release.

## 3. Packaging strategy: base + optional modules

### Important qualification of the “50%” requirement

The goal is to put **up to approximately half of the most commonly used, high-frequency functional capabilities** into a broadly useful base tier, **not** to arbitrarily include 50% of every module's feature count. Feature counts are a poor proxy for customer value. Validate the common workflows using customer interviews, usage research, and willingness-to-pay testing. The matrix below is an **initial hypothesis**, not an empirical ranking.

### Base platform — proposed $499/month

Includes foundational services plus a coherent daily operating backbone:

1. **CRM and sales essentials:** companies/contacts, leads/opportunities, activities, standard quotes/proposals, basic sales orders.
2. **Procure-to-pay essentials:** purchase requests, configurable multi-level approvals **before PO generation**, PO creation/release, supplier directory, receiving, basic invoice capture, AP status and due-date tracking; integration/export to external accounting/payment systems.
3. **Order-to-cash essentials:** customer orders, standard invoices, payment status, reminders, AR aging, payment links or payment-provider connection, basic collections queue.
4. **Inventory essentials:** item master, units of measure, stock locations, receipts/issues, adjustments, reorder alerts, basic counts.
5. **Workforce essentials:** employee directory, organization structure, basic schedules/availability, employee self-service, basic time capture and approvals; payroll-ready export (subject to supported provider/format).
6. **Asset essentials:** asset register, location/owner, status, basic downtime and utilization logs, corrective maintenance requests, basic repair work orders, simple preventive-maintenance calendar and reminders.
7. **Documents and controls:** document attachments to records (contracts, NDAs, quotes, POs, invoices, manuals), search, basic versioning, role-based permissions, audit trail, notifications, shared approval engine.
8. **Management essentials:** standard KPI dashboards, operational reporting, saved views, CSV imports/exports, standard integration connectors (provider costs excluded).

**Illustrative included capacity, to validate:** five full users; a reasonable allowance of employee self-service/read-only users, document storage, transactions, and automation runs. Do not market unlimited usage unless unit economics support it. Pricing must avoid double-billing one employee across user categories.

### Optional add-on modules (candidate packaging, not final SKU list)

| Add-on | Higher-value capabilities | Why separate? |
|---|---|---|
| **Advanced Asset Performance & CMMS** | Utilization/OEE where appropriate, asset capacity/load, MTBF/MTTR, condition monitoring, downtime reason codes, PM optimization, advanced work order routing, technician dispatch, maintenance labor/cost analysis | Maintenance-intensive businesses need depth; others do not |
| **Maintenance Materials & PM Kits** | Equipment BOMs, repair BOMs, PM BOMs, PM kit templates, kit assembly/reservation/staging, shortages, substitutions, serial/lot traceability, consumption and returns, replenishment from approved PR/PO workflows | Inventory and maintenance sophistication varies |
| **Manufacturing & MRP** | BOMs/routings, production work orders, material requirements, capacity and constraint planning, production scheduling, WIP, scrap/rework, job costing | Manufacturing-specific complexity |
| **Advanced Workforce & Talent** | Performance reviews, goals, competency matrices, certifications, training evidence, career ladders, promotion readiness, succession, compensation planning | High value for skilled-workforce customers |
| **Advanced Time & Labor** | Shift differentials, overtime rules by jurisdiction, PTO accrual policies, exception management, job labor allocation, complex scheduling, provider-specific payroll sync | Labor law and integration complexity |
| **Quality & Compliance** | Controlled SOPs, revision-to-training, NCR, CAPA/8D, FMEA, audits, inspections, calibration, ISO-oriented evidence, OSHA recordkeeping support, compliance calendar | Specialized and requires maintained rules/content |
| **Advanced Finance Operations** | Three-way match and exception routing, recurring/milestone billing, automated collections, cash forecasting, budget/commitment controls, advanced payment reconciliation, vendor/customer portals | More intensive transaction and control workflows |
| **Contracts & Document Intelligence** | Contract lifecycle, clause/obligation extraction, renewals, legal review routing, advanced retention, external e-sign integrations, advanced knowledge search | Higher processing/storage/support cost |
| **Projects & Capital Planning** | Project plans, resource allocation, budgets, capital requests, approval gates, project cost tracking | Not universal |
| **Advanced Analytics & AI** | Natural-language analysis, forecasting, anomaly detection, advanced custom dashboards, AI-assisted setup, intelligent document processing above base allowances | Variable compute cost and advanced needs |
| **Multi-site / Advanced Integrations** | Multiple plants/warehouses, complex permissions, custom API connections, high-volume sync, extended support | Complexity and service burden |

**Bundling opportunity:** Offer focused bundles (e.g., Manufacturing Operations, Maintenance Excellence, Workforce Development, Quality & Compliance) at a discount versus à la carte modules. Ensure core transactions work without purchasing an unrelated add-on. Avoid charging separately for indispensable dependencies or hiding basic workflows behind add-ons.

### Price hypotheses for Claude to test, not final prices

- Base: **$499/company/month**.
- Full-access users: **$25/user/month beyond included seats** (illustrative).
- Operational users: **$10/user/month**; employee self-service **$3/user/month** or a generous bundled allowance; read-only free or generous allowance. Reassess because employee-based charges may undermine workforce adoption.
- Add-on prices: **TBD through customer research and cost-to-serve analysis**; do not invent a fixed price list yet.
- Implementation: optional fixed-scope packages, historically discussed **$1,500–$5,000** as a hypothesis; complex migrations priced separately.
- Third-party accounting, payroll, e-sign, banking, and payment processing fees are external and disclosed.
- Consider usage-based charges only for clearly measurable costly services (AI compute, high-volume storage/API), with customer-set limits and advance warnings.

## 4. Newly required: asset utilization, repair work orders, BOMs, PM kits

This requirement is **explicitly in scope** and needs particular attention during discovery.

### 4.1 Asset master and utilization

- Asset hierarchy: company > site > area > line > equipment > component; unique IDs, QR/barcode optional.
- Asset metadata: make/model, serial, manufacturer, commissioning, criticality, capacity, warranty, manuals, vendor, spare parts, responsible team.
- States: available, running, idle, planned downtime, unplanned downtime, out of service; timestamps and reason codes.
- Utilization definitions must be configurable: calendar time vs scheduled time vs available time; distinguish run time, productive time, and planned stops. OEE is optional and requires reliable quality/performance data.
- KPIs: utilization, availability, downtime, maintenance backlog, MTBF, MTTR, maintenance cost, asset lifecycle costs; avoid misleading KPIs where telemetry is unavailable.
- Inputs: manual entry initially, optional PLC/SCADA/IoT connectors later.

### 4.2 Repair request to work order

1. Employee or monitoring signal submits maintenance request with asset, symptom, severity, photo, and safety impact.
2. Triage assigns priority, owner, downtime state, and required approvals.
3. Generate corrective maintenance **work order** with steps, safety instructions, estimated labor, due date, required parts, and associated **repair BOM**.
4. Check spare-parts inventory, reserve items, identify shortages, and optionally initiate purchase requisitions (using the shared approval chain before PO generation).
5. Assign qualified technician(s) using workforce competencies and availability.
6. Record work, actual labor, consumed parts, substitutions, findings, and asset downtime.
7. Close after verification/return-to-service authorization; update history, costs, utilization, and recurring-failure analytics.

### 4.3 Repair BOMs

- Equipment/assembly BOMs and task-specific repair BOMs; version-controlled part numbers, quantities, units of measure, alternates, vendor cross-references, and compatibility.
- Distinguish **reference BOM** (expected parts) from **actual consumption**.
- Permit approved substitutions and as-found/as-left configuration; track serialized parts when needed.
- Avoid auto-purchasing without budget and approval checks.

### 4.4 Preventive maintenance and PM kits

1. Define PM plan by time, meter/cycle count, usage, or condition (condition-based maintenance later).
2. PM task template contains procedures, tools, required qualifications, safety steps, estimated downtime/labor, and **PM kit BOM**.
3. Forecast PM demand; aggregate parts demand across upcoming PMs; identify shortages and lead times.
4. **Build/assemble kits:** reserve or pick parts from inventory, record kit ID, location, lot/serial where needed, substitutions, shortages, and staged/ready status.
5. Generate PM work orders, schedule around production, and assign qualified technicians.
6. At execution, consume used parts, return unused parts, capture findings and labor, and update next-due date.
7. Track PM compliance, kit readiness, overdue work, and cost.

**Key architecture choice to interview:** Are PM kits physically assembled inventory items, virtual pick lists, or both? How should unused parts and kit disassembly be handled? Should parts be stocked at multiple locations? Is the initial buyer a manufacturer with production-critical assets or a field-service organization?

### 4.5 Critical integrations

- Inventory ↔ repair/PM BOM ↔ reservations/consumption ↔ purchasing.
- Workforce skills/schedules ↔ technician eligibility/dispatch.
- Production planning ↔ maintenance windows ↔ asset availability.
- Quality/safety ↔ lockout/tagout evidence, incident and corrective action (where applicable).
- Finance ↔ work-order costs, capital vs expense classification, supplier invoices.
- Documents ↔ manuals, schematics, procedures, work-order evidence.

## 5. End-to-end business workflows to preserve

1. **Lead to cash:** lead → opportunity → quote/proposal → approvals → accepted contract/PO → sales order → fulfillment → invoice → collection → reconciliation.
2. **Procure to pay:** request → budget/policy check → multi-level approval → PO generation → purchasing release → receipt → supplier invoice → match/approve → payment-provider instruction → confirmed payment → accounting sync.
3. **Hire to develop:** employee record → position/level → schedule/timekeeping → training/certifications → performance review → promotion readiness → authorized compensation change → payroll provider.
4. **Maintain to availability:** asset issue or PM due → work order → BOM/kit availability → approved purchasing if needed → qualified technician → repair/PM execution → verification → inventory/labor costs → utilization reporting.
5. **Document to compliance:** controlled document revision → approval → impacted role identification → training assignments → acknowledgment → audit-ready evidence.
6. **Contract to obligations:** agreement storage/signature → obligations extracted/reviewed → owners/due dates → reminders → evidence → renewal/closure.

## 6. Data, security, and control requirements

- Shared authoritative identities for organization, site, employee, customer, supplier, item, asset, document, requisition, PO, work order, invoice, and contract.
- Strict multi-tenant isolation; role-, location-, and record-level access; separate sensitive HR/pay data from general operational search.
- Approval engine supports dollar thresholds, department, capex/opex, supplier risk, sequential/parallel routing, delegation, escalation, separation of duties, and reapproval after material changes.
- Append-only or tamper-evident audit records for sensitive actions; immutable event references where appropriate.
- Idempotent integration/webhook handling; retries, reconciliation queues, duplicate prevention, and explicit system-of-record ownership.
- Configurable retention, backups, recovery testing, monitoring, and export/exit strategy.
- AI can recommend, summarize, classify, and extract but must not independently authorize spending, change compensation, certify compliance, or post payments.
- Legal/payroll/OSHA/ISO compliance is **support**, not a guarantee; validated jurisdictional rules and human review are required.

## 7. Suggested MVP and phased delivery (challenge in interview)

**Platform foundation:** tenancy, authentication, permissions, common data model, documents, approval/workflow engine, notifications, audit history, imports, integrations, reporting.

**MVP candidate:** CRM/quotes, suppliers, purchase requests with multi-level approval, PO creation, inventory essentials, document attachments, invoices/AP-AR status, accounting export, **asset register + basic utilization + repair/PM work orders**, basic PM scheduling and simple part lists. This deliberately prioritizes asset management because it is a newly stated requirement, but may still be too broad: narrow to one pilot customer's highest-value workflow.

**First paid expansion:** full repair BOMs, PM kit building/staging/reservation, advanced CMMS and utilization analytics, workforce scheduling and qualifications, payroll integration, three-way matching, automated AR collections.

**Later:** advanced MRP, production planning, full talent development, QMS/compliance packages, capital planning, advanced AI, multi-site complexity.

**Important alternative to test:** Asset/maintenance-first vertical entry (CMMS + inventory + purchasing) may reach paying customers faster than a broad ERP launch, while retaining the architecture for eventual suite expansion.

## 8. Competitive reality and validation

Compare against NetSuite, Odoo, ERPNext, Zoho, Microsoft Dynamics 365 Business Central, and specialized CMMS/HR/QMS tools. Do not assert parity without tested workflows. Key research questions:

- Which combinations of features do small manufacturers/distributors actually use daily?
- Which existing subscriptions would the base replace, and what is the total cost including third-party systems?
- What percentage of customers require each proposed add-on? Which add-ons should be bundles?
- Is $499 base + seats + modules perceived as fair and simpler than incumbent pricing?
- Can self-implementation succeed without custom data cleansing and workflow consulting?
- Which external APIs permit the required write-back and at what cost?
- What are per-customer hosting, storage, AI, integration, onboarding, support, and compliance-content costs?

## 9. Open decisions / interview agenda

Claude should prioritize these topics and ask follow-ups rather than make assumptions:

1. **First ideal customer:** exact industry, size, operating complexity, number of sites, pain point, current systems.
2. **Product wedge:** broad ERP vs maintenance/asset-first vs purchasing/inventory-first; what makes a $499 base indispensable?
3. **Base scope:** identify the ~50% most frequently used functions empirically; distinguish daily essentials from advanced depth.
4. **Pricing:** included seats, per-user categories, minimum term, module/bundle pricing, transaction/storage limits, onboarding fees.
5. **Asset utilization:** manual vs machine telemetry, definition of available/scheduled/production time, OEE need, shift calendars.
6. **Maintenance:** corrective vs preventive vs predictive; work order lifecycle; technician qualification and dispatch.
7. **Repair BOMs and PM kits:** virtual vs physical kits; revisions, reservations, staging, shortages, substitutions, unused returns, multiple storerooms.
8. **Financial authority:** requisition approval levels, PO release, AP payment approval, accounting ownership, capex vs expense.
9. **Workforce:** timekeeping depth, payroll provider, performance and promotion requirements, sensitive record permissions.
10. **Compliance:** industries and jurisdictions; OSHA, ISO, safety, contract obligations; whether maintained content is included or sold as industry pack.
11. **Documents:** versioning, retention, e-sign, search, contract obligation extraction, storage volumes.
12. **Build strategy:** greenfield vs extend open-source ERP; existing code/assets; preferred stack, hosting, security model.
13. **GTM:** pilot access, willingness-to-pay interviews, implementation support, support SLA, channel partnerships.
14. **Success measures:** time to value, retention, onboarding effort, attach rate, ARPU, gross margin, support burden.

## 10. Deliverables requested from Claude

After interviewing me, produce:

1. **Decision log** — confirmed vs tentative vs unresolved.
2. **Product Requirements Document** — actors, workflows, business rules, data objects, acceptance criteria, nonfunctional requirements.
3. **Base-versus-add-on feature matrix** — grouped by suite, frequency/value rationale, dependencies, release priority.
4. **Pricing and packaging proposal** — base, seat types, add-on bundles, transparent usage limits, illustrative customer bills, unit economics sensitivities.
5. **MVP recommendation** — smallest compelling paid product, explicit exclusions, testable success metrics.
6. **Architecture options** — build vs extend existing ERP; integrations; security; tenancy; transaction ownership.
7. **Phased roadmap and risk register** — sequencing, compliance exposure, technical dependencies, implementation costs.
8. **Customer discovery script** — interview questions for 15–30 prospective customers, with no leading assumptions.

## 11. Suggested first interview round for Claude

Ask these **five questions first**, then adapt based on answers:

1. What is the single most likely first paying customer: machine shop, discrete manufacturer, distributor, industrial service company, or something else? How many people and assets?
2. Should asset utilization/maintenance with repair BOMs and PM kit building be the **initial flagship capability**, or must CRM/purchasing/inventory launch at the same time?
3. At $499/month, how many **full users** and **employee/shop-floor users** should be included so the base feels generous without harming economics?
4. For PM kits, do customers need physical preassembled kits with inventory reservations and returns, virtual parts lists, or both? How many storerooms/sites?
5. Which existing systems must the first customer keep (accounting, payroll, payments, spreadsheets), and which must our platform replace on day one?

---

**Status note:** This brief synthesizes a series of exploratory conversations. Features and pricing are product hypotheses unless explicitly labeled as firm requirements. The newly requested asset utilization, repair work orders/BOMs, and PM kit building are firm scope additions; packaging and implementation priority remain to be decided.


---

## 12. APPROVED SCOPE AMENDMENT — authoritative over Sections 1–11

**Approval:** Founder approved the Category 1 / Category 2 scope audit and the revised scope and sequence, including the LMS, FMEA, business continuity, and equipment-linked technical knowledge. This is **approval of the product boundary and sequencing principles**, not approval of a fixed sprint schedule or promise that every feature ships in the initial release.

### 12.1 Scope-control definitions

- **Category 1 — Essential product capability:** Required for a coherent end-state business operating platform. A Category 1 capability can still be sequenced after launch. Not every Category 1 item is necessarily included in the $499 base subscription; pricing and entitlements must be assessed separately.
- **Category 2 — Meaningful differentiator:** Advanced functionality with plausible measurable operational benefit, designed to reuse shared entities/workflows. Usually opt-in paid advanced modules, not necessarily first-release work.
- **Integration only:** Connect to specialist software instead of reproducing its core regulated or highly specialized functions.
- **Excluded/deferred:** No native build without a new business case and explicit approval.
- **Architecture-ready ≠ built; end-state approved ≠ release committed.** No feature may enter a sprint merely because it appears here.

### 12.2 Product families and approved feature placement

| Product family | Category 1: coherent essential workflows | Category 2: differentiating extensions |
|---|---|---|
| Commercial & Financial Operations | CRM, customers/leads/opportunities, quotes/contracts/NDAs, sales orders, purchasing requests → multilevel approvals → POs, receiving, AP review, customer invoice workflow, budget commitments, accounting integrations, supplier records | Spend optimization, margin/pricing intelligence, cash forecasting, customer/supplier portals, advanced contract intelligence |
| Manufacturing & Inventory | Item/UOM/location masters, receiving/stock movements/cycle counts/replenishment, BOMs/routings, production work orders, **lightweight production execution** (equipment/operator/time, completed quantity, scrap/rework, actual material use), basic scheduling/utilization | Multi-customer forecast ingestion/versioning, forecast-versus-firm-order reconciliation, demonstrated equipment/fleet capacity, qualified-labor and maintenance constraints, chemicals/gases/consumables/PM-parts forecasts, bottleneck analysis, scenarios, finite scheduling and cross-site planning, advanced warehouse workflows |
| Assets & Maintenance | Full physical asset register, lifecycle/status/owner/location, manuals and equipment-linked technical documents, warranty, downtime, basic PM/corrective work orders, labor/parts cost records, basic utilization, technician access to troubleshooting guides | Repair/PM BOMs, PM kits/reservations/staging/returns, automated shortages to PR/PO, reliability/MTBF/MTTR, sustainment and lifecycle economics, condition-based maintenance, advanced troubleshooting recommendations |
| Workforce Development & Learning | Employee/department records, shifts/time/PTO tracking, payroll export/integration, performance reviews, **full internal LMS**: course catalog, creation, assignments, course tracking, video, instructor-led, self-directed, shadowing/OJT, practical assessment, assessment delivery and result/evidence storage, certification/qualification records, expirations and renewals | Prerequisite paths, competency matrices, skill ladders, supervisor sign-offs, automated qualification status, training effectiveness, qualified-worker-to-equipment scheduling, AI-assisted course drafting |
| Quality, Safety & Risk | Nonconformances, corrective actions, controlled SOPs, document revision/approval, audits, calibration, safety incidents/near misses, action tracking | **FMEA** (process/equipment/design, scoring, action owners, revisions, CAPA/asset links), SPC/control charts/capability and equipment-linked trends, 8D, advanced supplier quality, **business continuity plans** (critical processes, RTO/RPO where relevant, owners, recovery steps, exercises, test results, corrective actions) |
| Business Management & Intelligence | Projects/tasks/milestones/capex requests/budgets, action items, shared documents, dashboards/KPIs/reports, standard notifications and cross-module workflows | Shift passdown, daily management, continuous improvement/benefits tracking, decision history, cost intelligence, scenario planning, AI-assisted reporting/configuration, operational dependency mapping |

**Cross-cutting Category 1 foundations:** customer/tenant → legal entity → facility → department hierarchy; unified authorized multi-facility deployment; facility-based access and consolidated corporate views; RBAC/record permissions; audit events; shared approval/action/notification engines; versioned documents; API/integration framework; data import/export; configurable forms/fields; secure auth; backups/recovery; mobile-responsive UI; subscription and per-facility module entitlements. The base subscription includes one licensed facility, and additional facilities live inside the same tenant; corporate rollups are not a separately billed facility. Pricing remains illustrative: $499/month first facility, possible $199/month additional facility, five included full users and additional seat classes subject to validation. Advanced modules may be activated at selected facilities only.

### 12.3 Full LMS: approved requirements and boundaries

The LMS is a **first-class component of Workforce Development**, not a disconnected product. It must support:

1. Course/catalog authoring with titles, objectives, prerequisites (advanced), versions, content, instructor/owner, and expiration/review dates.
2. Learning events of type **video**, **in-person instructor-led**, **self-directed reading/learning**, **shadowing/on-the-job training**, and **practical observed assessment**; one course may contain several event types.
3. Assignments to individuals, teams, roles, facilities or equipment qualification requirements; due dates, reminders, enrollment, attendance and completion evidence.
4. Assessment creation, storage, **delivery**, grading/results, passing rules, attempts, evidence attachments, evaluator attestations, and durable audit history. Practical skills may require authorized evaluator sign-off.
5. Distinct states for **training completed**, **assessment passed**, **competency verified**, **qualification authorized**, and **certification issued**; no assumption that video viewing alone authorizes safety-critical work.
6. Internal certifications/qualifications, externally issued credential records (without claiming external accreditation), issue/expiry/renewal, retraining triggers, and qualification revocation.
7. Controlled document references: the LMS and Asset Management point to **the same versioned source document**, not duplicated copies. Revisions flag affected courses/qualifications for review; retraining is rule-based and reviewed, not automatically imposed on every change.
8. Category 2: qualification pathways, competency matrices, training-to-capacity planning, AI course drafting with human review.

**Explicit LMS boundaries:** internal employee/workforce training and qualification; **not** a university LMS, public course marketplace, native live-video conferencing service, full proctoring platform, or automatic regulatory accreditation. SCORM/xAPI interoperability, interactive authoring, and external training commerce require separate demand validation; do not silently add them. Large video files should use appropriate object storage and access controls; define quotas before promising unlimited video hosting.

### 12.4 Equipment-specific technical knowledge: Category 1

Each asset and, when applicable, component supports controlled references to manuals, OEM service bulletins, electrical/mechanical drawings, repair procedures, technical training materials, **troubleshooting guides**, photos and videos. Include tags, searchable metadata, version history, access restrictions, QR/barcode navigation to authorized asset pages, links from work orders and LMS courses, and a clear distinction between published/approved and draft procedures. Category 2 may add interactive troubleshooting trees, recommendations from failure history, and AI-assisted search with citations to approved source documents. Never generate unverified safety-critical repair instructions as authoritative.

### 12.5 FMEA: Category 2 under Quality, Safety & Risk

Use existing risk/action/approval/document/asset/process entities. Support process, design and equipment FMEAs; failure modes/effects/causes/controls; configurable severity/occurrence/detection scoring and methodology (not RPN-only); actions/owners/dates; pre/post-mitigation evaluation; approvals and revisions; links to CAPA, equipment failures, PM strategy, and relevant controlled SOPs. **Do not** build a separate enterprise risk platform. FMEA forms and workflow are relatively bounded; data validity, methodology and auditability still need testing.

### 12.6 Business continuity: Category 2 under Quality, Safety & Risk / Operations Excellence

Support critical process records, scenarios, dependency references to assets/suppliers/people, recovery plans, owners/alternates, contacts, recovery objectives (RTO/RPO where appropriate), periodic review, exercise scheduling, test evidence, corrective actions, and revision history. Reuse document control and action tracking. **Exclude** real-time crisis command centers, complex disaster simulation, legal/regulatory interpretation, and enterprise GRC. A customer owns its recovery strategy and the correctness of its plans.

### 12.7 MES, traceability, SPC and financial boundaries

- **No full MES build.** Category 1 production execution captures basic work-order start/stop, operator/equipment, actual quantities, scrap/rework, downtime and material consumption; no complex recipe enforcement, automated machine controls, or regulated electronic batch record system.
- **Traceability is configurable.** Basic optional item lot/serial fields and transaction linkage when selected; do not force genealogy capture on every SMB. Full multi-level genealogy/recall workflows are deferred unless a target customer demonstrates need.
- **SPC is Category 2 Advanced Quality.** Measurements tied to product/process/equipment/lot or work order, statistically correct control charts, capability metrics, alerts and investigation links. Validate statistical calculations and sampling assumptions. High-volume telemetry, automated process holds and enterprise SPC infrastructure are not implied.
- **Native GL, tax engines/filing, statutory consolidation, treasury/banking, payroll processing/tax, formal project accounting, global trade compliance, complex regulated manufacturing compliance, and enterprise GRC are NOT in native scope.** Provide secure integrations and relevant operational records only.
- **Operational cost intelligence is in scope; accounting-of-record is external.** Maintain traceability to source costs and avoid double-counting depreciation. Production chemicals and gases contribute to production consumption/cost forecasting, **not** asset maintenance/sustainment cost.

### 12.8 Capacity and resource planning: flagship Category 2

The integrated advanced engine accepts one or many customer forecasts, handles revisions and overlapping firm orders, converts demand into product-specific routings and work-center loads, and determines feasibility using **demonstrated** equipment throughput, availability, PM/downtime, yield/rework, setup/changeover, qualified workforce and supplier/material availability. Forecast production chemicals, process gases, materials, production consumables, maintenance consumables, PM kits and replacement parts; model startup/idle/bath-change/flush losses where appropriate. Project supply by date with inventory, receipts, reservations, lead times and shelf life. Show bottlenecks, shortfalls, confidence/assumptions, and scenarios (shifts, maintenance, staffing, equipment, outsourcing, cross-site). Separate nameplate, scheduled, demonstrated, effective good-unit, committed and remaining capacity. Tie actual production and consumption back to planning assumptions. Do not assume all tools are interchangeable or that adding equipment hours automatically resolves upstream/downstream constraints.

### 12.9 Product scope change gate

Before approving **any** new capability, document: (a) target customer and specific workflow; (b) measurable acquisition/retention/operational value; (c) existing entities/workflows reused; (d) implementation **and ongoing** support/maintenance cost; (e) usability/implementation impact; (f) native vs integration vs defer; (g) dependency and test plan. A competitor having a feature is not sufficient justification. Only explicitly approved sprint work becomes a delivery commitment.

## 13. CLAUDE OPUS 5 — BUILD EXECUTION PROTOCOL

### 13.1 Immediate first actions

1. **Inspect the actual repository and environment** before choosing architecture. Report codebase structure, languages, migrations, tests, existing authentication, integrations and deployability. If no repository exists, state that and propose a greenfield structure; do not pretend one exists.
2. Produce `docs/PRODUCT_SCOPE.md` (this approved scope, separating C1/C2/integration/excluded), `docs/DECISIONS.md` (approved vs proposed vs unresolved), `docs/ARCHITECTURE.md` (bounded contexts, entities, tenancy/security), `docs/ROADMAP.md` (dependency-ordered slices), and `docs/BUILD_LOG.md` (changes, tests, blockers). Keep them current.
3. Recommend **one first complete vertical slice** and explain why it creates testable customer value. Suggested candidate: tenant/facility/user RBAC + asset registry + equipment-linked controlled documents + corrective maintenance work order + audit trail, followed by LMS course/assessment/qualification tied to an asset. This is a **suggestion**, not a founder-approved fixed MVP; ask for approval before locking major architecture or scope.
4. Define data entities and interfaces to avoid dead ends: Tenant, LegalEntity, Facility, Department, User, Role, Employee, Asset, AssetComponent, Document, DocumentVersion, Course, CourseVersion, LearningEvent, Enrollment, Assessment, Attempt, Evidence, Qualification, Certification, WorkOrder, Part, InventoryTransaction, Supplier, Approval, AuditEvent, ProductionOrder, EquipmentPerformance, CustomerForecast, CapacityScenario, FMEA, ContinuityPlan. Only implement entities required by the approved slice; document future interfaces without building unused tables/services.
5. **Then implement** the approved slice: migrations, authorization policies, service/API, UI, input validation, audit events, automated tests, sample fixtures and local run instructions. Work iteratively; do not spend all effort generating specifications without working software.

### 13.2 Architecture guardrails

- One multi-tenant deployment, tenant-isolated data; legal entity distinct from facility; authorized facility and consolidated views; entitlements per facility. All queries and background jobs enforce tenant and facility access, not just UI filters.
- Common reusable services for documents, approval, audit, action items, notifications, identity and entitlements. Prefer a modular monolith until scaling needs justify distributed services.
- Strong relational consistency for purchasing, inventory, qualification and production transactions; explicit states and immutable audit history. Idempotent integration processing; backups and recovery testing; secrets managed securely.
- HR assessment records and certification evidence are sensitive: restrict by role/need-to-know; retention and deletion policy; signed access to media; separate draft vs approved technical instructions.
- Never equate course completion with authorization to operate equipment. Preserve evidence, assessor, date, credential validity and revocation history.
- Core calculations (SPC, capacity, costs) must be deterministic and unit-tested. AI suggestions must cite input/source data, disclose uncertainty, and require human approval before changing consequential records.
- External accounting, payroll, payments, e-sign, tax and trade services remain integrations. Mock adapters may be used during local development but must be clearly labeled as mocks.
- Avoid vendor/stack lock-in before inspecting existing work; propose alternatives and trade-offs for consequential choices.

### 13.3 Sequence — dependencies, not arbitrary calendar dates

**Phase 0 — Repository assessment and foundations:** confirm stack and constraints, architecture/decision log, tenant/facility RBAC, auth, audit, controlled documents, shared workflow primitives, tests and CI.

**Phase 1 — Coherent operational vertical slice:** asset registry, equipment-linked manuals/troubleshooting documents, basic maintenance request/work order/PM; then workforce/employee records and LMS course → mixed learning events → assessment/evidence → qualification → asset-required skill link. Demonstrate an authorized technician finding a controlled procedure and a manager verifying qualification.

**Phase 2 — Core business transactions:** CRM/quotes/orders, suppliers, PR → approval → PO → receipt, inventory/UOM, external accounting adapters, basic reporting. Deliver complete workflows in slices rather than half-built screens.

**Phase 3 — Production and quality foundation:** BOM/routing, production work orders and lightweight execution, actual equipment throughput/consumption, nonconformances, corrective actions, controlled SOPs and safety records.

**Phase 4 — Advanced differentiators, validated by pilot demand:** integrated multi-customer demand/fleet capacity/material+chemical+PM parts forecasting, advanced asset reliability and PM kits, workforce qualification constraints, SPC, FMEA, continuity plan tracking, cost intelligence and operations excellence. FMEA and continuity may be moved earlier if inexpensive to add after shared risk/action primitives exist; their ease alone does not supersede customer value.

**Phase 5 — Optional vertical expansion:** field service, advanced warehouse, advanced portals, AI intelligence and multi-facility optimization where justified. Excluded specialist systems stay excluded unless explicitly reapproved.

Sequence is provisional: a first paying pilot may justify a different vertical slice. **No entire phase is promised for one release.** For every slice show dependencies, user story, acceptance criteria, implementation cost estimate, tests and demo.

### 13.4 Acceptance tests to anchor the first build

- Tenant A cannot read/write Tenant B data, including document downloads and background operations.
- A user restricted to Facility 1 cannot access Facility 2 records; a corporate-authorized user can see appropriate consolidated data.
- An asset has controlled, searchable technical documents; users see only authorized approved versions and can open them from asset/work-order views.
- An LMS course combines a video, instructor-led session, self-study, OJT shadowing and practical evaluation; assignment/completion/evidence are recorded for each type.
- An assessment can be delivered and graded, with attempt/result/evidence history; evaluator approval is required where configured.
- Completing a video does **not** independently confer a safety-critical equipment qualification; an authorized assessor grants/revokes a qualification and its validity is checked before restricted assignments.
- A procedure revision flags impacted training for review without silently overwriting historical evidence.
- A corrective work order links an asset, technician, parts/labor, technical procedure, state changes and immutable audit history.
- Later-phase integration tests: customer forecast + equipment performance + labor/PM + chemical/consumable rates yields a traceable feasibility and supply-shortfall report; FMEA actions link to CAPA/PM; continuity exercises generate tracked actions.

### 13.5 First response expected from Claude

**Do not begin by rewriting this entire brief.** Return: (1) repository audit and what is actually present; (2) top five architectural risks/decisions; (3) recommended first vertical slice with rationale and explicit exclusions; (4) proposed implementation stack or confirmation of existing stack; (5) at most five blocking questions; (6) first executable tasks. Once key choices are confirmed, proceed with working code and tests, reporting exactly what ran and what remains unimplemented.

## 14. Superseded guidance / interpretation notes

- Sections 1–11 are retained for background, detailed asset and approval workflows, and commercial hypotheses. **Section 12 supersedes any earlier statement that FMEA, LMS, business continuity, equipment-specific knowledge, or capacity planning is merely an unapproved idea.**
- Earlier tables proposing a separately priced **Multi-site** add-on are superseded: multi-facility architecture and corporate visibility are foundational; additional *licensed facilities* may be charged, but they remain in the same tenant.
- Earlier Workforce add-on tables placing *all* training/certification capability behind a paywall are superseded: a complete, bounded **internal LMS is Category 1**; advanced competency/optimization is Category 2.
- Earlier Manufacturing/MRP descriptions that bundle basic production transactions and all advanced capacity functions together are superseded: lightweight production execution is Category 1; sophisticated integrated capacity and consumption forecasting is Category 2.
- Full enterprise MES, native general ledger, tax, payroll, treasury, global trade compliance, and complex enterprise GRC are **out of native scope**.
- The original 'discovery interview only' instruction and first five questions in Section 11 are **historical**. The new task is **repository inspection and incremental implementation**, with focused questions only where decisions block progress.

## 15. APPROVED REPORTING, OUTPUT & PRESENTATION STANDARD — authoritative

**Decision:** All modules must provide useful output views and exportable formats. Adopt a **McKinsey-inspired executive communication style**: answer-first, insight-led, clean, restrained, precise, and evidence-based. This is a design direction, **not** permission to copy proprietary templates, logos, brand assets, or claim an affiliation. The design system must also work for technicians, supervisors, and transactional users; do not force an executive-slide layout onto every operational screen.

### 15.1 Common output types (shared platform service, not separately rebuilt by module)

- **Interactive operational views:** searchable/filterable/sortable tables; saved views; grouping, totals, drill-down; role- and facility-aware data access; status boards; detail pages; mobile-appropriate layouts.
- **Management dashboards:** KPI cards, trends, variance-to-target, comparisons, exception queues, Pareto charts, control charts where relevant, and drill-through to source records.
- **Executive briefs:** headline stating the principal finding, 3–5 evidence-backed supporting insights, quantified impact, recommended action, owner, and date; clear distinction among actuals, estimates, forecasts, and assumptions.
- **Formal documents:** printable reports, controlled forms, audits, training completion/certification records, FMEA registers, business continuity plans, maintenance histories, purchase orders, and similar module-specific records.
- **Exports:** CSV and XLSX for tabular data; PDF for polished printable reports; print-friendly HTML; image export (PNG/SVG) for supported charts; structured JSON/API for system-to-system use. PPTX and DOCX are **advanced or later-phase export adapters** where there is demonstrated customer demand; design the reporting service so they can be added without redesigning module logic. Never promise perfect visual fidelity across formats.
- **Delivery:** on-demand download and printing first; saved reports, scheduled delivery, secure sharing, and email delivery when justified and security-tested. Exports must respect tenant/facility permissions and sensitive-data controls.

### 15.2 Presentation and visual conventions

1. **Answer-first titles:** report and slide titles communicate a finding or decision, not merely a topic (e.g., “CMP capacity falls 12% below November demand,” not “CMP Report”). Neutral descriptive titles remain appropriate for transactional forms.
2. **Executive hierarchy:** clear title, date/period, scope, key takeaway, supporting evidence, implications, and next action. Use restrained typography, consistent spacing and alignment, generous whitespace, minimal ornamentation, and a limited accessible palette.
3. **Charts chosen for the decision:** time-series lines for trends; bars for comparisons; stacked bars for composition; Pareto for contributors; scatter/box plots for process distributions; waterfall for financial bridges; heatmaps for exceptions; SPC control charts for validated process monitoring. Do not use decorative charts, misleading axes, or unsupported causal claims.
4. **Consistent measurement:** show units, period, facility, denominator, target, baseline, currency, rounding, and source/refresh timestamp. Distinguish missing data from zero. Clearly label simulated, projected, and actual results.
5. **Actionable interpretation:** where appropriate, every management report identifies the issue, magnitude, likely drivers (clearly marked as hypotheses if not verified), responsible owner, and proposed next step.
6. **Audience-aware density:** technician views prioritize speed, safety, and task clarity; supervisors prioritize exceptions and actions; executives prioritize implications, comparisons, and decisions. Use the same data and metric definitions across views.
7. **Accessible and responsive:** keyboard navigation, screen-reader labels, contrast checks, color-independent status cues, legible printed output, and mobile/tablet responsiveness.
8. **User control:** date range, site, department, product, customer, equipment, and other relevant filters; saved presets and export options; export metadata reflects active filters and permissions.

### 15.3 Reporting architecture and reuse

- Create **one shared reporting/query and export layer**, not separate custom PDF/Excel generators in each module. Reusable report definitions declare data source, metric definitions, filters, authorization scope, layout, charts, and export capabilities.
- Use a shared **design-token/component library** for headings, KPI cards, tables, chart annotations, callouts, footnotes, and print styles. Module-specific reporting extends this system.
- For advanced analysis, record calculation logic, source lineage, assumptions, refresh time, and report version where applicable. Preserve the distinction between operational source-of-truth records and analytical snapshots.
- Separate report computation from rendering so the same authorized data can power dashboards, PDF, spreadsheets, and later slide/document exports.
- Avoid performance and security pitfalls: paginate large tables, bound expensive queries, use asynchronous exports for large reports, audit access to sensitive exports, and use expiring download links when appropriate.

### 15.4 Implementation sequence and acceptance criteria

**Phase 0–1:** Define visual/reporting design tokens and a reusable report schema; ship consistent tables, filters, KPI cards, print-friendly pages, **CSV export** and at least one polished **PDF report** in the first working vertical slice. Build XLSX support as the next shared adapter, not a per-module custom implementation. Do not build PPTX/DOCX export before core operational workflows function.

**Phase 2–3:** Expand common chart library, saved views, XLSX export, drill-down, chart image export where needed, and reusable report templates across purchasing, assets, LMS, production and quality.

**Phase 4+:** Advanced scenario/forecast reports, automated executive briefs, scheduled reports, and selectively PPTX/DOCX exports if customer demand justifies ongoing maintenance.

**Acceptance tests:** (a) identical filters and access rights yield consistent metrics across dashboard/CSV/PDF; (b) facility-restricted users cannot export unauthorized data; (c) a report prints without clipped charts or columns; (d) charts show units, dates, and sources; (e) a supervisor can reach underlying records from an exception; (f) empty/partial datasets produce clear messages rather than misleading zeros; (g) outputs follow the approved visual standard.

**Scope guardrail:** Rich outputs are a **cross-cutting product requirement**, not a reason to create an enterprise BI suite, a presentation editor, or custom output engines for every module. Prioritize high-value reports and formats by workflow and customer demand.

