# Product scope (approved boundary — brief v2.1 §12)

**Architecture-ready ≠ built. End-state approved ≠ release committed.** Nothing enters a sprint because it appears here. New capabilities pass the §12.9 change gate: target customer and workflow, measurable value, reused entities, build and ongoing cost, usability impact, native vs integration vs defer, and a test plan.

## Category 1 — essential (may still be sequenced after launch)

| Family | Capabilities | Built so far |
|---|---|---|
| Foundations | tenant → legal entity → facility → department; facility-scoped access + consolidated views; RBAC; audit; approval/action/notification engines; versioned documents; API/integration framework; import/export; configurable fields; secure auth; backups; mobile-responsive UI; per-facility module entitlements | Tenancy, RLS, RBAC, audit, documents, entitlements table, import framework, custom fields (JSONB). **Not yet:** approval engine, notifications, production auth, UI |
| Commercial & financial operations | CRM, quotes/contracts/NDAs, sales orders, PR → multilevel approval → PO, receiving, AP review, customer invoices, budget commitments, accounting integrations, supplier records | — |
| Manufacturing & inventory | item/UOM/location masters, stock movements, cycle counts, replenishment, BOMs/routings, production work orders, lightweight production execution, basic scheduling/utilization | Part master (no stock yet); basic utilization |
| Assets & maintenance | asset register, lifecycle/status/owner/location, equipment-linked manuals and troubleshooting guides, warranty, downtime, basic PM/corrective work orders, labor/parts cost records, basic utilization, technician access to guides | Register, hierarchy, locations, state log, linked controlled documents, corrective WOs with labor/parts/procedures, verification and return-to-service, utilization report. **Not yet:** PM scheduling |
| Workforce development & learning | employee records, shifts/time/PTO, payroll export, performance reviews, **full internal LMS** (catalog, mixed learning events, assessments, evidence, qualifications, certifications, expirations) | Employee directory only. LMS is the next slice |
| Quality, safety & risk | NCR, CAPA, controlled SOPs, document approval, audits, calibration, incidents/near misses, action tracking, **management of change** (request, screening, cross-functional review, action plan, pre-startup safety review, temporary changes) — added by [SC-001](scope-changes/SC-001-management-of-change.md) | Controlled document approval; management of change; shared approval engine |
| Business management & intelligence | projects/tasks/capex requests/budgets, action items, shared documents, dashboards/KPIs/reports, notifications | Shared reporting service with 2 reports (JSON/CSV/HTML/PDF) |

## Category 2 — differentiators (usually opt-in paid modules)

Repair/PM BOMs, PM kits with reservations, staging and returns; automated shortages → PR/PO; reliability (MTBF/MTTR), lifecycle economics, condition-based maintenance. Competency matrices, prerequisite paths, qualified-worker scheduling, AI course drafting. FMEA, SPC, 8D, supplier quality, business continuity plans, PSM-grade MOC packs (process safety information, P&ID redlines, PHA integration), customer change-notification portals. Multi-customer forecast ingestion and the **capacity and resource planning engine** (§12.8). Spend optimization, pricing intelligence, cash forecasting, portals, contract intelligence. Shift passdown, continuous-improvement tracking, scenario planning, AI-assisted reporting.

## Integration only (connect, do not rebuild)

General ledger beyond small-business bookkeeping (the built-in books, D-136 and D-139, in every edition), tax engines/filing, payroll processing and tax, payment movement, banking/treasury, e-signature, statutory consolidation, PLC/SCADA/IoT telemetry (connectors later).

## Excluded / deferred (need a new business case)

Full MES; regulated electronic batch records; enterprise GRC; real-time crisis command centers; university LMS, public course marketplace, native live video, full proctoring; SCORM/xAPI and interactive authoring unless demand is shown; global trade compliance; formal project accounting; automatic regulatory accreditation.

## Guardrails carried into code

- AI may recommend, summarize, classify and extract, but never authorizes spending, changes compensation, certifies compliance, or posts payments.
- Course completion never equals authorization to operate equipment.
- Compliance features are *support*, not a guarantee.
- Imported or AI-proposed data must cite its source (import batch, row) and pass the same rules as manual entry.
