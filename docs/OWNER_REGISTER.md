# Owner register: what the founder owes

Items only the founder can supply: decisions, accounts, credentials, customers and sign-offs. Work does not stop for them. Each row says what has been built meanwhile, so the item becomes configuration rather than a rebuild once it arrives. Updated whenever an item is added, answered or unblocked.

**Status:** 🔴 blocks a pilot · 🟡 needed before general sale · ⚪ confirm when convenient · ✅ answered

## Blocking a pilot (the at-most-five list, brief §13)

| # | Item | Why it is needed | Built meanwhile | Status |
|---|---|---|---|---|
| O-1 | **Identity provider for sign-in** (D-008): which one (Entra ID, Google Workspace, Okta, Auth0, WorkOS, Keycloak…), then an app registration (client id and secret, allowed redirect URL) | Production sign-in. Today only the labeled development sign-in exists | Planned next: provider-independent OpenID Connect sign-in, tested against a labeled local mock provider; once provided, only configuration remains | 🔴 |
| O-2 | **Email provider and sending domain** (D-045): SES, Postmark, SendGrid or an SMTP relay; the domain to send from, with SPF, DKIM and DMARC records added to its DNS | Daily digests, payment reminders, supplier corrective-action requests, password-free sign-in links | Mail adapter interface and a development adapter (writes .eml files); every email the product sends is already built against it | 🔴 |
| O-3 | **Hosting provider, region and compliance target** (D-018): cloud account, region (US?), SOC 2 timing | Where production runs; object storage for documents; managed PostgreSQL with backups | Local file storage behind a storage interface; scripted backup and restore drill (planned next) | 🔴 |
| O-4 | **First pilot customer** (D-016): company, industry, size, sites, and which accounting and payroll systems they use | Decides the first real accounting adapter (QuickBooks Online or Xero), the payroll file format, and which workflows to polish first | Provider-independent outbox and sync, file exports, a clearly labeled MOCK accounting system, the built-in books (D-139), imports in the customer's own layouts | 🔴 |
| O-5 | **A real data sample from a prospect** (exports from their current spreadsheets, CMMS, accounting) | Proves the onboarding claim on real files rather than fictional ones | 24 import targets; saved mappings for the messy exports of 5 fictional companies | 🔴 |

## Needed before general sale

| # | Item | Why it is needed | Built meanwhile | Status |
|---|---|---|---|---|
| O-6 | **Prices and packaging** (D-015): Standard base (brief hypothesis $499/month), Lite (~$50/month), per-user prices, add-on modules, property tier (cap 100, D-127) | Commercial; the software only enforces what each licence includes | Entitlements per facility and module; editions, user and site caps, property cap | 🟡 |
| O-7 | **Store licensing** (D-086): are stores counted or capped like properties? | Retail chains | Stores are not counted or limited until decided | 🟡 |
| O-8 | **Accounting developer accounts** for the system chosen in O-4: an Intuit or Xero developer app (client id and secret) and a sandbox company | The real accounting adapter | Adapter interface, idempotency keys, retries, dead-letter, chart mapping | 🟡 (after O-4) |
| O-9 | **Legal review of the policy and handbook templates** (D-128) by employment counsel, and the product's own terms of service and privacy policy | Templates are starting points; the company owns the final text, but the templates should not mislead | Templates whose placeholders must be completed before publishing | 🟡 |
| O-10 | **Penetration test vendor** before the first paying customer (ARCHITECTURE hardening list) | Security assurance | Row-level security, audit chain, automated tenant-isolation tests | 🟡 |
| O-11 | **Lite limits** (D-135): one site and five users, confirm or change | Packaging | Enforced by database triggers; one setting to change | 🟡 |

## Confirm when convenient

| # | Item | Status |
|---|---|---|
| O-12 | The provisional technical choices (D-001 greenfield, D-002 modular monolith, D-003 stack, D-004 row-level security tenancy): confirm or challenge | ⚪ |
| O-13 | Management of change placement (D-024): core in Category 1, process-safety packs in Category 2 | ⚪ |
| O-14 | The other decisions marked **Adopted (provisional)** in DECISIONS.md: each is reversible; review in batches by area | ⚪ |

## Answered

| # | Item | Answer | Recorded |
|---|---|---|---|
| A-1 | Property pricing | A single cap of 100 properties | D-127 |
| A-2 | Built-in bookkeeping | In every edition, small-business depth only; payroll, tax filing, multi-currency and fixed-asset depreciation stay out; reversible | D-136, D-139 |
| A-3 | Lite edition | About $50/month for very small companies, upgrade path to the full product | D-135 |
| A-4 | Order of work | Finish Phase 1, then move straight into Phase 2 without waiting on owed items | this register |
