# SC-008 Business-case diagnosis in the fit interview; professional-services core held

**Requested by:** founder, 2026-10-24 ("Hold the features that make it useful for service companies. The implementation onboarding interview has to include many questions to diagnose the business case.").
**Status:** built. Extends SC-004 (the fit interview). Decisions D-185 and D-186.

**Answer first.** The professional-services core (projects with budgets and milestones, billing of hours by client, billable utilization, automatic retainers and subscriptions, a customer portal, a support queue with response targets) is **held**: not built, not scheduled, until interview evidence shows demand. The interview grows from 24 to about 60 questions in eleven sections, branching so a company sees only what applies, and now produces a diagnosis, not only a feature list.

## (a) Workflow
Admin → Fit interview. Sections: about the business, why now, how you earn and bill, equipment stock and buying, laboratories and cleanrooms, proof and compliance, people and money, size of the data, readiness, your own numbers, goals and decision. Question kinds: single, multi, yes/no, number (with unit and range) and short text. The result adds: **your own numbers** (arithmetic on what was typed, labelled as exposure not savings, with each 10% shown), **measure these first** (a metric and the report that shows it, per problem named), **readiness** (plain flags: owner, who runs it, data state, sign-in, named risks, timeline against size), **goals and success sentence**, and **held needs** (what was asked that the product does not serve yet).

## (b) Value
A prospect or a new customer leaves the interview with a recommended set of features, a plan depth, a baseline to measure, an honest list of what is not there, and a record of the demand that tells us whether to build the held features.

## (c) Reused
The interview engine, stored answers and recompute, Features, the implementation planner steps, the report registry names, lab and cleanroom feature keys from SC-007 (recommended when they exist).

## (d) New
Question sections and the number and text kinds with validation; business-case arithmetic; measures map; readiness flags; held-needs list; `scripts/fit-demand.ts` (operator tool across companies, read-only).

## (e) Native vs integration
Native; no external service. The held-needs list is the only place the held features appear.

## (f) Decisions
- D-185: the professional-services core is held. Recorded needs: hourly billing, projects, utilization, recurring billing, client portal, ticketing, job-cost margin, point-of-sale, live instruments, recipes, 17025-shaped records.
- D-186: the business case lines multiply only numbers the company typed; no benchmark or percentage saving is assumed anywhere. Interview version 2; version 1 answers stay valid (same ids).

## (g) Tests
Question count and sections contiguous; branching by business type; held needs for a professional-services answer set without operations features; arithmetic of every line; readiness levels; number and text validation through the API.
