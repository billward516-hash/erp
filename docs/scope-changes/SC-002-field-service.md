# SC-002 Field service: contracts, scheduled visits, dispatch, technicians, trucks and tools

**Requested by:** founder, 2026-10-23 ("If a company's business is to maintain other people's equipment on a frequency I'll want a module to track and dispatch that service and manage a fleet of service techs and their trucks or tools").
**Status:** proposal, **not approved**. Nothing is built. Brief §12.9 gate items (a)-(g) below; five questions at the end decide the size.

**Answer first:** most of this already exists in pieces, because the platform maintains *our own* equipment. What is missing is the turn to *someone else's* equipment: a customer's service agreement, its covered equipment at the customer's site, visits generated on the agreed frequency, a dispatch board, and the fleet (vehicles, truck stock, tools). I estimate **5-6 weeks** for a useful first version (agreements, scheduling, dispatch, truck stock and tools, billing hand-off), with route optimisation, customer portal and GPS left out.

## (a) Target customer and workflow
Service companies whose revenue is maintaining customers' equipment on a schedule: compressed air, HVAC/refrigeration, elevators, fire and life safety, generators, forklifts, commercial kitchens, calibration labs. 5-60 technicians.
1. Sell a **service agreement** to a customer: covered equipment, visit frequency (monthly/quarterly/by meter), response time, price.
2. The system **generates the visits** ahead of time and lists those due or overdue by customer and contract.
3. A coordinator **dispatches**: picks a visit, sees which qualified, available technician and truck can take it, assigns it.
4. The technician works from the **phone app** (offline), follows the checklist, uses parts from the **truck stock**, records findings and the customer signs.
5. The visit **bills** (per visit or against the contract) and any repair found becomes a quote or a follow-up job.
6. Managers see **fleet and technician utilisation**, first-time fix, SLA compliance and contract profitability.

## (b) Measurable value
- Missed or late contractual visits become visible before the customer calls (contract renewal is the retention lever).
- Technician hours on site against hours driving; revenue and cost per contract; first-time-fix rate; truck stock-outs; tools out of calibration while in a truck.
- Opens a customer type the product does not serve today (maintenance businesses, not maintenance departments).

## (c) Reused entities and workflows
| Need | Already built |
|---|---|
| Who the customer is, quotes, orders, invoices, payments, aging | CRM, sales, receivables, built-in books |
| Visit frequency by time or meter, checklists, parts per visit | PM plans, meters, repair templates, kits |
| Equipment records | Assets (add: owned by a customer, located at a customer site) |
| Customer sites | Sites and contractors (S10a), site visits and visit templates (S10c) |
| Response and resolution targets | Service levels |
| Work done, labor, parts, findings | Work orders, labor, parts |
| Technician skills and who may work on what | Qualifications, asset requirements, learning |
| Phone use in the field, offline | Technician PWA (S3b) |
| Truck stock | Stock locations and transfers, lots and serials, reorder |
| Tools and instruments | Calibration plans and records |
| Time, expenses (fuel, tolls) | Time and payroll, expenses |
| Approvals, audit, reports, archive | Shared engines |

**New:** service agreement and covered-equipment list; visit generator tied to agreements; dispatch board (calendar of technicians and trucks); vehicles (maintenance, inspections, mileage, assigned technician); tool assignment and check-out; customer sign-off; contract profitability report.

## (d) Cost
- **Build:** agreements + visit generator ~1.5 weeks; dispatch board and technician assignment ~1.5 weeks; vehicles, truck stock and tool check-out ~1.5 weeks; sign-off, billing hand-off and reports ~1 week.
- **Ongoing:** moderate. The dispatch board is the most-used screen, so it needs care for large days; scheduling rules need a few real customers to tune.

## (e) Usability and implementation
A service company would load customers, covered equipment (import exists), agreements and technicians, then the visits appear. A small company can run it without the dispatch board (coordinator uses the visit list); the board is the step up. Packaging proposal: a separate **Field Service** add-on, since it is a different customer, not a larger plan for the same one.

## (f) Native vs integration vs defer
- **Native:** agreements, visits, dispatch, truck stock, tools (coupled to assets, work orders, qualifications, inventory and billing).
- **Integration (later):** mapping/routing and GPS (a link to a maps provider; no invented integration, to be chosen with the customer), accounting already covered.
- **Deferred:** route optimisation, customer self-service portal, automatic ETA texts, telematics from vehicles, regulated inspection forms per trade (elevator, fire code).

## (g) Dependencies and tests
Depends on assets, PM, work orders, sales, receivables, qualifications, stock locations, PWA (all built). Tests: agreement generates the right visits for a time and a meter frequency; a visit cannot be assigned to an unqualified technician; truck stock cannot go negative and replenishes from the warehouse; a tool past calibration cannot be checked out; completed visit bills once; isolation between companies; two-year dataset check on a 25-technician fleet.

## Questions that decide the size (blocking only the first)
1. **Who is the first customer type?** (HVAC, compressed air, elevators, fire, other). It decides the checklist and regulatory forms in version 1.
2. **Is this a separate add-on for a different customer, or part of the existing plans?**
3. Do technicians need to be scheduled around **availability and skills only**, or also **drive time between stops** (needs a maps provider)?
4. Are covered units **bill-per-visit**, **flat monthly**, or both?
5. Should customers **sign on the technician's phone** (included) or also receive emailed reports (needs outbound email, which is not yet connected)?

## Founder's answers (2026-10-23)
1. First customer type: "hav or fleet drive" (read as HVAC, and fleet/drive equipment; **to confirm**).
2. **Advanced edition feature**, not in Basic or Lite.
3. Yes to all: schedule on availability, skills **and** drive time.
4. Pricing: **both** per-visit and flat monthly (contract) billing.
5. Customer signs on the technician's phone. **Added requirement:** service crews submit a **service report form from a tablet**; the report drives (a) **billing** of the visit and (b) **quotes for other required service** found on site.

## Effect on the proposal
- Edition gating: Field Service sits with the advanced features (D-135 editions); Lite and Basic hide it.
- Service report form: structured form per service type (checklist, readings, labor, parts used, findings, photos, customer signature); on submit it posts labor and parts to the visit's work order, raises the visit invoice (per-visit) or draws on the contract (flat monthly), and each "recommended repair" line can become a draft quote for the customer in one tap. Needs tablet layout in the technician app (offline-capable like the phone views).
- Drive time needs distances. Without choosing a maps provider (not invented): coordinates per site and truck, straight-line distance with a typed road factor and average speed, good enough to rank technicians; a provider can replace it later. Estimate +0.5 week for the report-to-quote flow, drive-time estimate within the dispatch board budget: now **6-7 weeks**.
