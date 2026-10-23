# Fit assessment: food service

**Answer first.** For the *operations and compliance* side of a restaurant group, commissary or caterer the platform covers about two thirds of what a manager asks for each day: equipment maintenance, temperature logs, ordering and receiving, lot traceability with expiry, training and food-handler certificates, incidents, audits, shift passdown, bills and books. It is **not** a fit yet for the *kitchen's own numbers* (recipes, plate cost, yield and waste, food-cost percentage), for **HACCP plans** as such, or for anything that reads a **point-of-sale** system. Three additions would close most of the gap; none is built, and none should be before a food-service customer confirms the order.

## What already serves a food-service business

| Need | What exists | How well |
|---|---|---|
| Walk-in, freezer and hot-holding temperature logs with limits | Logged conditions with limits, interval, excursions that raise one request (S10c) | **Good**; paper-log import included |
| Equipment upkeep (fryers, hoods, refrigeration, dish machines) | Assets, PM by calendar or meter, work orders, contractors with insurance and not-to-exceed, request links without sign-in | **Good** |
| Cleaning and sanitation schedules | PM plans and store visit checklists | **Workable**; not a dedicated sanitation log |
| Ordering to par, receiving, supplier prices and performance | Stock with reorder points, purchase requests and approvals, receiving, supplier scorecards, nonconformance at receiving | **Good**; no order guides per day of week |
| Lot trace, expiry and recall reach | Lots and serials, shelf life, expiry report, forward and backward trace, holds | **Good** |
| Food-handler and allergen training, expiry of cards | Courses, assessments, qualifications with validity, gating of tasks, certificates | **Good** |
| Incidents (burns, cuts, slips), near misses, injury rates | Safety module, recordable counts, CAPA/8D | **Good** |
| Health-inspection and internal audit | Audits with findings and actions | **Workable** |
| Shift passdown between kitchen shifts | Shift log with carried items | **Good** |
| SOPs, work instructions, allergen statements, spec sheets | Document server, read-and-understood, in-app work instructions with photos | **Good** |
| Many locations, region and district rollups | Sites, groups, district manager role | **Good** |
| Payables, receivables for catering, expense reports, payroll file | Built-in books, bank statement import, timesheets with payroll export | **Good**; no tips handling |

## What is missing

| Need | Gap | Smallest useful addition |
|---|---|---|
| Recipes, plate and batch cost, yield and trim | No recipe or menu item entity; bills of material exist for manufacturing | **Recipes and costing**: a recipe is a bill of material with yield and unit conversions; cost rolls up from current purchase prices; food-cost % needs sales (below). ~3 weeks |
| Waste and prep logs | None | Waste log by reason on the stock ledger (spoilage, over-production, plate return); reuses adjustments. ~1 week |
| HACCP plan and records | Condition logs cover monitoring only; no hazard analysis, critical limits per CCP, verification, corrective-action records or plan versions | **Food-safety plan**: a controlled document set (existing) plus CCP monitoring on condition points, corrective action on every excursion, verification sign-offs, an inspector-ready record export. ~3 weeks |
| Allergen matrix | None | Allergen flags on ingredients, rolled to recipes; matrix report. ~1 week after recipes |
| POS sales (theoretical vs actual usage, food-cost %) | No point-of-sale connection or import | **Sales mix import** from the POS's daily item-sales export (file, any POS that exports): menu item, quantity, date → theoretical usage from recipes. Direct POS connectors are a per-vendor decision, none assumed |
| Labor scheduling and tip pooling | None | Out of scope on purpose; payroll file export covers hours |
| Catering/event orders | Sales orders exist but are product-oriented | Defer until asked |

## Order of build if a food-service customer signs

1. Food-safety plan on the existing condition logs and documents (the audit-critical piece).
2. Recipes and costing with waste logging.
3. Sales-mix import and food-cost reporting.

Each needs the capability case first (brief §12.9): target customer, measurable value, reuse, cost, packaging, native versus integration, tests. The reuse is high: stock, lots, purchasing, conditions, documents, training and audits are all built.

## Questions for the first food-service prospect
Number of locations and whether a commissary supplies them; which POS and what it can export; whether a written HACCP plan is required by their jurisdiction or customers; who signs temperature logs today; how they cost recipes now; what the last inspection asked for.
