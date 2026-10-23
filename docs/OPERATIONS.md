# Operations runbook

What it takes to run this system for a real company. Everything here is derived from the code in this repository; items the code cannot settle (hosting provider, mail provider, identity provider) are listed under "Owner decisions" and are not assumed.

## 1. Shape of a deployment

- One Node 22 process (`npm start`, which runs `src/server.ts`) serving the API and the built web app (`npm run web:build` first).
- PostgreSQL 16. Two database roles: the **owner** role (`DATABASE_ADMIN_URL`, runs migrations and the daily jobs that need to cross companies) and the **application** role (`DATABASE_URL`, subject to row-level security). They must be different roles.
- A persistent directory for uploaded files (`STORAGE_DIR`). There is no object-storage adapter yet (known gap, ARCHITECTURE §9): the directory must be on a persistent volume and be backed up with the database.
- A reverse proxy or load balancer terminating HTTPS in front (set `TRUST_PROXY=1`).
- One process only for now: the rate limiter and the daily scheduler keep state in memory. Run a single instance; restart is safe (the daily job is idempotent by dedupe keys).

## 2. Configuration

The server refuses to start in production (`NODE_ENV=production`) when a required value is missing or unsafe (`src/platform/config-check.ts`); warnings are logged.

| Variable | Required | Notes |
|---|---|---|
| `DATABASE_URL` | yes | application role; must not be the owner role; no development passwords |
| `DATABASE_ADMIN_URL` | yes | owner role |
| `APP_BASE_URL` | yes | `https://` public address, used in links and the sign-in redirect |
| `SSO_SECRET_KEY` | yes | 32 random bytes, base64-encoded (`openssl rand -base64 32`); encrypts stored identity-provider client secrets. **Losing it means re-entering them.** Back it up separately from the database |
| `STORAGE_DIR` | warned | persistent volume path |
| `TRUST_PROXY` | warned | `1` behind one proxy, so rate limits see real client addresses |
| `METRICS_TOKEN` | warned | enables `/metrics` (404 otherwise) for a scraper presenting the token |
| `PORT`, `LOG_LEVEL`, `MAX_UPLOAD_BYTES` (default 50 MB), `RATE_LIMIT_PER_USER` (1200/min), `RATE_LIMIT_PER_ADDRESS` (120/min), `MAIL_FROM` | no | |
| `DAILY_JOB_ENABLED`, `DAILY_JOB_HOUR_UTC` | no | built-in scheduler, default on at 06:00 UTC |

## 3. First deployment

1. Create the two roles and an empty database (the roles must exist before the migrations, which grant to them; `scripts/dev-db.sh` shows the development equivalent).
2. `npm ci && npm run web:build`.
3. `npm run db:migrate` with `DATABASE_ADMIN_URL` set. Migrations are forward-only and recorded in `schema_migration`.
4. Start the server. Check `GET /health` (process up) and `GET /ready` (database reachable, every migration of this build applied; 503 otherwise).
5. Provision the first company and administrator with the provisioning function used by the seed scripts (`provisionTenant`); sign-in is then through the company's OpenID Connect provider (Settings → Single sign-on) or an issued API token.

## 4. Upgrading

1. Take a backup (section 5).
2. Deploy the new build, run `npm run db:migrate`, restart. `/ready` stays 503 until every migration has applied, so a load balancer holds traffic off a half-upgraded instance.
3. Rolling back code is safe only while no new migration has been applied; otherwise restore the backup. Migrations are not reversible.

## 5. Backup and recovery

- **Database:** provider point-in-time recovery if managed, otherwise nightly `pg_dump` (custom format) of the database plus `pg_dumpall --roles-only`.
- **Files:** snapshot `STORAGE_DIR` at the same time as the dump. A restored database with older files (or the reverse) shows missing attachments, not corruption.
- **Secret:** keep `SSO_SECRET_KEY` in the secret store.
- **Drill:** `npx tsx scripts/backup-drill.ts` dumps, restores into a scratch database, and checks migrations, row counts per table, every company's audit chain, and that row-level security still fails closed. Its restore time is the recovery-time evidence. Run it against a restored production snapshot at least quarterly, and keep the report.
- **Per-company:** the system takes a company archive every 30 days and can restore a single record or roll a company back (archives); use this for "undo a bad import", not for disaster recovery.

## 6. Monitoring

- `/health` and `/ready` for probes; alert on `/ready` failing for more than a minute.
- `/metrics` (Prometheus text, token required): request counts and latency histograms by route and status, rate-limit refusals. Alert on 5xx ratio and p95 latency.
- Logs are JSON (pino) with a request id (`x-request-id`, echoed to the client) and credentials redacted.
- Daily job: check the audit trail / notifications for the "daily job" summary; a day without one means the scheduler did not run.
- The audit hash chain can be verified at any time (`verifyAuditChain`, run by the system check and the backup drill).

## 7. Security posture

- Self-review done: dependency advisories patched except two moderate ones that remain, both assessed (`npm audit --omit=dev` reports 4 entries: react-router and its dom wrapper, uuid and its exceljs wrapper). React Router's fix needs a major upgrade to v7; the advisory is an open redirect through a backslash in a link target or `navigate()` argument, and this app only links to paths built by its own code, but plan the v7 move. The uuid advisory concerns the v3/v5/v6 functions given an output buffer; exceljs only uses v4 without one, so it is not reachable here, and the proposed "fix" is a downgrade to exceljs 3.4.0; every SQL statement is parameterised, and the few that interpolate do so only code-fixed column names or quoted catalog identifiers; uploaded files are never served inline as active content (HTML, SVG, scripts are forced to downloads with a sandbox policy); CSV/XLSX exports neutralise formula cells; per-user and per-address rate limits, wrong-token throttling; security headers on every response; production configuration is checked at start; company isolation enforced in the database by row-level security and tested.
- The identity-provider discovery fetch uses the issuer URL entered by a company administrator; it is not user-controlled input from outside the company, but a hosted multi-company deployment should still restrict outbound traffic from the app host to approved destinations at the network layer.
- **Not done:** independent penetration test (owner decision O-10). This self-review does not replace one.

## 8. Capacity: measured, not promised

Measured with `scripts/load-test.ts` against the two-year Stonebridge company (see `npm run seed:history`: about 20,000 ledger lines, 17,500 audit events and the rest of the generated history), one Node process and one local PostgreSQL on the same small container (development hardware, not production sizing). Mix: reads of lists, details, search, books, reports, notifications; 5 % creating work orders.

| Scenario | Requests | Throughput | p50 | p95 | p99 | Server errors |
|---|---|---|---|---|---|---|
| 50 users, ~0.3 s think time, 60 s | 8,246 | 131 req/s | 23 ms | 289 ms | 472 ms | 0 |
| 100 users, no think time, 45 s | 9,082 | 186 req/s | 418 ms | 928 ms | 1,249 ms | 0 |

Known slow spot: the **repair-or-replace** report evaluates every asset one at a time (1.7 s alone on this data set, up to several seconds under load). It is an occasional analytic report; if a customer with thousands of assets opens it often, rewrite it as one query.

These numbers say a single instance comfortably serves a few dozen simultaneously active users at this data volume. They do not cover many companies in one database, very large file uploads, or the production network. Re-run `scripts/load-test.ts` on the real environment before go-live.

- **Accounting sync is not scheduled by the server.** With the built-in books the ledger lags until someone presses Sync now or `scripts/run-sync.ts` is scheduled externally.
- **No real outbound email yet.** The daily digest is written as `.eml` files by a development sender; nothing is delivered until a provider is connected (O-2). People rely on the in-app notification bell.

## 9. Routine tasks

| When | Task |
|---|---|
| Daily (automatic) | Reminders, expiry alerts, approvals nudges, archives due, retention |
| Weekly | Check backups completed; glance at 5xx and rate-limit counts |
| Quarterly | Backup drill on a restored snapshot; review users and roles (there is no token-rotation screen yet; tokens are issued by provisioning code) |
| Per release | Section 4; run `npm test`, `npm run typecheck`, smoke and a11y scripts |

## 10. Owner decisions still needed to go live

Hosting (O-3), outbound email provider and sending domain (O-2), identity provider (O-1), pilot customer (O-4), pen-test vendor (O-10). A container image and deployment manifests are deliberately not included: they depend on the hosting choice, and an untested Dockerfile would be a guess.
