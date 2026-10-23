# Intellectual Property Protection & Commercialization Readiness Audit

**Status:** Deferred until usability testing is complete  
**Audience:** Claude Code / development team  
**Mode:** Read-only assessment — no implementation authorization

## Purpose

Assess the completed ERP, CRM, LMS, and manufacturing operations platform for risks of unauthorized copying, redistribution, source-code exposure, reverse engineering, and misuse. Recommend practical protections that preserve the tested application's functionality and avoid unnecessary redesign.

**Start condition:** The product owner will explicitly authorize this audit **after usability testing**. Do not run it or make changes before that authorization.

## Non-negotiable rules

1. **Read only.** Do not edit source, configuration, dependencies, infrastructure, database schemas, access policies, or deployment settings.
2. Do not run migrations, deploy, install packages, rotate credentials, or execute potentially destructive commands.
3. Do not expose or copy secrets, customer information, employee information, proprietary datasets, or sensitive logs into reports.
4. Do not upload source code or proprietary content to external services as part of this audit.
5. Preserve the existing architecture where practical. Distinguish essential remediation from optional improvements.
6. Support every material finding with specific evidence: repository-relative file paths, configuration references, or reproducible observations. Redact sensitive details.
7. Clearly label findings as **Confirmed**, **Likely**, or **Needs verification**. Do not infer deployed security solely from development configuration.
8. Do not implement recommendations until the product owner approves a separate implementation plan.

## Scope

Review all existing modules and shared platform services, including where present:

- ERP, inventory, purchasing, order management, and related workflows
- CRM and customer/account management
- LMS: courses, certifications, assessment delivery and storage, video, instructor-led learning, self-directed learning, shadowing, and evidence tracking
- Manufacturing analytics, yield/defect analysis, production planning, equipment reliability, and maintenance
- FMEA, business continuity, technical documents, tool-specific troubleshooting guides
- Reporting, exports, dashboards, and data visualization
- Authentication, authorization, tenant isolation, APIs, integrations, storage, licensing, and deployment

Discover the actual implemented modules rather than assuming that all listed capabilities exist.

## Workstream 1 — Architecture and distribution exposure

Document the actual technology stack, application topology, runtime boundaries, build process, and deployment options. Determine whether the application is browser-hosted SaaS, locally installed, customer-hosted, hybrid, or a combination.

For each material component, identify:

- Where its code executes: browser, trusted server, customer-controlled host, or desktop client
- What source, bundles, source maps, assets, or configuration customers can obtain
- Whether proprietary calculations, workflow rules, or algorithms are delivered to customers
- What a customer or competitor could realistically reconstruct by inspecting UI behavior and API traffic
- Whether deployment artifacts contain source code, credentials, internal documentation, or debug information

Distinguish **copying the original code** from **independently recreating similar functionality**. Do not claim that SaaS makes copying or reverse engineering impossible.

## Workstream 2 — Repository, build, and operational security

Inspect, without changing:

- Repository visibility, access model, branch protections, and collaboration arrangements
- Secrets management, environment variables, key handling, and credential exposure
- CI/CD permissions, deployment tokens, artifacts, backups, and restore processes
- Production versus development configuration, debug endpoints, source maps, and static-file exposure
- Dependency inventories, license notices, vulnerable dependencies, and software supply-chain practices
- Logging, audit trails, incident detection, and administrative access

Never include secret values in outputs. Flag items requiring access to production settings as **Needs verification** if the repository alone cannot establish them.

## Workstream 3 — Authentication, authorization, and tenant isolation

Assess the design and implementation of:

- Authentication, sessions, password recovery, MFA readiness, and administrative privileges
- Role-based and organization-level permissions
- Server-side enforcement of module access and API permissions
- Cross-tenant isolation for records, reports, files, exports, searches, and background jobs
- Storage and database access boundaries
- Abuse controls such as rate limiting and audit logging

Identify any frontend-only restrictions that could be bypassed. Recommend tests, but do not perform intrusive penetration testing against production or third-party systems.

## Workstream 4 — Licensing and commercialization readiness

Inventory any existing entitlements, billing, subscriptions, trial, usage, or customer-organization functionality. Assess the smallest safe path to support:

- Organization, site, seat, and module-based licenses
- Trials, renewals, expiration, grace periods, and account suspension
- Server-enforced entitlements for both UI and API access
- Feature packaging and upgrade/downgrade handling
- Billing-provider integration and administrative oversight
- Customer data export and offboarding

Recommend a modular-monolith approach when appropriate; do not prescribe microservices or a rewrite without evidence.

## Workstream 5 — IP ownership and legal review flags

Prepare a **legal-review checklist**, not legal conclusions. Identify:

- Third-party and open-source dependencies with potentially relevant distribution or attribution obligations
- Any copied or externally sourced code/assets requiring provenance review
- AI-assisted development records and evidence of human-authored design, specifications, and modifications
- Possible employer, contractor, or collaborator ownership issues for the owner to review with counsel
- Candidate copyright, trade-secret, trademark, and contractual protections

Do not conclude that AI-generated code is automatically protected or unprotected by copyright. Refer legal ownership and enforceability questions to qualified counsel.

## Risk assessment method

For each finding, record:

| Field | Required content |
|---|---|
| ID | Unique identifier |
| Finding | Plain-English description |
| Evidence | Repository-relative path, reference, or observation |
| Confidence | Confirmed / Likely / Needs verification |
| Exposure | What an attacker, customer, or competitor could obtain or do |
| Impact | Critical / High / Medium / Low |
| Likelihood | High / Medium / Low, with rationale |
| Remediation | Least disruptive practical control |
| Effort | Small / Medium / Large, with assumptions |
| Regression risk | Low / Medium / High |
| Dependencies | Prerequisites and affected modules |
| Validation | How to verify the fix safely |

Do not treat cosmetic obfuscation as a substitute for server-side protection. Do not treat legal contracts as a substitute for technical security.

## Prioritized remediation groups

### A — Immediate containment and hardening

Identify low-disruption steps to reduce source, credential, deployment, and administrative-access exposure.

### B — Commercial licensing controls

Identify steps for organization-level customer management, module entitlements, subscriptions, and enforceable server-side authorization.

### C — Architectural changes, only where necessary

Identify exposed proprietary logic or distribution models requiring changes to execution boundaries, packaging, or hosting. Describe alternatives and migration risks before recommending any major refactor.

For each group, distinguish **must do before first external customer**, **recommended before scaling**, and **optional later**.

## Required deliverables

Create these four Markdown files in an audit output folder without altering the application:

1. **`IP_PROTECTION_AUDIT.md`** — Executive summary, architecture map, evidence-based findings, overall exposure assessment, and explicit unknowns.
2. **`IP_RISK_REGISTER.md`** — Prioritized risk table using the assessment fields above.
3. **`COMMERCIALIZATION_READINESS.md`** — Deployment, tenancy, licensing, billing, customer onboarding/offboarding, dependency/provenance, and legal-review readiness.
4. **`IP_PROTECTION_IMPLEMENTATION_PLAN.md`** — Phased, dependency-aware recommendations with effort, regression risk, test approach, and decision gates. **Plan only; do not execute.**

Use concise, executive-consulting-style writing: clear headline conclusions, structured tables, evidence, prioritized actions, and explicit decisions requested of the product owner. Do not invent numerical cost estimates or claim that security is guaranteed.

## Completion criteria

The audit is complete when the product owner can answer:

1. Can a customer obtain or reconstruct the **complete deployed application**? Under what conditions?
2. Which proprietary algorithms and business rules are currently exposed?
3. What must be secured **before** an external customer gets access?
4. How can module licensing be introduced with minimal disruption?
5. Which changes risk breaking usability-tested functionality?
6. What ownership, licensing, and legal issues need professional review?
7. What should be implemented first, and what can safely wait?

**Final instruction:** Stop after producing the four reports. Summarize the highest-priority findings and request explicit approval before modifying any application code or infrastructure.
