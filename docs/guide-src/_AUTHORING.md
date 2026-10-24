# Writing the user guide

Pages are body fragments in `docs/guide-src/<slug>.html`; `npx tsx scripts/build-guide.ts --check` wraps them (navigation, search, print) into `web/public/guide/` and checks links. Never edit `web/public/guide/*.html` by hand.

First line of every fragment (one comment, `|`-separated):
`<!-- title: Work orders | group: Maintenance | order: 20 | summary: One plain sentence on what this is for. -->`
Do not write `<html>`, `<head>`, `<h1>` (the title is the h1), or scripts. Start with a short intro paragraph, then `<h2>` sections (h3 below those).

## Audience and voice
- Ordinary-page readers: a shop-floor lead, a bookkeeper, a clerk, an owner. No jargon without a one-line explanation the first time. Short sentences, active voice, "you".
- Pages in the group **Administrator brief** are for the person who configures the system. They may use technical terms (RLS, OIDC, migrations, env vars) but still explain what to do, step by step.
- In ordinary pages, put admin-only detail in `<div class="admin">…</div>` boxes, kept short, with a link to the Administrator brief page.

## Accuracy rules (important)
- Describe only what the product actually does. Read the page component in `web/src/pages/`, its routes in `src/modules/*/routes.ts` and service code, permissions in `src/platform/auth/permissions.ts`, and the notes in `docs/` (DECISIONS.md, scope-changes/, EDITIONS.md, ISO9001.md). Use the exact on-screen labels (buttons, tabs, menu names) in `<span class="ui">…</span>`.
- If you cannot confirm a behaviour in code, leave it out or say it depends on setup. Never invent features, numbers, defaults, integrations, or screens. Where something is licensed (Lite vs Standard, field service per site), say so.
- Menu names come from `web/src/components/Layout.tsx`: e.g. sidebar "Maintenance → Work orders". Say which roles/permissions are needed in a `<div class="who">` box (plain role names: administrator, maintenance manager, technician, buyer, etc. — check `permissions.ts` for which role holds the permission).
- Every page: what it is for; the common tasks as numbered steps; what the statuses mean; common mistakes; "what happens next" (approvals, notifications) where relevant.

## Components (HTML)
- Steps: `<ol class="steps"><li>…</li></ol>`
- Callouts: `<div class="tip"><p>…</p></div>`, `<div class="warn">`, `<div class="admin">`, `<div class="who">`. (Their label is added automatically; do not repeat it.)
- On-screen names: `<span class="ui">Save</span>`; keys `<kbd>Enter</kbd>`; values/code `<code>`.
- Tables for status meanings and field lists; `<dl><dt>Term</dt><dd>Meaning</dd></dl>` for glossaries.
- Link to other pages as `work-orders.html` or `work-orders.html#some-heading-id` (give target `<h2 id="…">` explicit ids if you link to them). Link only to slugs in the list below. External links: avoid.
- No images, no inline styles, no inline scripts.

## Slugs (group: slug)
Start here: index, getting-started, roles-and-access, offline-and-tablets
My day: home-and-approvals, notifications-and-reminders, time-and-expenses, training-and-performance, my-settings
Company: news-people-policies, improvements
Maintenance: assets, work-orders, preventive-maintenance, storerooms, chemicals-and-reagents, scan-station, equipment-qualification
Field service: field-service, field-service-my-day
Service companies: projects, time-and-billing, retainers-and-subscriptions, staffing-and-utilization, support-tickets, customer-portal
Production: production-orders, planning, shop-floor-and-shift-log
Quality and safety: quality, capa-and-8d, document-control, cleanrooms, safety, changes-and-notices, temporary-sop-changes, continuity, conditions-and-visits
Sales and supply: customers, quotes-and-orders, customer-rfqs, purchasing, supplier-rfqs, leasing
Finance: books, budgets, business-cases, receivables, payables
Insight: reports, what-is-late
Administrator brief: admin-first-week, admin-sites-and-people, admin-sign-in, admin-features-and-editions, admin-reminders-and-retention, admin-importing-data, admin-implementation-planner, admin-archives-and-recovery, admin-accounting-connection, admin-scheduled-jobs, admin-security-and-operations
Reference: glossary, faq-and-troubleshooting, permissions-table
