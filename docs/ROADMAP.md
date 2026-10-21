# Roadmap: dependency-ordered slices

Each slice ships complete workflows (schema, services, API, tests, demo data, docs). Rough cost estimates assume one senior engineer working with Claude, to be validated as velocity data accumulates. The order is provisional: a paying pilot may justify reordering after S2.

| Slice | Contents | Depends on | Status |
|---|---|---|---|
| **S0 Foundation** | Repo, migrations, tenant/facility hierarchy, RLS, RBAC, tokens (dev), audit chain, blob storage interface, CI | — | ✅ Done |
| **S1 Assets + documents + corrective maintenance + onboarding + reporting** | Asset registry and hierarchy, locations, state log + utilization, controlled documents (versioning, approval, links, search, restricted access), maintenance requests → work orders → labor/parts/procedures → verification → close; import framework with 5 targets; backlog and availability reports in JSON/CSV/HTML/PDF; fictional sample tenant | S0 | ✅ Done (API only; see D-011) |
| **S2 LMS → qualification → asset-required skill** | Course + version (linked to the same controlled documents), mixed learning events (video, ILT, self-study, OJT/shadowing, practical evaluation), enrollment/assignment, assessment delivery/grading/attempts/evidence, evaluator sign-off, qualification grant/revoke/expiry, asset/task qualification requirements, check inside `assignTechnician()`, document-revision → training-review flags, sensitive-data permissions. Reports: training compliance, expiring qualifications | S1 | ✅ Done (API only). Also: wide-sheet unpivot imports, legacy qualification import, qualification and training reports, certificate PDF |
| **S3 Web UI shell + technician mobile views** | Auth via OIDC provider, navigation, asset page (QR deep link), work-order execution on mobile, document viewer, my-training page (take quizzes, see qualifications), trainer sign-off queue, import mapping screen (suggest → adjust → stage → problems → commit), report viewer with export buttons | S1, S2, D-008, D-011 | Next. ~4–6 weeks |
| **S4 Preventive maintenance + inventory essentials** | PM plans (time and meter), PM work-order generation, calendar, compliance report; stock locations/storerooms, receipts/issues/adjustments/counts, WO part usage → issue transactions, reorder alerts | S1 | ~4 weeks |
| **S5 Purchasing + shared approval engine** | Suppliers, purchase requests, multilevel approval rules (amount, department, capex/opex, SoD, delegation, reapproval on change), PO, receiving; shortage → PR from work orders | S4 | ~5 weeks |
| **S6 Accounting/payroll adapters** | Outbox + idempotent sync framework; first accounting adapter (QuickBooks Online or Xero, per pilot); payroll-ready time export | S5 | ~3 weeks per adapter |
| **S7 CRM → quote → order → invoice** | Phase 2 commercial flows | S5, S6 | later |
| **S8 Production foundation & quality** | BOM/routing, production WOs + lightweight execution, NCR/CAPA, safety incidents | S4 | later |
| **S9+ Category 2** | Repair/PM BOMs and kits, reliability analytics, FMEA, SPC, continuity plans, capacity planning engine | per pilot demand | later |

## Cross-cutting backlog (pull into slices as needed)

- XLSX export adapter (next shared renderer); saved report views; chart rendering (SVG/PNG) in the shared component library.
- Asynchronous import/export jobs (pg-boss) for files above roughly 10k rows; expiring download links.
- S3 blob adapter with SSE and signed URLs; antivirus scan on upload; text extraction from PDFs for search.
- Production hardening: rate limiting, structured logging and metrics, backup/restore drill, retention policies, a penetration test before the first paying customer.
- Regex transform sandboxing (worker + timeout) before untrusted users edit mapping profiles.
