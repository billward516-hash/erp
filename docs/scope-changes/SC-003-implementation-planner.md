# SC-003 Implementation planner and complete import coverage

**Requested by:** founder, 2026-10-23 ("an implementation and integration planner so that when I sell this software to a company there is a systematic approach and sequence by stakeholders for uploading existing data ... guidance and data transformation tools ... Ensure that all modules have appropriate import tools").
**Status:** proposal, **not approved**; nothing built yet. Brief §12.9 gate (a)-(g) below. Five questions at the end.

**Answer first:** the import engine is already strong (CSV/TSV/XLSX/JSON, encodings, header detection, auto-mapping, saved profiles, dry-run, problem file, safe re-import, 24 targets, 14 transform steps). Three things are missing: **(1)** import targets for about 30 more kinds of data (listed below, by module), **(2)** a per-customer **implementation plan** that sequences the loads by stakeholder and tracks progress from the real import batches, and **(3)** better **transformation and guidance tools** (downloadable templates, source-system export guides, lookup/value maps, split/merge columns, pre-checks). I estimate **6-7 weeks** in four slices; slice 1 (the planner and the targets every customer needs first) is about 2 weeks and is useful by itself.

## (a) Target customer and workflow
The person implementing a new customer: our team, a partner, or the customer's own project lead.
1. **Scope:** pick the modules and sites the customer bought; the planner builds the plan.
2. **Sequence by stakeholder:** each step names the owner role (HR, maintenance, storeroom, purchasing, finance, quality, production, IT), what to export, from where, the template, the target, and what it depends on.
3. **Prepare:** download the template or the source-system guide; upload whatever format they have; apply transforms; see a dry run with a readable problem list.
4. **Load and sign off:** commit; the owner confirms the counts; the step closes. Later steps unlock when their prerequisites are loaded.
5. **Go-live readiness:** one page answering "what is loaded, what is missing, what blocks go-live" with a cutover checklist (opening balances date, freeze of the old system, final delta load).

## (b) Measurable value
Time from signature to first useful day; share of rows that load first time; support tickets during onboarding; implementer hours per customer. Today the order of loads lives in a document (`docs/DATA_ONBOARDING.md`) and in people's heads.

## (c) What is reused
The whole import framework (suggest, stage, commit, profiles, problem file, external ids), tenant feature and edition gating (to know which modules a customer has), roles and facilities (stakeholders), action items and notifications (assignments and reminders), reporting service (readiness report), audit chain.
**New:** `implementation_plan`, `implementation_step` (stakeholder role, assignee, target key, prerequisites, status, linked import batches, expected and loaded counts), a step catalogue in code (versioned), templates, source-system guides, extra transforms.

## Import coverage today and proposed
| Module | Imports today | Proposed new targets |
|---|---|---|
| Organization | sites, employees | **departments**, **users and role assignments**, facility groups, shifts and calendars |
| Assets and maintenance | assets, asset parts, work order history, downtime | **PM plans**, **meters and readings**, **failure and cause codes**, **repair templates**, open work orders, maintenance requests |
| Inventory and materials | parts, stock balances, supplier prices | **stock locations (storerooms)**, **lots and serials**, **units of measure**, kits/PM kits, reorder settings |
| Purchasing | suppliers, supplier prices, delivery history | **open purchase orders**, **approval rules**, supplier contacts and certificates |
| Sales and CRM | customers (with contacts), forecasts | **sales items and price lists**, **open quotes and sales orders**, opportunities, activities |
| Receivables and payables | opening balances (trial balance), bank lines | **open customer invoices** (aging), **open supplier bills**, **chart of accounts**, tax codes, payment terms |
| Production | boms | **work centers**, **routings** (operations), product revisions, scrap reasons, open production orders |
| Quality | spc measurements | **nonconformance history**, **CAPA/8D history**, **calibration plans and records**, audits and findings, FMEA rows, SPC characteristics |
| Safety and continuity | none | **incident history** (for rates), continuity contacts |
| People and learning | qualification records | **courses**, **training completions** (history), qualifications and asset requirements, performance goals |
| Time and expenses | none | **timesheet history** (for labor reports), earning codes, expense categories and policies |
| Documents and policies | none | **bulk document upload** with a metadata sheet (number, revision, effective date, owner, folder, links) from a zip, **policies** |
| Budgeting and planning | spend history | **budgets and lines**, work center calendars, consumption rates (exists) |
| Leasing, store ops | rental units, leases, condition points and readings | tenant/renter contacts already covered |
| Business cases | none | not needed (created in the product) |

## Tools to add
- **Templates:** a downloadable CSV and XLSX per target with headers, an example row, a data-dictionary sheet (field, type, allowed values, required, what it matches on).
- **Source-system guides:** per target, "where to find this export" for common systems (shown only where we have verified the report name; otherwise generic). No invented integrations.
- **More transforms:** lookup/value map table (their codes to ours), date format picker, concatenate columns, split one column into several, number cleanup (currency symbols, thousands separators, parentheses negatives), conditional default, row filter (skip inactive), unit conversion pairs, unpivot (exists for forecasts; generalise).
- **Pre-checks before staging:** duplicate keys inside the file, orphan references (a work order naming an asset that is not loaded or in the file), coverage ("312 of 340 asset tags in your work orders are in your asset file").
- **Staged sandbox:** run the whole plan against a throwaway copy of the company (company archive restore already exists) so a customer can rehearse; reset in one click.
- **Cutover delta load:** re-import of the final changes with only new/changed rows reported.
- **Large files:** background processing above about 10k rows (listed as a known gap).

## (d) Cost
Build 6-7 weeks (slices below). Ongoing: **moderate**. Each new field on a module touches its target; a test per target (round trip against the sample files in `samples/imports`) keeps it honest. Source-system guides need re-verification when vendors change reports.

## (e) Usability and impact
A new "Implementation" area for administrators and implementers (Lite hides it). Stakeholders see only their steps in their to-do list. The existing Data import page stays as the working screen.

## (f) Native vs integration vs defer
- **Native:** planner, templates, transforms, pre-checks.
- **Integration (later, per customer need, not invented now):** direct connectors to a named source system. File import covers every system that can export.
- **Defer:** ongoing sync from the old system after go-live, AI-assisted mapping beyond the current header/value suggestions.

## (g) Dependencies and test plan
Depends on the import framework, features/editions, roles, action items (all built). Tests: each new target imports its sample file, rejects a bad row with a clear reason, re-imports without duplicating; the planner orders steps by prerequisites and by editions; progress reflects real batches; each transform step has unit tests; a rehearsal on the two-year Stonebridge dataset (export, re-import into an empty company, compare counts and totals).

## Proposed slices
1. **Planner + first-wave targets** (~2 weeks): plan/steps/readiness page, step catalogue, templates and data dictionary for existing targets, plus new targets: departments, users and roles, stock locations, chart of accounts, open invoices and bills, open POs, PM plans, work centers and routings.
2. **Transformation tools** (~1.5 weeks): lookup maps, concatenate/split, number and date cleanup, row filter, pre-checks, orphan report.
3. **Remaining targets by module** (~2 weeks): quality history, safety, learning, time, documents bulk, budgets, sales items.
4. **Rehearsal and cutover** (~1 week): sandbox from archive, delta load, go-live checklist, background jobs for large files.

## Questions (blocking only the first)
1. **Which slice first?** I recommend slice 1, then 3's quality and documents targets, since those decide whether a manufacturer can go live.
2. Who runs implementations: **our team, partners, or customers themselves**? It decides how much hand-holding the screens carry and whether the plan must be shareable outside the company.
3. Which **source systems** do your first customers use? (The guides cover only systems you name; I will not guess report names.)
4. Should the plan **lock later steps** until prerequisites load, or only warn?
5. Is a **throwaway rehearsal copy** per customer in scope for version 1, or can it wait for slice 4?

## Founder's answers (2026-10-23)
1. Slice order: as recommended (slice 1, then quality and documents targets from slice 3, then 2 and 4).
2. Packaging: **part of the existing product**, not an add-on. Implementation is also offered **as a service** by us, so the planner is **flexible per company**: a small company can self-serve with a short plan and minimal steps; a larger one gets the full stakeholder plan with assisted steps. (Plan "depth" is a company setting: guided / standard / full.)
3. Source systems: no named systems; guides stay generic until a first customer names theirs.
4. Prerequisites **unlock** later steps (locked until prerequisites are loaded; an administrator can override with a recorded reason).
5. The **rehearsal copy with sample data is in scope for version 1** (moved from slice 4 into slice 1-2).

## Added requirement: the connection track (bank, payroll, accounting, sign-in, email)
**Founder (2026-10-23):** "I'm not versed in connecting a system to bank accounts or payroll services. That should be included in an implementation plan."

**What exists today, plainly:** the product does **not** have live bank feeds or a direct payroll connection. It has: bank **statement file import** (any bank's download CSV, matched to invoices and bills); a **payroll export file** (approved timesheets, earning codes mapped to the payroll provider's own codes, frozen after export); the **built-in books** or an **accounting file export** for bills; **single sign-on** (OpenID Connect); outbound **email** is not connected yet (O-2). Live bank feeds, payroll APIs and accounting connectors are named choices that need a provider decision (O-4), not something to invent here.

**The planner gets a "Connections" track** beside the data track. Each step is written for someone who has never done it, names who does what, and ends with a verification the customer can see:
| Step | Customer does | We do | Done when |
|---|---|---|---|
| **Bank, file route (works now)** | Finance picks the account, downloads 3 months of activity from their bank's website, uploads it | Map the bank's columns once (saved profile); set rules for regulars; match to invoices and bills | The statement's closing balance equals the books' balance for the account on that date |
| **Bank, live feed (later)** | Chooses provider, authorises read-only access in their bank | Connector once a provider is approved | Not offered until approved |
| **Payroll, file route (works now)** | Payroll admin names the provider and sends one sample import file their provider accepts | Map earning codes to the provider's codes; set pay-week start; choose summary or daily layout | A dry-run export for a past week is accepted by the provider's test import and the hours match their register |
| **Payroll, direct (later)** | Provider credentials | Connector once approved | Not offered until approved |
| **Accounting** | Chooses built-in books, or exports from existing accounting | Chart of accounts and opening balances import, account mapping; bills file export | Trial balance equals the old system's at the cutover date |
| **Sign-in** | IT supplies their identity provider details (or uses invitations) | Configure OIDC, test with two users | Two named users sign in and land in the right roles |
| **Email** | Chooses sending domain, adds DNS records | Verify domain | Test email lands, not in spam |

Each step has plain-language help ("where to click in the bank's site"), a checklist of what to bring, a safe rehearsal (in the throwaway copy), and a recorded sign-off by the finance or payroll owner. Plan depth (guided/standard/full) decides how many of these appear. Everything marked "later" is shown to the implementer as "not yet available" with the file route as the alternative, so nobody is promised a connection that does not exist.
