# Fit assessment: landlords and retail operations

**Answer first.** Out of the box the platform is a good fit for the *maintenance and compliance* side of both
segments. It is not a fit for their *revenue* side.
- **Retail chains:** a reasonable fit for facilities maintenance, contractors, store safety and training once
  multi-site and contractor gaps are closed. It should not try to become a retail system (POS, merchandise,
  replenishment, pricing, labor scheduling).
- **Landlords:** a poor fit until four gaps are closed:
  - properties are expensive to set up and price as plants
  - units are not assets
  - most repair work goes to contractors, not employees
  - there are no leases or rent

These slices close the gaps by reusing existing entities:
- **S10a** multi-site portfolios and contractors (shared by both segments)
- **S10b** leasing for landlords
- **S10c** store operations for retail

This is outside the brief's initial target market (§2: manufacturers, 10–150 employees). It is built because the
founder asked for it, as reversible additions behind the same permissions. The pricing question below is the
founder's to answer.

## Status (after S10a–S10c)

Built: sites by kind with portfolio/region/district groups and group grants; spaces as assets; request links without sign-in and a request inbox; contractors with insurance check, not-to-exceed and invoices tied to work orders; service levels; leasing (rent roll, leases, prorated rent billing through receivables, unit turns); condition logs with excursions; store visit checklists. Still not built, by design: POS, merchandising, replenishment, labor scheduling, owner statements, screening, listings, rent payment portals, late-fee rules. Licensing: properties in bands of up to 100 (decided, D-086/D-112); stores still open.

## Where each segment stood before S10

| Need | Landlord | Retail | Today |
|---|---|---|---|
| Many sites, managed by portfolio, region or district | ●●● | ●●● | ⚠ Facilities exist, but only at provisioning; roles are granted one facility at a time; no grouping |
| Units, suites and common areas as places that get work | ●●● | ●● (sales floor, back room, restrooms) | ✗ Work orders and requests need an equipment asset |
| Equipment registry, PM, documents, QR codes | ●● (HVAC, boilers, elevators, appliances) | ●●● (HVAC, refrigeration, lighting, doors) | ✅ Fits as is |
| Contractors do most of the work | ●●● | ●●● | ✗ Work orders are assigned to employees only; supplier invoices are not tied to work orders |
| Not-to-exceed limits and service levels for vendors | ●● | ●●● | ✗ |
| Requests from people without a login (renters, store staff) | ●●● | ●● | ✗ Requests need a user |
| Recurring compliance inspections (fire, elevator, backflow, gas) | ●●● | ●●● | ✅ PM plans with calendar intervals, certificates as documents |
| Leases, rent roll, rent billing, deposits | ●●● | — | ✗ (customer invoices exist, but only from shipments) |
| Unit turns (move-out → make-ready → re-let) | ●●● | — | ✗ |
| Refrigeration temperatures, condition limits | ● | ●●● | ⚠ Meter readings exist, but have no limits or alarms |
| Store visits and opening checklists | — | ●●● | ⚠ Internal audits exist, but are built for ISO audits |
| Safety incidents, training, SOPs | ●● | ●●● | ✅ Fits as is |
| Budgets and proforma per property or store | ●● | ●● | ⚠ Proforma tool exists, not per site |
| POS, merchandise, pricing, replenishment, labor scheduling | — | ●●● | ✗ **Not built.** These belong to the retailer's POS/merchandising system; integrate later if asked, do not invent an integration |
| Owner statements, trust accounting, tenant screening, listings | ●●● | — | ✗ **Not built.** Accounting stays in the accounting system (D-040); screening and listings are third-party services |

●●● essential · ●● important · ● nice to have

## Capability cases (brief §"before approving any new capability")

### S10a Multi-site portfolios and contractors
- **(a) Customer and workflow.** A landlord's property manager covers 40 properties and dispatches a plumber with a $500 not-to-exceed. A retail facilities manager covers a district of 12 stores and holds HVAC vendors to a 4-hour response.
- **(b) Value.** Without it, neither segment can run work through the platform at all. Contractor spend is typically the largest controllable maintenance cost for both.
- **(c) Reuse.**
  - facilities (with a kind and address)
  - suppliers as contractors
  - work orders, with the vendor, not-to-exceed amount and vendor status added
  - supplier invoices tied to the work order, using the existing variance-note approval
  - mail adapter (D-045) for dispatch
  - role assignments, extended to facility groups and expanded at sign-in, so row-level security is unchanged
- **(d) Cost.**
  - New: one migration, a service, and the import target for sites.
  - Ongoing: service-level settings per tenant.
- **(e) Usability.** One more field on the work order (who does it: our technician or a contractor) and a site picker that understands groups.
- **(f) Native vs integration.** Native: dispatch is a record plus an email. Vendor portals and marketplaces are integrations, deferred.
- **(g) Tests.** Group grants see member sites and nothing else. Dispatch, not-to-exceed and invoice variance. Service-level clock. Public request intake: rate limits, nothing leaked.

### S10b Leasing (landlords)
- **(a) Customer and workflow.** A landlord with 300 units bills rent monthly, tracks who is late, turns vacant units quickly and sees occupancy by property.
- **(b) Value.** Rent roll and turns are the daily screen of a property manager; without them the maintenance side has no context (who lives there, is the unit vacant).
- **(c) Reuse.**
  - units are assets of class `space` (so they get work orders, QR codes, documents and cost history)
  - renters are customers
  - rent is billed as customer invoices: the existing issue flow, payments, aging, collections and accounting sync
  - unit turns group work orders
- **(d) Cost.**
  - New: one migration, a leasing service, rent run, two reports.
  - Ongoing: none beyond normal maintenance.
  - Not built: late-fee rules and deposit accounting, both jurisdiction-specific.
- **(e) Usability.** A rent roll page per property; the rent run is one button with a preview.
- **(f) Native vs integration.** Native: rent roll and billing. Integration (deferred): online rent payment, screening, listings, owner statements in accounting.
- **(g) Tests.** Rent run is idempotent per lease and month. Proration on move-in. Lease overlap is refused. Turn timing, rent roll totals.

### S10c Store operations (retail)
- **(a) Customer and workflow.** A district manager walks 12 stores a month with a checklist. Store staff log cooler temperatures twice a day. An out-of-range reading becomes a request before the stock spoils.
- **(b) Value.** Food-safety and brand-standard compliance, and fewer emergency refrigeration calls.
- **(c) Reuse.**
  - condition readings use the existing meter readings, with limits added
  - an out-of-range reading opens a maintenance request
  - store visits reuse the audit checklist engine with a lighter `store_visit` type; findings use the shared actions
- **(d) Cost.**
  - New: one migration, small services, one report.
- **(e) Usability.** Readings entered from the asset QR code on the cooler.
- **(f) Native vs integration.** Native: readings, limits and checklists. Integration (deferred): temperature sensors (D-008 telemetry is still open).
- **(g) Tests.** Limits raise one request per excursion, not one per reading. Visit scoring and actions.

## Open question for the founder (blocking for pricing, not for build)

**Q-PR1. How are properties and stores licensed?** The brief prices extra facilities at about $199 a month (§ cross-cutting foundations). At that rate a 300-property landlord or a 60-store chain costs more than any comparable product.

The software treats a property or store as a facility, because that is the access boundary (a property manager sees only their portfolio). Facilities now have a **kind** (plant, property, store, warehouse, office), so licensing can price kinds differently, for example per unit or per store band.

**Decided for properties (2026-10-22, revised the same day):** property management has a single cap of 100 properties (D-127, replacing the earlier bands). The software counts active properties against the cap and refuses the 101st; inactive properties do not count. The cap can be set lower for a smaller plan but never above 100. Portfolios above 100 properties are not served by this plan; the price is set commercially, not in the software.

**Still open for stores:** stores, plants and other kinds are not counted or limited until decided (D-086).
