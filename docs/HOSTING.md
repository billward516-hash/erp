# Hosting

Two stages: a quick **test site** for usability testers (this page, step by step), and the **production hosting** choices to make once there is a pilot customer.

## Stage 1: test site on Render

What you get: a public `https://<name>.onrender.com` address running the real application with the fictional sample companies, reachable by anyone who has the address **and** a sign-in token. Nobody can get in without a token, so give tokens only to testers. Use sample data only. Real company data waits for a real identity provider and the pen test (OPERATIONS §7).

What it costs: a small web service with a 1 GB disk and a small managed PostgreSQL, a few tens of dollars a month in total. Render's plan names and prices change; the blueprint file `render.yaml` names the plans, so check them against Render's current list before you click deploy. The free database plan expires and the free web plan has no disk, so neither suits testing.

### Steps
1. Create an account at render.com and connect your GitHub account to it (Account settings → GitHub).
2. In Render choose **New → Blueprint**, pick the repository `billward516-hash/erp`, and the branch to deploy (`main` once this is merged, otherwise `claude/hosting-render`). Render reads `render.yaml`, shows the web service and database it will create, and the monthly cost. Approve.
3. The first deploy takes several minutes: it installs, builds the screens, creates the database login, applies the database updates, then loads the sample companies (about a minute) and starts. Watch the **Logs** tab.
4. When the log says `Server listening`, open the service's address (shown at the top of the service page).
5. **Get the sign-in tokens.** The first start prints one token per sample person in the log, under "dev tokens". Copy the lines you need. They are also saved on the disk as `/var/data/dev-tokens.json`; on a paid web service open the **Shell** tab and run `cat /var/data/dev-tokens.json`.
6. On the sign-in page open "Development sign-in", paste a token (start with `dana`, the administrator) and sign in.

### Sending testers in
- Give each tester the address and one token for the role they test: `priya` (technician), `kim` (buyer), `riley` (sales), `casey` (billing), `morgan` (finance approver), `kai` (Lite edition), `dee` and `tia` (field service). `docs/RUN_LOCALLY.md` lists them.
- Tokens are bearer passwords: anyone holding one is that person. Do not post them anywhere public.
- Email is not delivered (no mail provider yet); notifications show in the bell.
- Offline and install-as-app work over this site's HTTPS, so tablets can test them.

### Updating and resetting
- A push to the deployed branch redeploys automatically; new database updates apply on start; the sample companies are **not** loaded again.
- To start over with fresh sample data: in the Render dashboard delete the database (and recreate it from the blueprint) and the disk contents, then redeploy. This erases everything on the site.
- To stop paying, suspend or delete the service and database.

### What this setup does and does not do
- Does: one application copy, managed PostgreSQL, HTTPS, health checks on `/ready`, the daily job inside the server, a persistent disk for uploads and archives.
- Does not: back up the disk (Render's database has its own backups on paid plans; check the plan), send email, use single sign-on, or run more than one copy. Do not scale it past one instance (the rate limits and the daily scheduler live in memory).
- **Not tried on Render.** The start script and blueprint were tested here against a local PostgreSQL (empty database, first start, restart, health check, sign-in). Render itself was not available to me. The two things most likely to need a tweak are the plan names in `render.yaml` and whether Render's database user may create the `erp_app` login; if not, the log says so and what to do (below).

### If the start log says it cannot create the database login
The application connects as a limited login (`erp_app`) so the database itself enforces company separation. Create it once as the database owner (Render dashboard → the database → Connect → external or PSQL command) with `CREATE ROLE erp_app LOGIN PASSWORD '<long random value>' NOSUPERUSER NOBYPASSRLS;`, then in the web service's environment add `DATABASE_URL` as the connection string using `erp_app` and that password, and change the start command to `npx tsx src/server.ts` after one run of `npm run db:migrate`. If this happens, tell me and I will adjust the script.

## Stage 2: production hosting (when there is a pilot customer)

Decisions and work, in the order they bite:

| Topic | Direction | Needs |
|---|---|---|
| Where | Stay on Render or Fly.io for a small pilot. Move to AWS, Azure or Google Cloud only when a customer's security review asks. | Pilot's IT requirements |
| Database | Managed PostgreSQL with point-in-time recovery, a separate staging database, quarterly backup drill (`scripts/backup-drill.ts`) | Choose plan; schedule the drill |
| Files | S3-compatible object storage instead of a disk | **Build the storage adapter** (not built yet) |
| Instances | One copy is enough for dozens of users (load test: 100 users, no errors). Several copies need the rate limits and the daily scheduler moved out of memory first. | Only if load requires |
| Sign-in | The customer's identity provider; no sample tokens, no demo seed (`SEED_DEMO=0`), first company made with `scripts/create-company.ts` | Owner decision O-1 |
| Email | A transactional provider (Postmark, SendGrid or similar) on a domain you own with SPF and DKIM; set the `SMTP_*` variables | Owner decision O-2; proven only against a fake server so far |
| Domain and HTTPS | `app.<your domain>` pointed at the host; set `APP_BASE_URL` | Buy and point a domain |
| Security | Independent pen test, secrets in the host's secret store, uptime alert on `/ready`, staging step in deploys, IP audit (held) | O-10; schedule the audit |
| Data model of the offer | Decide whether each customer gets their own database or shares one (price, security reviews, upgrade handling) | Decide with the first pilot |

Never run `scripts/seed.ts` against a database with real data: it drops the schema. The hosted start script only runs it when the database has no company at all.
