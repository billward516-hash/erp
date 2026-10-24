# SC-009 Service-company core: projects, billing, retainers, utilization, support tickets, customer portal

**Requested by:** founder, 2026-10-24 ("Build the features that make it useful for service companies."). Supersedes the hold D-185 (decision D-187).
**Status:** in build. Phase 1 (this change): projects and costing, rates and billing runs and retainers, staffing and utilization, support tickets with response targets. Phase 2: customer portal, interview recommendations, sample company, guide, preview.

**Answer first.** Service companies (consulting, agencies, accounting and legal practices, IT and managed services, engineering and inspection firms, and the office side of field-service contractors) earn by people's time, projects and recurring fees. The platform already has customers, quotes, invoices and payments, timesheets with approval, expenses, built-in books, training and qualifications, documents and approvals. It lacks the record that ties them together (the project) and the billing and staffing logic around it.

## (a) Workflow
1. **Projects:** a project belongs to a customer (or is internal), has a billing type (time and materials, fixed price, retainer, non-billable), tasks or phases with hours and money budgets, milestones, a team, an owner. People record time and expenses against it from their timesheet and expense report. The project page shows budget against actual hours and cost, billed to date, unbilled work, margin and what is at risk.
2. **Rates and billing:** rate cards by role, person, customer or project, with effective dates; cost rates per person for margin. A billing run takes approved billable time, expenses and reached milestones for a project or customer and period, shows a draft invoice for review, and creates it in receivables (numbering, PDF, accounting sync unchanged). Fixed-price projects bill by milestone or percent complete. Statements of work and change orders change the contract value with an approval.
3. **Retainers and subscriptions:** a plan (amount, interval, start, end or renewal, proration) generates draft or issued invoices on schedule from the daily job; pause, change, cancel and renew; monthly recurring revenue and churn reports.
4. **Staffing and utilization:** people are assigned to projects with planned hours per week; capacity comes from working hours and time off; utilization is billable hours over available hours with a target per person or team; a bench and over-allocation view; a forecast of next weeks.
5. **Support tickets:** a queue of customer requests with priority, response and resolution targets by service level (business hours), assignment, internal and customer-visible notes, time logged against a ticket (billable to a project or a retainer), breach warnings and What is late, reports on attainment.
6. **Phase 2, customer portal:** customer users sign in to see their projects (status, milestones, hours), invoices, tickets and shared documents, and raise tickets; scoped strictly to their own customer.

## (b) Value
Billable work no longer goes unbilled; each project's margin is known while it can still be changed; recurring fees invoice themselves; people are neither idle nor overbooked; customers are answered inside agreed times.

## (c) Reused
Customers and contacts, quotes and sales orders, receivables (invoices, PDFs, payments, credit memos, accounting sync), timesheets and approvals, expense reports, employees and time off, field-service rates and billing rules where they fit, approvals, notifications and the daily job, What is late, report registry, documents, imports, features and editions, audit.

## (d) New
Project, task, milestone, budget, team; cost and bill rates; billing runs and their audit; contract value changes; recurring plans and schedules; assignments, capacity and utilization targets; tickets, service levels, ticket time; reports for each; and (phase 2) customer users and the portal.

## (e) Native vs integration
Native. Invoices flow to accounting through the existing outbox. No email-in for tickets, no calendar sync, no payment collection from the portal (those need a mail or payment provider and are named as follow-ups). Tax calculation stays as it is (an amount on the invoice).

## (f) Assumptions recorded as decisions (change on request)
- Feature keys `projects`, `billing_runs`, `retainers`, `utilization`, `tickets` (phase 2 `portal`); Standard edition; each switchable alone.
- Money is in the company's single currency (as everywhere in the product).
- A billing run only bills approved timesheet hours, approved expenses and reached milestones; it never bills twice (each time entry and expense is stamped with its invoice line).
- Cost rates are visible only to people with a cost-rate permission (margin must not leak to all staff).
- Utilization counts hours on non-billable internal projects as available-but-not-billable, as set per task.

## (g) Tests
Project and task budgets; time against projects through timesheets; cost and margin arithmetic; rate resolution order; billing run totals, no double billing, milestone and percent-complete billing; retainer schedule, proration, pause and renewal without duplicate invoices; capacity, over-allocation and utilization arithmetic; ticket targets in business hours, breach and pause rules; permissions, cost-rate privacy, tenant and site isolation; schema-index guard.
