# Build log

## 2026-10-23: SC-004 Fit interview, suggestions, display settings (D-180)
- A 22-question fit interview with a plain recommendation (features, plan depth, data steps, what is not a fit), optional reversible apply; ten "worth a look" suggestion rules with weekly cadence, dismissal memory and off switches; "How I like to work" (density, text size, contrast, reduced motion, reports table-first). Migration 0083.

## 2026-10-23: SC-002 Field service (D-179)
- **F1** customer sites, customer-owned equipment, technician profiles (skills, hours, time off), vehicles, service agreements with covered units and a visit generator, call-outs; per-site licensing. **F2** dispatch: suggestions by skill, day, time off and drive time, assign (creates the work order), send the day, board, technician "My day". **F3** tablet service report with signature pad, labor/parts to the work order, billing (per visit, flat monthly, call-out time and materials), recommended repairs to draft quotes. **F4** truck stock with minimum/par and restock list, tools with calibration-gated check-out and alerts. **F5** screens, service performance and service contracts reports, "service visits past due" in What is late, a sample HVAC company (Summit Climate Services), smoke steps. Migrations 0080-0082.

## 2026-10-23: SC-006 Scan station, change notices, temporary SOP changes (D-178)
- **A** barcode identity (supplier UPC/EAN/carton codes mapped to parts, prefixed labels for locations and lots), Code 128 label sheets (Avery 5160), scan resolution, a tablet scan station for receive (by PO or free), issue (to a work order or a job reference), count (blind) and look-up, count intervals with a counts-due list. Camera scanning where the browser has a barcode detector.
- **B** change notices with tracked distribution and acknowledgement, PDF to send, reminders, What is late section, raised from a change.
- **C** temporary SOP changes with approval, banner on the procedure, expiry timers and alerts, extension, revert, make-permanent. Migration 0079.

## 2026-10-23: Quote builder upgrade (D-177)
- Quote content (lead time, delivery, included, not included), redesigned one-page PDF, recorded acceptance (who, how, when, revision, total, signed file), validity extensions with reasons, expiry reminders at 7 and 2 days and the day after, expiring/expired filter and time-left column, "Quote outcomes" report. Migration 0078.

## 2026-10-23: SC-005 Requests for quote (both sides) and commercial timing
- **C** payment behavior, PO aging, quote aging reports; "What is late" page across invoices, bills, POs, quotes, orders, work, PM, calibration, documents.
- **A** buyer RFQ: draft, invite suppliers, send (PDF letter to attach to the buyer's own email), record replies per line, comparison on price, landed cost and lead time, award to a purchase request, daily reminders.
- **B** customer requests: recorded when they arrive (email with files), reply date and owner, bid or no-bid with a reason, quote built from the request, status follows the quote (sent, accepted, declined), board of overdue/today/this week, daily reminders, files up to 25 MB including drawings and spreadsheets, response-time report, section in What is late. Migration 0077.

## 2026-10-23: SC-003 Implementation planner, complete import coverage, practice copy

**Built (D-175)**
- **Implementation plan** (Administration → Implementation): depth, steps by stakeholder, locks, readiness, connections track, go-live sign-off.
- **Templates and dictionary** for every import; **row filters** and a **missing-references** summary in the import wizard.
- **New imports:** departments, users and roles, storerooms, work centers, routings, PM plans, meter readings, chart of accounts, open customer invoices, open supplier bills, open purchase orders, sales items, pipeline, budgets, expense categories, earning codes, timesheet history, qualification definitions, SPC characteristics, calibration, nonconformance and safety history, and bulk documents from a zip.
- **Practice copy** with optional sample data, opened and left from the app.
- **Found and fixed on the way:** none open. Tests: planner, templates for every target, each new import, the practice copy, the zip reader.

## 2026-10-23: S40-S44 Scheduler, plan against actual, demonstrated consumption, two-year dataset

**Built (D-171, D-172, D-173)**
- **S40-41 Daily job in the server.** One run a day per company (unique job/date row is the lock), a Scheduled jobs page, and approval notices that respect hidden features.
- **S42 Plan against actual** for approved business cases.
- **S43 Demonstrated consumption** from stock issues, with "Use this rate".
- **S44 Two-year dataset.** `npm run seed:history` builds Stonebridge Components (see D-173).

## 2026-10-23: S39 Read and understood, in-app work instructions, signatures and the audit pack

**Built (D-170)**
- **Read and understood.** Per-revision readings for chosen roles, an acknowledgement that follows opening the revision, immutable records, supersession by newer revisions, a Home card, daily reminders and a compliance report.
- **Work instructions in the app.** Steps with hazards, protective equipment, checkpoints and hashed photos, an editor that keeps its model on the server, and a structured viewer.
- **Comparison.** Line by line between any two revisions the reader may see.
- **Electronic signatures.** Chosen per kind of document, with the credential re-entered at signing, a recomputable seal and immutable records.
- **Audit pack.** A verified zip for the whole repository or one document, with a manifest of checksums and the audit chain result.
- **Demo data.** The deburring instruction requires reading by technicians, and a coolant change instruction is written in the app.

**Verified**
- 16 new tests:
  - `document-reads`: audience, acknowledge after opening, immutability, supersession, readers open a pending revision, turning the requirement on later
  - `work-instructions`: diff; photos, hashes, draft edit, no edit after release, comparison; validation, foreign photos, other kinds
  - `document-audit`: signatures (credential, someone else's, wrong, accepted, immutable, one-step, kinds not chosen); the pack (every entry's CRC read back, every manifest checksum recomputed, chain intact, 3 signatures, scope, audit-recorded)
- Report tests render the new "Read and understood" report in all four formats.
- Three more UI smoke checks (work instruction, comparison, reading and acknowledging, audit pack download, signature settings) and accessibility audit pages.
- Full verification of S36 to S39 together: 578 tests; 348 UI smoke checks; an accessibility audit of 194 page views with 0 violations; a crawl of 31 users, 774 page visits and 236 records with 0 issues; an API sweep of 608 routes and 4,835 calls with 0 server errors.

## 2026-10-23: S38 Customer specification revision review

**Built (D-169)**
- **Impact review on every new revision.** Each new revision of a customer specification or standard opens a review, due in 10 working days by default (a company setting). The revision can't be put in force until it is decided.
- **What the review shows.** The previous and new issuer revision, where the document applies, and our documents that work to it.
- **Outcome.**
  - "No impact", or "changes required" with follow-up revisions of our documents.
  - Each follow-up closes itself when that document releases its next revision.
  - A decided review can't be changed.
- **Around the review.**
  - daily reminders for late reviews
  - a queue on the Document control page
  - "works to" and "applies to" links
  - the customer page lists its specifications
  - the "Specification reviews" report with the on-time rate
- **Seed.** Lakeshore's LH-ES-104 rev C reviewed "no impact"; the deburr work instruction works to it.

**Verified**
- 4 tests in `test/spec-reviews.test.ts`:
  - working days
  - review opened with its due date; release blocked until decided; the assessment required; a decided review immutable
  - changes required needs follow-ups; a follow-up closes on the work instruction's next revision; the report's result and follow-ups
  - the setting is for administrators only; internal documents open no review
- A UI smoke check on the decided review.

## 2026-10-23: S37 The document server

The founder asked for an audit-proof repository for SOPs, work instructions, methods and procedures, technical requirements and customer specifications (D-168).

**Built**
- **Kinds and numbering.** Internal and external kinds, automatic numbering per kind, issuer details for customer specs and standards.
- **Versions.** A reason for change on every revision; released versions can be neither changed nor deleted.
- **Review and approval.** Named reviewers, then a named approver, with a comment on every signature. The author never approves. Versions can be withdrawn or discarded.
- **Effective dates.** An approved revision waits for its date while the current one stays in force.
- **Read access.** By document or folder roles, on top of site and restricted. Every file opening is logged.
- **Obsolete with a reason.** The document leaves the active list and its versions are kept.
- **Screens.** Document control (master list, folders, new document, per-document control and history) and the "Document master list" report.
- **Seed.** A work instruction, a test method in a folder limited to quality and managers, and Lakeshore's cleanliness specification (external, issuer revision C).

**Verified**
- 5 tests in `test/document-server.test.ts`:
  - numbering per kind; issuer and issuer revision required; reason for change required
  - reviewer then approver with comments; author refused; approver without permission refused; sent back to draft; released by the approver
  - a future effective date keeps the old revision in force for the floor, then promotes
  - folder read roles hide the document from search, page and file; every opening logged
  - obsolete needs a reason and leaves the active list; the repository answer; versions cannot be deleted
- The existing document, training, change and security tests pass with author ≠ approver.
- A UI smoke check and three accessibility audit pages.

## 2026-10-23: S36 Labor productivity and the business case approver

**Built**
- **Labor productivity report (D-166).**
  - Output per direct labor hour by part against its standard rate.
  - Labor efficiency (standard hours earned ÷ direct labor hours) by operator, work center and week.
  - The direct share of paid timesheet hours.
  - Overlapping entries of one operator are split, so no person-hour is counted twice.
- **Business case approver (D-167).** The owner (administrators) approves by default, or an approver an administrator names on the Business cases page. A named approver's own case goes to the owner.
- **Form autosave fix.** A form is tracked the moment it appears, so the first keystroke is kept. A saved draft is put back only if nothing has been typed since. Found by the UI smoke test: a fast first entry was missed.

**Verified**
- 5 tests in `test/labor-productivity.test.ts`: overlap splitting, separate people, earned hours with shared setups, output and efficiency by part, efficiency by operator.
- 1 more business case test: a named approver, only administrators may change it, and a named approver never signs their own case.
- The reports test renders the new report in all four formats.

## 2026-10-23: S35 Company archives and restore

The founder asked for full archiving every 30 days with restore (D-165), answering "both" (records and the whole company) and "admins, with a second administrator confirming a rollback".

**Built**
- **Archives.** A consistent, checksummed archive of every company table, every 30 days by default (1 to 90). The latest 12 are kept (1 to 120). Administrators can also archive by hand and download any archive. Secrets and drafts are never archived.
- **Bringing records back.** Pick a kind of record and search the archive. Each row shows whether it was deleted, changed or unchanged since. The chosen rows come back with the records that belong to them, with every rule and reference still checked.
- **Whole-company rollback.** One administrator asks and a second confirms within 24 hours. The present state is archived first. Users, sign-in, roles, the audit trail, number counters and the licence are kept as they are now.
- **Daily job.** Archives run after retention.
- **Admin screen.** Admin → Archives and restore.

**Verified**
- 4 tests in `test/archives.test.ts`:
  - admin only; gzip with a manifest, without secrets, and only this company's rows
  - the schedule and keep-N pruning
  - deleted and changed detection; a child record refused alone; restore with children
  - a rollback refused with one administrator, refused to the requester, and confirmed by a second administrator, with users, counters and an intact audit chain kept, another company untouched, and a pre-rollback archive kept
- A UI smoke check and two accessibility audit pages.

## 2026-10-23: S34 Server-side drafts

The founder asked for server-side saving of every entry (D-164).

**Built**
- Every form's entries are saved on the server about a second after typing stops. They come back on any device with a note and Discard, and clear when the form is saved or cancelled. Home lists "Unsaved entries".
- The business case editor keeps its whole model.
- Retention removes drafts left untouched for 90 days.

**Verified**
- 3 tests in `test/drafts.test.ts`: private to the author, listed by page, path and size limits, the retention sweep. The retention tests were updated for the new category.
- A UI smoke check: type, leave, find the draft on Home, restore it, discard it. A bug found this way is fixed: discarding inside React's click handler had the old value put back.

## 2026-10-23: S33 Business cases: sources, revisions, comparison

The founder asked whether the pro forma imports data from other modules and can compare plans (D-163).

**Built**
- "Pull in from" adds lines from the books, a budget, a CRM opportunity, the rent roll, an asset (replacement cost, upkeep and downtime avoided) and the labor rate. Each line records its source.
- Every closed revision is kept whole, and two or three plans or revisions compare side by side: key figures, cash by year, and every difference.

**Verified**
- 2 more tests in `test/proforma.test.ts`:
  - revisions are kept; comparison figures, answer and differences; refusals for one plan, a duplicate or an unknown revision
  - budget, opportunity and asset sources; the source is kept on save; technicians are refused

## 2026-10-23: S32 Business cases (opportunity pro forma)

The founder's pro forma is a product feature (D-162).

**Built**
- Driver lines, assumptions and low, base and high scenarios.
- NPV, IRR, payback, funding needed, profit and cash by year, and a sensitivity ranking, all from one pure engine shared by the server and the page.
- Example drivers, a start from the books, finance approval with a comment, a frozen approved case, reopening as a new revision, copying.
- The "Business cases" report, a feature flag, seed data (an approved cell at FTW, a draft compressor replacement at DAY).
- A modelling gap found by the seed is fixed: direct labor (people × annual cost) is allowed in cost of sales.

**Verified**
- 10 tests in `test/proforma.test.ts`:
  - the engine: payback, funding, NPV, depreciation, IRR, growth and ramp, losses carried forward, working capital, scenarios, sensitivity
  - the HTTP lifecycle: permissions, the report, copying, validation
- A UI smoke check and three accessibility audit pages.

## 2026-10-23: S31 Verification pass

The founder asked to "check each function and each interaction to verify no issues" (D-161).

**Checked**
- Six independent reviews: operations, platform, people, finance, quality and the web front end.
- A UI crawl: every demo user (31), every page, tab and first record.
- An API sweep: every route (575) as five kinds of user, with unknown ids and empty or malformed bodies.
- Every report in every format.

**Found and fixed: about 70 defects**
- **Security:**
  - an encoded-path sign-in bypass
  - self-approval beyond expenses
  - hidden features still showing their approvals
  - an idempotency race
  - an open redirect on sign-in
  - a session issued without checking company membership
  - an unused grant on the licence flag
- **Money:**
  - bills could be marked paid with any amount
  - postings did not equal invoice totals
  - concurrent credit memos and payroll exports could double up
  - opening balances left out unapplied credit
  - duplicate supplier invoice numbers across sites
  - lease renewals dropped charge dates
- **Quality:**
  - separation-of-duties gaps on effectiveness checks
  - the effectiveness rate was always 100%
  - the SPC summary leaked other sites
  - FMEA rows lost their actions when one was removed
  - a pre-startup "no" did not cancel startup
- **People:**
  - draft reviews were shown to employees
  - HR could edit their own review
  - a cancelled review stalled the schedule
  - "once" reminders repeated after retention
  - `false` in 24 query parameters read as yes
- **Operations:**
  - stock figures depended on the sites the user could see
  - downtime was recorded from the wrong time
  - MRP applied scrap wrongly
  - direct part usage was not netted
- **Web:**
  - forms kept the previous record's values
  - edits wiped hidden links
  - cleared fields were sent as empty strings
  - inputs were cleared on failure
  - accessibility gaps
  - screens asked for data the role or edition cannot have
- **Database rule violations** now answer 422 or 400 instead of 500.

**Verified**
- 529 tests passed.
- 315 UI smoke checks passed.
- The accessibility audit found 0 violations.
- The API sweep made 4,460 calls with 0 server errors.
- The crawl's only remaining stop was a timing gap in the crawler itself (a row that navigates a moment after the click), now fixed.

## 2026-10-23: S30 CAPA and 8D module

The founder asked for an 8D and CAPA module. Both existed inside Quality; they now have their own module (D-160).

**Built**
- **CAPA & 8D in the sidebar:** a dashboard that answers first, with:
  - open by type, overdue items, effectiveness checks waiting
  - the share of fixes that held, and days to close
  - by step, source and age
  - repeat parts and suppliers
  - the open list
- **Preventive actions:** for problems that have not happened, with the same steps and effectiveness check, and no 8D.
- **New sources:** SPC alarm, change, management review, risk or trend.
- **Links back:** to the SPC alarm, change, FMEA or audit a CAPA came from, with "open a CAPA" from SPC alarms and from changes that missed their purpose.
- **Feature:** can be hidden per role (now 31 features).

**Verified**
- 4 new tests (`test/capa-module.test.ts`):
  - preventive rules, including refusing 8D on create and on update
  - origin links and the site check
  - dashboard figures, sentence, sources and repeats
  - who may see it, over HTTP
- The existing quality and 8D tests pass unchanged.
- 3 new UI smoke checks: Sam opens the dashboard and raises a preventive action. `/capa` and `/capa/new` added to the accessibility audit.
- 463 tests, web build, fresh seed, 315 UI smoke checks, and an accessibility audit of 172 page views with 0 violations.

## 2026-10-23: S29 Justification presentation on changes

The founder asked for a presentation holder for change justification (D-159).

**Built**
- **Uploads:** each change can carry a PowerPoint or PDF deck (25 MB), with every version kept, and/or a link to a deck kept elsewhere.
- **Frozen at submission:** both can change only in draft, so approvals refer to the deck reviewers saw.
- **Viewing:** PDFs open in the browser and PowerPoint downloads.
- **Approvals:** the approval card links to the deck.

**Verified**
- 1 new test covering:
  - file types and who may add a deck
  - versions newest first
  - https-only links
  - a viewer cannot edit
  - frozen after submission
- 2 new UI smoke checks: Sean attaches a deck to his draft change.
- 459 tests, web build, fresh seed, 312 UI smoke checks, and an accessibility audit of 168 page views with 0 violations.

## 2026-10-23: S28 Store cap and ISO 9001 change management

The founder answered three register items: stores are capped at 5 (O-7); the Lite limits stand (O-11); and change management stays core and must meet ISO 9001 (O-13).

**Built**
- **Store cap of 5:** enforced like the property cap: by a database trigger, deactivation frees a place, and the count shows on the Sites page (D-157).
- **Change management to ISO 9001** (D-158):
  - planning before review (6.3 a–d)
  - planned, emergency or unintended, with a consequence review for the latter two (8.1)
  - customer impact with a customer action before startup (8.2.4, 8.5.6)
  - every approval records the result of the review (8.5.6)
  - closure with the verified outcome and evidence, or a named follow-up (6.3, 9.1)
  - unplanned changes and outcomes in the change register for management review (9.3)
- **`docs/ISO9001.md`:** where each clause's evidence lives, and what the company still owns.
- **Demo data:** Ridgeline's changes carry their planning; the spindle change tells Lakeshore; the portable chiller is recorded as an emergency change.

**Verified**
- New tests:
  - store cap: a sixth store refused through the service and the database, a place freed by deactivation, the cap never above 5, tenants cannot change it
  - 5 MOC tests for ISO 9001: planning required; customer approval needs the customers named and plans an action before startup; an unintended change plans a consequence review; an approval without a review result is refused, and the queue says so; closure outcome and evidence rules
- The existing MOC tests were updated for the planning and review-result rules.
- 3 new UI smoke checks: approving a change needs its review result; the change page shows its planning.
- 458 tests (one HTTP change test updated for the new rules after the first full run), web build, fresh seed, 310 UI smoke checks, and an accessibility audit of 168 page views with 0 violations.

## 2026-10-23: S27 SPC rule selection and daily alarm summary

The founder asked whether SPC has a daily summary of alarms against the rules that are on. It had neither (D-156).

**Built**
- **Rules:**
  - a catalogue of 10, with 4 optional Western Electric / Nelson rules added
  - quality managers choose the company's set; a characteristic can use its own
  - only rules that are on raise alarms and mark charts
- **Instant per-alarm notices:** can be turned off in favour of the summary.
- **Daily summary (or weekly):** per site to quality staff, answer first, with new alarms by rule and characteristic, open alarms and the oldest, and characteristics not measured recently. It is set like every reminder on Admin → Reminders (now 33).
- **SPC tab:** opens with the same summary for the last day or 7 days.

**Verified**
- 10 new tests (`test/spc-rules.test.ts`):
  - each optional rule on hand-built data
  - defaults; a rule turned off raises nothing, on variables and attribute charts
  - only quality managers change rules, with at least one kept on
  - alarms recorded only for rules that are on
  - the instant notice turned off
  - a characteristic's own rules
  - the summary's counts
  - the daily reminder sent once per person per day, with its sentence
- The existing SPC tests (22) pass unchanged.
- 5 new UI smoke checks: Sam sees the summary and turns an optional rule on and off.
- 452 tests, web build, fresh seed, 307 UI smoke checks, and an accessibility audit of 168 page views with 0 violations.

## 2026-10-23: S26 Performance reviews

The "performance management" part of the founder's reminder request, which needed the feature itself (D-155).

**Built**
- **Settings (HR):**
  - review frequency, calendar month or hire anniversary, first review after hire
  - check-ins, self-assessment, and how early reviews open
- **Reporting lines:** each employee's manager, imported from payroll exports.
- **Daily sweep:** opens reviews and check-ins once, before they are due; the reviewer is the manager, else the department head, else HR assigns one.
- **A review:**
  - the employee's self-assessment
  - the reviewer's rating, strengths, development, summary and goals
  - shared, then acknowledged with an optional comment
  - check-ins completed by the reviewer
  - HR: reassign, cancel, close unacknowledged
- **Visibility:** only the employee, the reviewer and HR, and the employee sees nothing of the draft.
- **Reminders:** two new ones on Admin → Reminders (now 32), for reviewers and for HR.
- **Feature:** Performance can be hidden (now 30 features).
- **Demo data:** Ridgeline's reviews are due at the end of next month, with technicians reporting to their maintenance managers.

**Verified**
- 12 new tests (`test/performance.test.ts`):
  - due dates for calendar and hire anchors and first reviews
  - only HR sets the programme; check-ins must be more frequent than reviews
  - reviews open once, at the right time, with the manager as reviewer or none
  - self-assessment, a hidden draft, role checks, and others getting not found
  - goals, share, acknowledgement with a comment, frozen afterwards, and the audit trail
  - the next check-in three months on
  - HR assigning a reviewer, and nobody reviewing themselves
  - reminders to the reviewer and HR, and the HTTP routes
  - managers imported from a payroll file in any order
- 6 new UI smoke checks: Marcus rates and shares Priya's review; Priya reads and acknowledges it. Performance pages added to the accessibility audit.
- 442 tests, web build, fresh seed, 302 UI smoke checks, and an accessibility audit of 168 page views with 0 violations.

## 2026-10-22: S25b Periodic reviews

The second half of the founder's request: records that must be reviewed at a frequency the company sets (D-154).

**Built**
- **13 kinds of reviewed record:** FMEAs, SPC characteristics, controlled documents, policies, the expense policy, course content, user access, approved suppliers, PM plans, critical spares lists, repair templates, store walk checklists, and continuity plans.
- **Admin → Reminders, Periodic reviews:** per kind, every how many months, days of warning, repeat, escalation after days overdue, and who may change it.
- **Reviews page:**
  - what each person may review, overdue first
  - "still current" or "changes needed" with a note
  - a record's own frequency
- **Sweep:** reminds owners (or managers); past the escalation, tells managers or administrators.
- **Continuity plans:** new plans take the company's frequency.
- **Demo data:** the Ridgeline turning-cell FMEA is approved 13 months ago, so its review is overdue.

**Verified**
- 8 new tests (`test/reviews.test.ts`):
  - every kind's query runs
  - an FMEA approved 13 months ago is overdue, for its owner and the quality managers but not a technician
  - access review in 6 months
  - a typed review date is honoured; the company frequency moves every record and a record's own frequency overrides it
  - limits and who may change them
  - owner reminded, managers on escalation, not repeated within the week; a kind turned off disappears
  - recording reviews, with note rules, history, audit and the next date
  - the HTTP routes
- 4 new UI smoke checks: Sam reviews the overdue FMEA, and the page then shows nothing overdue. Reviews added to the accessibility audit.
- 430 tests, web build, fresh seed, 296 UI smoke checks, and an accessibility audit of 164 page views with 0 violations.

## 2026-10-22: S25a Reminder settings

The founder asked to find every reminder and let administrators, or chosen roles, set their frequencies (D-153).

**Built**
- **Catalogue:** all 23 reminders the sweep sent, and 7 new ones: contractor insurance, warranties, external certificates, audits coming up, lots expiring, store walks not done, next year's budget.
- **Admin → Reminders:** each reminder with who receives it and what triggers it.
  - Settings: on or off, days ahead, and repeat (daily, weekly or once).
  - Administrators choose whether area managers or named roles may change each one.
  - Managers see the reminders they may change.
- **Sweep:** reads the settings, honours repeat through its dedupe keys, and skips reminders for features turned off for everyone.

**Verified**
- 8 new tests (`test/reminder-settings.test.ts`):
  - the catalogue matches the sweep both ways
  - administrators against area managers against technicians; handing a reminder to another role; limits
  - turning a reminder off and on; lead days widening the window; weekly against daily repeat; a feature turned off
  - the new insurance and audit reminders
- 4 new UI smoke checks; `/reminders` added to the accessibility audit.
- 422 tests, web build, fresh seed, 293 UI smoke checks, and an accessibility audit of 162 page views with 0 violations.

## 2026-10-22: S24 Safe user regex in import mappings

**Built:** user-written patterns in mapping transforms run with V8's linear-time fallback. Backreferences, lookaround, over-long patterns and unknown flags are refused when a profile is saved (D-152).

**Verified**
- 3 new tests (`test/safe-regex.test.ts`): `^((a+)+)$` on 5,000 characters finishes in milliseconds (11.5 s on 29 characters before); ordinary extract and replace unchanged; unsafe constructs refused.
- 414 tests and a fresh seed (every sample mapping, with its patterns, imports as before).

## 2026-10-22: S23 Data retention

The retention item from the hardening backlog (D-151).

**Built**
- **Admin → Data retention:**
  - how long each kind of working data is kept: import rows, read and unread notifications, sent emails, expired tokens
  - limits and defaults for each, and what the next sweep would remove
  - what is never removed, and the recent sweeps
- **Daily sweep:** runs with the reminders after mail goes out. Unfinished imports are cancelled; recorded, audited, scoped to one company.
- **Imports:** an import whose rows were removed keeps its summary, and its problems file says why it is gone.

**Verified**
- 4 new tests (`test/retention.test.ts`):
  - defaults, the never-removed list, administrators only
  - limits enforced and changes audited
  - a sweep over backdated data removes exactly what the preview said is due: old import rows (recent ones kept), the unfinished import cancelled, read and unread notifications past their periods, old sent emails (queued kept), expired tokens
  - another company is untouched, the audit chain stays intact, and the problems file answers 410
  - a second sweep removes and audits nothing
- 4 new UI smoke checks; `/retention` added to the accessibility audit.
- 411 tests, web build, fresh seed, 290 UI smoke checks, and an accessibility audit of 160 page views with 0 violations.

## 2026-10-22: S22 Production hardening

The hardening items in the backlog that need no owed decision, built before the first paying customer (D-150).

**Built**
- **Request ids and logs:** every response carries `X-Request-Id` (a load balancer's is kept); JSON logs carry it with the company and user; credentials are redacted; a server error shows the user its reference.
- **Security headers:** Content Security Policy (own scripts only), nosniff, same-origin framing and referrer, opener isolation, permissions policy, HSTS over HTTPS.
- **Rate limits:** 1,200 requests a minute per user, 120 per address to sign-in and public forms; wrong tokens count against the address. 429 with `Retry-After`.
- **Probes and metrics:** `/health`, `/ready` (database up, all migrations applied), `/metrics` in Prometheus format behind `METRICS_TOKEN`.
- **Graceful shutdown** on SIGTERM.

**Verified**
- 8 new tests (`test/hardening.test.ts`): request ids and headers; readiness; metrics only with the token, keyed by route pattern; per-user limit with `Retry-After` that leaves other users alone; guessed tokens limited per address; a server error's reference matches its request id and hides the cause.
- The UI smoke run fails on any console error, so it also proves the Content Security Policy blocks nothing the app uses.
- 407 tests, web build, fresh seed, 286 UI smoke checks, and an accessibility audit of 158 page views with 0 violations (the audit's browser now bypasses the policy to inject axe-core, which the policy rightly refused).

## 2026-10-22: S21 Feature visibility by role

The founder asked for an admin place to choose which features each role sees, with hidden features invisible everywhere except that screen (D-149).

**Built**
- **Catalogue:** 29 features, each mapped to its permissions, navigation, API areas and reports.
- **Settings:** each feature is visible to everyone, to chosen roles, or to nobody.
- **Hiding:**
  - permissions are masked per role at sign-in, so existing checks hide or refuse the feature everywhere
  - navigation, API areas, reports and search are refused or filtered
  - a page opened directly explains that the feature is off
- **Admin → Features:** shows every feature with its state, what else a change affects, and who changed it last. Every change is audited.

**Verified**
- 8 new tests (`test/features.test.ts`):
  - administrators only; validation of role lists
  - a feature turned off is refused for everyone, administrators included, in the API, `/api/me`, reports and search, but stays on the admin screen
  - a navigation-only feature keeps shared data working
  - a feature for chosen roles, per role a person holds
  - restoring it, and auditing every change
  - the catalogue names only real permissions and reports, and no API area is claimed twice
- 5 new UI smoke checks: turn Leasing off, see it leave the sidebar and its page, turn it back on.
- 399 tests, web build, fresh seed, 286 UI smoke checks, and an accessibility audit of 158 page views (Features added) with 0 violations.

## 2026-10-22: S20b Lot and serial tracking (remaining movements)

This completes the two slices the founder approved (D-148).

**Built**
- **Kits:** lots are carried through staging, return and cancel.
- **Counts:** lot and serial counting per lot, including lots found on the shelf.
- **Credit memos:** customer returns name the lot or serials; a void takes the same ones out.
- **Nonconformances:** they hold lots of their part, released on close after use as is, rework or repair.
- **Import:** opening stock per lot, with expiry.
- **Report:** a new lot expiry and holds report, with drill-down to the lot.
- **Automatic picks:** usable lots always come first.
- **Screens:** count sheet, adjustments, credit memo lines, nonconformance page.
- **Sample data:** the quarantined coolant lot is now held by a receiving nonconformance.

**Verified**
- 6 new tests:
  - a kit staged, issued and returned
  - a serial count with a missing and a found serial
  - a return as a serial number, and its void
  - a nonconformance hold blocks issue, and release on close
  - the opening-stock import per lot, re-import unchanged
  - the expiry and holds report
- A test caught kit staging taking an expired lot; automatic picks now take usable lots first.
- 391 tests, web build, fresh seed, 281 UI smoke checks, and an accessibility audit of 156 page views (lots, the report and counts added) with 0 violations.

## 2026-10-22: S20a Lot and serial tracking (core)

The founder approved lot and serial tracking in two slices (D-147). This first slice covers the main movements and tracing.

**Built**
- **Tracking per part:** opt-in by lot or serial, with shelf life. Existing stock is counted into lots when tracking is switched on.
- **Lots on every ledger movement** of a tracked part:
  - receipts (manual and on purchase orders, in order units, recording the supplier)
  - issues to work orders and production (first to expire unless a lot is chosen)
  - returns (back to the lots issued)
  - finished goods (the order number as the lot, or serial numbers)
  - shipments
  - transfers (the same lots arrive)
- **Holds and expiry** block issuing and shipping, but held stock can still be moved.
- **Trace:** a lot's movements, what it was made from, what it went into, which customers received it, and where it was used; a recall list that follows production.
- **Screens:** Storerooms → Lots, a lot page with hold and release, tracking settings on the part, lot entry and choice in the receiving, shipping and production forms.
- **Sample data:** Ridgeline coolant in three lots (one near expiry, one on hold for a failed concentration check) and two serial-numbered spindle cartridges.

**Verified**
- 7 new tests (`test/lots.test.ts`):
  - switching on requires an exact count
  - receipts need lots; shelf-life expiry; serial rules
  - first to expire; returns to the lots issued, last first; a named lot
  - holds and expiry block issues with a clear message, but transfers carry held lots
  - a purchase receipt in boxes splits into lots in stock units, with the supplier
  - production genealogy, a shipment to a customer, and the recall list
  - per-lot balances add up everywhere
- The first test runs caught a constraint issue on outbound balance updates and an ambiguous return order; both were fixed.
- 385 tests, web build, fresh seed, 280 UI smoke checks (4 new), and an accessibility audit of 152 page views with 0 violations.

## 2026-10-22: S19d Credit memos, customer returns and refunds

This was the next item on the order-to-cash backlog. Small-business bookkeeping needs it now that the books are in every edition (D-146).

**Built**
- **Credit memos:**
  - lines default to the corrected invoice's income accounts
  - returned goods go back into a storeroom
  - stored PDF; automatic application to the corrected invoice
  - application to other open invoices; refunds; void while unused
- **Books and file export:** the books post credit memos (as the mirror of an invoice), voids (as reversals) and refunds (against the bank). The file export writes credit memos to their own file. With an API accounting connection, memos are refused (they come from that system).
- **Screens:** a Credit memos tab, "Credit this invoice" on the invoice page, credits on the customer account, and a credit memo page.
- **Sample data:** Kessler credits a pump coupling returned unused against Riverside Apartments' invoice.

**Verified**
- 5 new tests (`test/credit-memos.test.ts`):
  - a return reduces the invoice, restocks the part and credits the service income it was billed to (the first run caught that lines defaulted to product sales)
  - over-credit is refused; a used memo cannot be voided
  - a goodwill credit is partly applied and partly refunded, and receivables and the bank reconcile
  - a void reverses the posting and the stock
  - file-export and API-connection behaviour
- 2 new UI smoke checks: credit an invoice, issue the memo, see where the credit went.
- 378 tests, web build, fresh seed, 276 UI smoke checks, and an accessibility audit of 150 page views (credit memo pages added) with 0 violations.

## 2026-10-22: S19c Chart library

The shared chart library from brief §15.4 (D-145).

**Built**
- **One chart specification**, drawn three ways: SVG for print HTML, PDFKit for PDFs, and an interactive React component with a hover tooltip, a legend and an image download.
- **Palette:** validated with the data-visualization palette checker on the app's light (#ffffff) and dark (#192029) panels. All checks pass; aqua is under 3:1 on white, which is relieved by the legend and the table.
- **Charts on four reports:** maintenance backlog (work orders by age), asset availability (unplanned downtime by asset), receivables aging (open balance by age), and budget against actual (by category, two series).
- **PDF fix:** a table header no longer sits alone at the foot of a page.

**Verified**
- 2 new tests:
  - layout: ticks from zero, compact labels, labels on the extremes only, negative bars
  - charts in JSON, print HTML and PDF; the backlog chart adds up to the table's rows
- **Looked at, in light and dark:** the receivables and budget charts on screen, and the budget-against-actual PDF.
- 373 tests, web build, fresh seed, 274 UI smoke checks, and an accessibility audit of 148 page views with 0 violations.

## 2026-10-22: S19b Report filters, saved views and drill-down

These are Phase 2–3 reporting items from brief §15.4 (D-144).

**Built**
- **Filters:** every report gets its real filters on screen, described from its parameter schema; before this, only the site could be chosen. Filters live in the address and are used by the exports.
- **Saved views:** private or shared with the company, validated against the report.
- **Drill-down:** an "Open" link on every row that has a record, through the same map as the Excel links.

**Verified**
- 2 new tests:
  - filter descriptions (types, limits, defaults, choices; no report is left with an untyped filter); row links in JSON
  - views: private and shared, sharing permission, validation, update by name, delete rights, isolation between companies
- 5 new UI smoke checks: a filter changes the report and is kept in the address; reset; saving and restoring a view; a report row opens its work order.
- 371 tests, web build, fresh seed, 274 UI smoke checks, and an accessibility audit of 148 page views (one report page added) with 0 violations.

## 2026-10-22: S19a Units of measure (Phase 2 begins)

The first Phase 2 gap: units were labels only, so a box of 100 bought on an order could not become 100 each in stock (D-143).

**Built**
- **Conversions:** standard units with fixed factors, plus each part's own units.
- **Purchasing:** supplier prices per selling unit, converted on requests; conversions frozen on orders; receipts post stock units at the converted cost; on-order and requested quantities counted in stock units for reorder and planning.
- **Imports:** a purchase unit and pack size on the parts list, and a price unit on supplier price lists.
- **Screens:** units on the storeroom part panel, request lines, order lines and supplier prices.

**Verified**
- 4 new tests (`test/uom.test.ts`):
  - pure conversions
  - own units, and refusing fixed ones
  - a price per box becomes a request price per box and per each
  - an unknown unit is refused
  - requested and on-order quantities in stock units
  - receiving 2 boxes posts 200 each at a hundredth of the price
  - a later pack-size change leaves the order alone
  - both imports, including their refusals
- 369 tests, web build, fresh seed, 269 UI smoke checks (2 new) and an accessibility audit with 0 violations.

## 2026-10-22: S18b (part 2) Excel export and the backup and restore drill

This closes the Phase 0–1 foundations that do not depend on the founder's providers.

**Built**
- **Excel for every report (D-141):** the workbook carries the finding, scope and KPIs, then a typed table with number formats, a frozen header, a filter and shaded exceptions. Each row links to its screen; a Notes sheet holds the insights and definitions. Text is never written as a formula. An "Excel" button sits on every report.
- **Drill-down map:** a record's API path maps to its page in the web app, for every drill-down the reports declare (16 kinds of record).
- **Backup and restore drill (D-142):** `npm run backup:drill`.

**Verified**
- 2 new tests:
  - the workbook's headline and first column match JSON; numbers are typed; links go to the right screen; no formulas anywhere
  - every declared drill-down maps to a screen
- **Drill run on the seeded dev database:**
  - dump of 1.4 MB in 0.5 s; restore in 2.5 s
  - 41 migrations; 187 tables and 7,492 rows, all equal
  - row-level security on 185 tables with identical policies
  - audit chains verified for all 5 companies
  - the runtime role sees 0 rows without a company and none of other companies' rows

## 2026-10-22: S18b (part 1) Single sign-on

Production sign-in through the company's own identity provider, provider-independent, so choosing a provider (owner register O-1) is now only configuration (D-140).

**Built**
- **Migration `0041`:** per-company settings (encrypted client secret; email domains owned by one company), linked identities on users, session tokens, sign-ins in progress, and the pre-tenant functions.
- **OpenID Connect flow:** authorization code with PKCE, state and nonce. ID tokens are verified with `node:crypto` (RS256 or ES256), with issuer, audience, expiry and nonce checks. A key rotation triggers one refetch of the keys. Users are linked by verified email on first sign-in and never created by it.
- **Sessions:** 12-hour session tokens and sign-out. API tokens can be turned off, but only once the admin has signed in with SSO.
- **Web:** a work-email sign-in (the development token sign-in is behind a disclosure), the `/signed-in` landing, and Admin → Sign-in settings.
- **MOCK provider** (`scripts/mock-oidc.ts`, `npm run mock-idp`): checks the client, redirect URL and PKCE as a real provider would.

**Verified**
- 7 new tests (`test/sso.test.ts`), all against the MOCK provider:
  - the secret is encrypted and hidden, and the provider is checked before enabling
  - a domain belongs to one company
  - sign-in by work email, with linking and the session's lifetime
  - a state works only once, and the return path cannot leave the site
  - refusals: a stranger, an unverified email, an unknown domain
  - sign-out, and API tokens turned off and back on
  - ID tokens refused for wrong audience, wrong issuer, expiry, wrong nonce, unknown key, forged claims, `none` and HS256
- 363 tests, web build, fresh seed, 267 UI smoke checks (one new SSO check), and an accessibility audit of 146 page views with 0 violations.
- Not tested against a real provider: none has been chosen yet (O-1).

## 2026-10-22: S18a Built-in books in every edition

The founder confirmed the built-in books for every edition, at small-business depth, reversibly (D-139). Standard could already reach the books; this slice makes them usable by a company that starts them partway through.

**Built**
- **Open items:** at setup, or later from Books → Settings, the amounts still owed on invoices, approved bills and approved expense reports already in the platform post as opening balances. Each posts under its item's own key, so later payments settle it and a void reverses it. Running it again posts nothing new.
- **Import target `opening_balances`:** a previous system's trial balance, in its own layout. Receivables and payables are refused, because they come from the open items. A missing account is created from the type column. A corrected amount replaces the earlier opening entry.
- **Sample:** a QuickBooks Desktop trial balance export and its saved mapping (`samples/imports/kessler/`).
- **[docs/OWNER_REGISTER.md](OWNER_REGISTER.md):** what the founder owes, with what was built meanwhile.

**Verified**
- 5 new tests (`test/books-standard.test.ts`):
  - every platform account key has an account in the starter chart
  - Standard separation of duties still applies
  - open items are brought in, including a partly paid invoice and a bill dated after the start
  - later payments and a void settle them
  - a trial balance import: errors first, then fixed, re-imported, and corrected
  - the sample export loads with its saved mapping
- CI on GitHub (PostgreSQL 16, typecheck, web build, tests) has been green on every recent push.

## 2026-10-22: S17f Lite edition and built-in books

A Lite edition for very small companies with QuickBooks-style basic bookkeeping that carries on into the full product (D-135 to D-138, docs/EDITIONS.md).

**Built**
- **Migration `0040`:** licence edition and caps (triggers), single-person approval, the ledger (chart, journal with balance, immutability and period-lock triggers), banking (rules, statement lines, reconciliations), `native_books` provider, books permissions, Bookkeeper role.
- **Edition gate:** Lite areas and reports allowed, everything else answered with an upgrade message; Lite sidebar; edition and limits in `/api/me`.
- **Books:**
  - posting rules for invoices, voids, bills, expense reports and payments, posted inline as the events are emitted
  - setup with a starter chart and opening balance; manual entries and reversals
  - statements (profit and loss, balance sheet, trial balance, registers); journal export
  - bank lines matched, categorized with rules, or excluded; reconciliation to the cent
- **Around the books:**
  - simple invoices on Receivables
  - bills without purchase orders in Lite, with a quick supplier form
  - payment events from receivables and payables
  - single-person approval in the approval engine, AP approval and expense reimbursement
- **Import:** `bank_transactions` in each bank's layout (Kessler's statement uses a common checking-export format with US dates).
- **Reports:** `profit-and-loss`, `balance-sheet`.
- **Seed:** Kessler Tool & Repair (Lite): owner, bookkeeper and technician. It has 3 invoices, 3 bills, a reimbursed expense report, and a 13-line bank statement, partly matched and categorized by rules.

**Verified**
- 10 new tests: posting rules, bank rules, Lite caps and gate, setup, invoice/payment/void postings, a sole owner's self-approval (audited), bill and reimbursement payments, bank matching, categorizing and rules, reconciliation, statements balancing, period lock, unbalanced and edited entries refused.
- 351 tests, web build, fresh seed, 265 UI smoke checks, accessibility audit with 0 violations over 144 page views.

## 2026-10-22: S17e Budgeting: spend history, bottom-up and top-down

Budgeting tools and historic usage analysis by spend category, as the founder asked (D-133, D-134).

**Built**
- **Migration `0039`:** spend categories over account keys, imported spend history, budgets with targets, lines, submissions; freeze on approval; two permissions.
- **Engine:** cent-exact allocation, seasonal spreading, proposals from history, history statistics, reconciliation, variance and forecast, fiscal years starting in any month.
- **Spend:** one query over supplier invoices (excluding stock purchases), stock used, expense reports and imported history; commitments from open non-stock orders.
- **Import:** `spend_history` from a GL "P&L by month" in the customer's layout; unmapped accounts reported.
- **Report:** `budget-vs-actual`.
- **UI:** Budgets under Finance: spend history with monthly bars and run rates, budgets list, spend categories; a budget page with the bottom-up grid by site and department, start from history, targets with gaps and allocation, reviews, and against actual.
- **Seed (Ridgeline):** a twelve-month GL export (one unmapped bank-charges account rejected); this year's budget approved; next year's in progress with Maintenance submitted and a board ceiling 3% below the bottom-up.

**Verified**
- 10 new tests: allocation to the cent, seasonality, reconciliation, variance, July fiscal years, sources and exclusions, the department head's proposal and permissions, target gap and allocation, submission review, freeze, one approved budget a year, budget against actual.
- 341 tests, web build, fresh seed, 256 UI smoke checks, accessibility audit with 0 violations over 124 page views (a scrolling grid made keyboard-focusable).

## 2026-10-22: S17d Expense reports

Expense reporting with approval by organization and amount, as the founder asked (D-131, D-132).

**Built**
- **Migration `0038`:** reports, lines (frozen once submitted), approval rules by site, department and amount, department heads, person-addressed approval steps, three permissions, starter rules.
- **Policy checks:** blocking problems versus exceptions to explain (limits, receipts, deadline, duplicates against earlier claims).
- **Approval:** route preview on the draft; the department head signs in person (or their delegate); finance from $500 and an executive from $5,000 by default; department and site rules add steps.
- **After approval:** outbox event to accounting (file export and MOCK adapters); finance records the reimbursement; claimant notified.
- **Report:** `expense-summary` (approved spend by category and department, exceptions, waiting, not reimbursed).
- **UI:** Expenses in My day; report page with line editor, receipt upload, flags with explanations, route, approve or reject inline, reimbursement; rules and department heads for finance.
- **Seed (Ridgeline):** departments with heads; a reimbursed course trip; two reports waiting for department heads; a draft with a flagged hotel.

**Verified**
- 6 new tests: every policy finding, duplicates across reports, the full route with the head by name, a personal step refused to others and signed by a delegate, outsiders refused, finance approval to outbox with account keys, reimbursement rules, withdraw, reject and revise, department rules, the head claiming.
- 331 tests, web build, fresh seed, 249 UI smoke checks, accessibility audit with 0 violations over 114 page views.

## 2026-10-22: S17c Intranet shell and home

The user interface now has an intranet feel, as the founder asked (D-130).

**Built**
- **Shell:** a dark company sidebar with grouped destinations and badges, a top bar with company-wide search, a skip link; a drawer on phones.
- **Home:** greeting banner with colleague search; company news; my work (sign-offs, policies to acknowledge, actions, work orders, training, overdue work); coming up; quick links; the operational tables below.
- **Pages:** News and events (post, pin, expire, withdraw, notify; quick links), People (directory cards with email and work phone), Search results.
- **Migration `0037`:** announcements, quick links, work phone and office on employees, `people_directory()`, `announcements.post`; `/api/me` now includes the company name.
- **Seed (Ridgeline):** open enrollment (pinned), Thanksgiving closure, a forklift safety notice, a site audit at Dayton, a welcome; three quick links; work phones.

**Verified**
- 5 new tests: site-scoped announcements, posting rights, safety notices to the bell, events, withdrawal, https-only links, the directory across sites with only work fields, search limited by permission.
- 325 tests, web build, fresh seed, 241 UI smoke checks (phone-width navigation through the drawer), accessibility audit with 0 violations over 104 page views.

## 2026-10-22: S17b Policies and the employee handbook

Policy placeholders for the handbook and expense reporting, as the founder asked (D-128, D-129).

**Built**
- **Migration `0036`:** policies, versions, acknowledgements, expense categories and the expense policy; `policies.manage`; an HR Manager role.
- **Templates:** 12 handbook sections and an expense and travel policy, each with [[placeholders]] the company completes; not legal advice.
- **Rules:** publish refused while placeholders remain; published text frozen; change summary from revision 2; minor revisions keep acknowledgements; site policies apply to that site's people only.
- **Expense rules:** categories with optional limits, receipt threshold, mileage rate, deadline; shown live in the expense policy.
- **UI:** a handbook with contents and "I have read the handbook"; all policies with status; a policy page with editor, placeholder list, publish, history and who has acknowledged; expense rules with editing for HR.
- **Seed (Ridgeline):** HR published 11 sections with Ridgeline's answers, left 2 in draft, set expense limits and mileage; two people acknowledged.

**Verified**
- 6 new tests: templates all carry placeholders; install once; publish refused with placeholders; notices; frozen text; minor and material revisions; site scope; expense rules.
- 320 tests, web build, fresh seed, 233 UI smoke checks (acknowledging the handbook, drafts, expense rules), accessibility audit with 0 violations over 94 page views.

## 2026-10-22: S17a Property licence: a single cap of 100

The founder replaced property bands with a single cap of 100 (D-127). Migration `0035` turns `tenant_license` bands into `property_cap` (0–100, default 100) and the trigger, usage function, service message, provisioning option (`propertyCap`) and Sites page now speak of the cap. Licence tests updated, including the refusal of a cap above 100.

## 2026-10-22: S16a 8D problem solving

The eight disciplines on the corrective action (brief Category 2 advanced quality, D-126).

**Built**
- **Migration `0034`:** 8D format and fields on the corrective action; team members; read-across; action kinds.
- **Rules:** `disciplines()` states what D1–D8 need; each step's gate names the missing disciplines in plain words. Team members and the champion can read the 8D; the champion is not the owner; recognition only after closure.
- **Report:** the 8D report as PDF (D0–D8, is / is not table, what is missing); open 8Ds in the quality status report.
- **UI:** "Run as an 8D" at opening or while open; the disciplines checklist; team, is / is not, D4, action kinds, D7 read-across and D8 sections.
- **Seed (Ridgeline):** Lakeshore's 8D on port burrs, at D5–D7 with one read-across to decide.
- **Fix:** the web client failed on PATCH responses without a body (204), so saving corrective-action fields and editing production orders showed a JSON error; it now treats 204 like POST does.

**Verified**
- 5 new tests: the disciplines' messages, cancelled actions not counting, the full cycle through every gate, team access without `quality.view`, recognition and notices, the PDF, the standard format refusing 8D fields.
- 314 tests, web build, fresh seed, 226 UI smoke checks (completing D7 in the browser), accessibility audit with 0 violations over 84 page views including the 8D page.

## 2026-10-22: S15a Repair or replace

Asset lifecycle economics (brief Category 2), from records already kept (D-125).

**Built**
- **Migration `0033`:** expected life and downtime cost per hour on assets; legacy cost on imported work orders.
- **Engine:** yearly cost (labor, parts, vendor invoices, legacy cost, priced downtime) over the asset tree; trend with a floor; equivalent annual cost of a new unit; verdict, reason and crossover year; every default stated.
- **Import:** the maintenance history target's "Parts and contractor cost" field now lands in `legacy_cost`; a CMMS cost-history profile.
- **Report and UI:** `repair-or-replace`; a section on the asset page; the asset form takes expected life and downtime cost.
- **Seed (Ridgeline):** five years of cost history; CNC-101 comes out replace (29,370 a year to keep against 25,313 for a new one), CMP-01 and HMC-201 keep.

**Verified**
- 5 new tests: capital recovery factor, hand-computed verdicts, the floor, missing inputs, the cost history from records.
- 309 tests, web build, fresh seed, UI smoke, accessibility audit with 0 violations.

## 2026-10-22: S14b Continuous improvement

Ideas to validated savings, with results measured from the records (D-124).

**Built**
- **Migration `0032`:** `improvement`; permissions `improve.submit` (all roles) and `improve.manage` (leads), also in the role templates; action-tracker subject `improvement`.
- **Service:**
  - submit, decide, plan, baseline, implemented, result (≥ 28 days after the change), validate (not the owner)
  - `measure()` for asset unplanned downtime and work-center scrap rate
  - notifications to leads, the owner and the submitter
- **Report:** `improvement-pipeline` (closed this year, validated vs estimated savings, results that did not improve, ideas waiting more than two weeks).
- **UI:** an Improvements list with a suggestion form; an improvement page guiding each stage (decision, plan, baseline, implemented, result, validation, actions).
- **Seed (Ridgeline):**
  - quick-change fixtures closed: 48 → 22 min, $14,500 validated against $18,000 estimated
  - HMC-201 holder balancing measuring, with a baseline of 9.6 h/week of downtime from state history
  - an interlock-check idea from an operator

**Verified**
- 2 new tests: the full cycle with hand-computed downtime before and after; declines need a reason; the 28-day rule; manual metrics.
- 304 tests, web build, fresh seed, 219 UI smoke checks, accessibility audit with 0 violations.

## 2026-10-22: S14a Shift passdown

A structured shift handover (brief Category 2), built on the records already kept (D-123).

**Built**
- **Migration `0031`:** `shift_handover`, frozen by trigger once handed over; `shift_handover_item`.
- **Service:**
  - facts compiled for the shift window (equipment, work, production and scrap, late orders, NCRs, SPC signals, incidents, excursions)
  - drafts that carry open items from the previous log
  - hand over (facts frozen, supervisors told)
  - acknowledge by someone else
  - default shift by the site's local hour
- **UI:** Shift log list and log page (safety first, items with resolve, notes, equipment, production and quality facts), in the Production or Maintenance menu.
- **Seed (Ridgeline):** yesterday's 2nd shift acknowledged; today's 1st shift handed over with a carried quality item, a resolved equipment item and a new safety item.

**Fixed while building**
- **Window end:** the default window ended at the top of the hour, which left out the last part of the shift. It now ends at the time of writing and extends to the hand-over.

**Verified**
- 2 new tests: default shift by local hour; the full cycle with facts, frozen record, acknowledgement rules, carry-over by area, and the list.
- 302 tests, web build, fresh seed, 216 UI smoke checks.

## 2026-10-22: Accessibility audit (WCAG 2.1 AA, automated)

**Built**
- **`scripts/a11y-audit.ts` (`npm run a11y`):** axe-core over about 40 page views (main pages and details: work order, asset, SPC charts, supplier performance), as five roles, in light and dark schemes. It fails on serious or critical violations.

**Found and fixed** (39 violations → 0)
- **Faint text contrast** about 3:1 → 4.5:1 or better on every background (light `#616c79`, dark `#8e9aa7`).
- **Tablists:** the tabs on Planning, Leasing and Store operations sat in a `group` with a dropdown. They are now a `tablist` with `aria-selected`, with the dropdown outside it.
- **Notification badge:** contrast in dark mode (`--on-bad` token).
- **Links in running text:** underlined, so they do not rely on color alone.

**Not covered by the automated audit:** keyboard order, screen-reader wording, and focus after actions. These need a manual review before a pilot that requires them.

**Verified**
- Audit 0 violations; 212 UI smoke checks.

## 2026-10-22: S3b Offline-capable technician app

Technicians can keep working without a connection (D-121).

**Built**
- **Idempotency keys** on every authenticated write (migration `0030`, `platform/http/idempotency.ts`): the first 2xx response is stored and replayed; a reused key for another request is refused; errors are not stored; purged after 7 days.
- **Client offline module:**
  - saved copies of my work orders and opened work orders
  - an outbox for labor, parts used and status changes, sent in order with idempotency keys when the connection returns
  - refusals kept with their reason (`/outbox` page: try again or discard)
  - an offline bar; a pending list and optimistic status on the work order
  - sign-out warns about unsent changes and clears device copies
- **Installable app:** manifest, icon and a service worker that keeps the app shell (network first for pages, cache first for assets).

**Verified**
- 2 new API tests: replay returns the first response and posts once; keys are per user; a reused key is refused; failures are not stored; keyless requests are untouched.
- UI smoke: offline labor waits in the outbox, the offline bar shows, and on reconnect it is sent and appears exactly once.
- 300 tests, web build, fresh seed, 212 UI smoke checks.

## 2026-10-22: S3c Controlled document viewer

Documents now open in the browser instead of downloading (D-120).

**Built**
- **Viewer page** `/documents/:id`:
  - shows PDF (browser viewer), images and text; other formats download
  - the revision in force by default; banners for superseded and draft revisions
  - a revisions list for people allowed to see them
  - a controlled-copy notice, and a print stamp "UNCONTROLLED WHEN PRINTED" with the revision and date
- **Links:** "Open" on asset pages, work orders (the pinned revision), training and the shop floor now go to the viewer.
- **API helper:** `api.blob` loads protected files for in-page viewing.

**Verified**
- 209 UI smoke checks: a technician opens a troubleshooting guide in the viewer and does not see superseded revisions.

## 2026-10-22: S13a Supplier performance and corrective action requests

Advanced supplier quality (brief Category 2), built on records already kept.

**Decisions** (D-117 to D-119):
- **Scorecards:** on-time delivery, rejected ppm, price against quote and invoice, and corrective action requests; the rating is the worst of them.
- **Corrective action requests:** a corrective action addressed to the supplier, emailed, answered by staff entry, chased when late.
- **History:** delivery history imported from the previous system counts in the scorecards.

**Built**
- **Migration `0029`:** supplier fields on corrective actions; `supplier_delivery_history`.
- **Service:** scorecards, `issueScar`, `recordSupplierResponse`.
- **Reminders and report:** `reminder.scar_overdue`; report `supplier-performance`.
- **Import target `supplier_deliveries`:** profile `vendor-delivery.json` for an old ERP's vendor delivery report.
- **UI:**
  - Purchasing → Supplier performance tab
  - supplier page: scorecard and request form
  - corrective action page: supplier section with the answer
  - nonconformance page: link to the supplier

**Seed (Ridgeline)**
- 86 lines of vendor delivery history across three suppliers.
- A corrective action request to Ridgeway for the seal kits held at receiving.
- Result: Ridgeway poor (57% on time, 65% rejected), Great Lakes watch, Koval good.

**Fixed while building**
- **ppm denominator:** lots held at receiving were left out of the denominator, which produced impossible ppm figures. Rejected ppm now divides by received + rejected at receiving.

**Verified**
- 3 new tests: scorecard measures (hand-built orders and receipts), the request through reminder and answer, and the history import.
- 298 tests, web build, fresh seed, 207 UI smoke checks.

## 2026-10-22: S12b Attribute control charts

SPC now covers shops that count rather than measure: leak-test failures, paint defects, missing labels.

**Decision** (D-116):
- **Charts:** p, np, c and u, with binomial or Poisson limits; per-sample limits for p and u.
- **Rules:** three of them (beyond a limit, 9 in a row, 6 trending).
- **In place of capability:** the average rate (% defective and ppm, or defects per unit).

**Built**
- **Migration `0028`:** chart type, sample sizes; the immutability trigger covers the sample size.
- **Engine:** functions for attribute centers, points and rules.
- **Service:** attribute recording (whole counts, defective ≤ inspected, fixed or per-sample n), limits from a baseline, chart view with stepped limits, list rate.
- **Import:** `spc_measurements` takes a sample size.
- **Report:** a "Defect rate" column.
- **UI:**
  - setup by what is recorded
  - p, np, c and u page with stepped limits on the chart (`ControlChart` bands)
  - count and sample-size entry; samples table

**Seed (Ridgeline)**
- HSG-LEAK: leak test failures per lot (40–90 parts), about 1.9% defective, in control, limits from 25 lots.

**Verified**
- 4 new tests: engine tests for p, np, c and u (hand-computed) plus varying-limit rules, and a database test.
- 295 tests, web build, fresh seed, 203 UI smoke checks.

## 2026-10-22: S11d Consumables, chemicals and PM parts in the plan

The material plan now covers what the brief lists beyond BOM materials (§12.8): production consumables and chemicals, and maintenance parts from PM plans, with a cost forecast.

**Decisions** (D-114, D-115):
- **Consumption rates:** per machine hour, per unit made, or per month (site-wide allowed).
- **PM parts:** parts lists of calendar PM plans projected on their schedule.
- **Projection and cost:** both feed the purchased-material projection, costed as production consumption.

**Built**
- **Migration `0027`:** `consumption_rate`.
- **Engine:**
  - purchased materials netted after the load (per-hour usage follows machine hours)
  - units per work center
  - `consumption`, `maintenanceParts` and `consumablesCost` outputs; a source breakdown on each material
- **Service:** rate list and save (replace or remove); PM parts projected in `planInput`; unit costs.
- **Import target `consumption_rates`:** "quantity per N" and basis words; profile `consumables-usage.json` for a maintenance lead's usage sheet.
- **UI:**
  - Plan tab: "Consumables, chemicals and PM parts" section with monthly cost; "For" column on materials.
  - Consumables tab: manage rates.
- **Report:** consumables and PM parts cost insight.

**Seed (Ridgeline)**
- Coolant, inserts and wash detergent with opening stock, imported from a usage sheet in the plant's own wording.
- Result: $6,010 of consumables and $1,224 of PM parts over six months; coolant short from November.

**Verified**
- 2 new tests: an engine test (hand-computed) and a database test (rates, import with "1 per 120", plan).
- 291 tests, web build, fresh seed, 200 UI smoke checks.

## 2026-10-22: S11c Qualified labor in the plan

The plan now checks whether there are enough qualified people to run the load, not just enough machine hours (brief §12.8 "qualified workforce").

**Decision** (D-113):
- **Who counts:** a person counts for a work center when they hold every qualification its machines require to operate, valid in that month.
- **Hours:** demonstrated from approved timesheets, else 40 a week assumed.
- **Sharing:** shared people are allocated by maximum flow.
- **Setting:** operators per machine hour, per work center.

**Built**
- **Migration `0026`:** `work_center.labor_ratio`.
- **Engine:** `maxFlow`, `planLabor` (shortfall per work center and month, one-person warnings, qualifications lapsing in the horizon).
- **Service:** gathers requirements, holders and timesheet hours.
- **Report:** capacity-plan insights on operator shortfalls and single-person work centers.
- **UI:**
  - Planning page: a "Qualified operators" section and an operator-shortfall key figure.
  - Calendars tab: an operators-per-machine-hour field.
- **Header menu:** fits on one line on medium desktops (tighter spacing from 761 to 1439 px; wrapping remains the fallback).

**Seed (Ridgeline)**
- Three CNC operators; CNC-TURN required on the lathe, CNC-MILL on the machining centers; six weeks of approved timesheets (one operator works 48 h).
- Tolu's turning sign-off lapses on 21 November, which leaves the lathe with one qualified operator; it is then 2 h short in February and 10 h short in March.

**Verified**
- 4 new tests: max flow, shared people vs per-center sums (hand-computed), operators per machine hour, lapses, and a database test.
- 289 tests, web build, fresh seed, 198 UI smoke checks.

## 2026-10-22: Property licensing in bands of up to 100

The founder decided D-086 for property management: pricing is based on bands of up to 100 properties rather than per facility.

**What changed**
- **Rule (D-112):** active property sites ≤ bands × 100.
- **Defaults:** one band per tenant; provisioning takes `propertyBands`.
- **Enforcement:**
  - The 101st property (new, reactivated, or another site turned into a property) is refused, with a message saying how to make room.
  - Inactive properties free their place.
  - A database trigger enforces this for screens, imports and provisioning alike.
- **Visibility:** the Sites page shows "Properties licensed n of 100" (amber at 90%, red when full); also at `GET /api/licence`.
- **Not changed:** tenants cannot change their own licence. Stores and other site kinds are not counted (still open).

**Verified**
- 2 new tests: band fill, deactivation, reactivation, kind change, the trigger as a backstop, tenant cannot write the licence, and a second band.
- 285 tests, fresh seed, 196 UI smoke checks.

## 2026-10-22: S12a Statistical process control

SPC is in the approved Category 2 scope (brief §12.7, PRODUCT_SCOPE). It is built on records that already exist: parts and operations, machines, calibrated gauges, production orders, nonconformances and notifications.

**Decisions** (D-107 to D-111):
- **Charts and rules:** X̄–R and I–MR charts with four run rules.
- **Limits:** set from a baseline of at least 20 subgroups, kept as history; trial limits raise no signals.
- **Measurements:** append-only, refused when the gauge was out of calibration, flagged as suspect after an out-of-tolerance calibration.
- **Capability:** reported with its qualifications.
- **Signals:** answered by quality, optionally raising an NCR. No automatic holds.

**Built**
- **Migration `0024`:** characteristics, subgroups (append-only trigger), limits, signals; RLS by site.
- **`spc/engine.ts`:** limits, rules, capability.
- **`spc/service.ts`:** setup, recording with the gauge check and signals, limits, exclusion, answers with an NCR, chart and list views.
- **Import and report:** import target `spc_measurements` with value splitting; report `spc-summary` ("1 characteristic of 2 has open control-chart signals; lowest Cpk 1.16 (HSG-BORE)").
- **UI:** Quality → SPC list; characteristic page with X̄/R or I/MR charts, open signals and answers, recording, limit setting, the measurement table.
- **Seed (Ridgeline):**
  - **HSG-BORE:** the seal bore, measured with BG-250. A 25-subgroup study sets the limits, then the boring insert wears and signals open. This ties to the FMEA row "Bore oversize" and the audit finding on BG-250.
  - **HSG-FLAT:** sealing-face flatness imported from a CMM export with profile `cmm-results.json`.

**Verified**
- **Engine tests:** 10, against the published constants and hand-computed cases.
- **Database tests:** 8 (setup, immutability, trial vs set limits, signals, answers with NCR and exclusion, run of 9, gauge refusal and suspect flags, import and report).
- **Totals:** 283 tests, web build, fresh seed, 194 UI smoke checks (signal answered with an NCR, reading recorded).

## 2026-10-22: S11b Acting on the plan

The plan now leads to action, and capacity accounts for planned maintenance.

**Decisions** (D-105, D-106):
- **Drafts, not commitments:** the plan drafts a purchase request (normal approvals apply) and creates production orders in status `planned`. Only the plan as it stands, never a scenario.
- **PM off capacity:** calendar PM plans' estimated hours come off their machines' work-center capacity; meter-based plans and plans without hours are listed as assumptions.

**Built**
- **Engine:**
  - open production orders' unissued materials are dependent demand (this was a gap: open orders' materials were not counted)
  - open purchase requests reduce `toRequest`
  - `projectMaintenance` and a `maintenance` column per work-center month
- **Service:** `requestPlanShortages`, `createPlannedOrders`; `planInput` gathers allocations, requested quantities and PM plans.
- **Routes:** `POST /api/plan/purchase-request`, `POST /api/plan/production-orders`.
- **UI:** a "Requested" column and a button for the purchase request; "create order" per part and month; PM hours in the load grid.

**Verified**
- 5 new tests: engine (allocations, requests, PM projection) and database (request once, orders netted with materials kept, PM deducted).
- 265 tests, web build, fresh seed, UI smoke (plan actions).

## 2026-10-22: S11a Demand, capacity and material plan

The brief calls capacity and resource planning the flagship Category 2 capability (§12.8). This is its first slice, built on what is already recorded (routings, BOMs, stock, orders, machine state, production runs) rather than on typed-in rates.

**Decisions** (D-101 to D-104):
- **Forecasts:** versioned, reviewed and activated; firm orders consume forecast per customer and month.
- **Plan:** a pure, deterministic plan with stated assumptions.
- **Scenarios:** store adjustments only.
- **Later:** what the engine does not see yet is listed.

**Built**
- Migration `0023`:
  - work-center calendars (hours per week, machines or crews)
  - customer forecasts and lines (active versions frozen)
  - planning scenarios
  - `planning.view` / `planning.manage` on stock roles
- **`planning/engine.ts`:**
  - demand with forecast consumption
  - low-level-code netting, lot for lot
  - routing load with demonstrated or standard rates and yields
  - capacity from calendar, machines and demonstrated availability
  - purchased-material projection with need-by and order-by dates
  - bottleneck and assumptions
- **`planning/service.ts`:**
  - plan inputs for a site
  - forecast drafts, lines, activation, version view with the change and firm orders
  - calendars
  - scenarios
  - plan with scenario comparison
- **Imports:** `customer_forecasts` target with a month-header parser.
- **Report:** Capacity and material plan.
- **Web:** Planning page with plan, forecasts and calendars (load grid by work center and month, materials, planned production, assumptions, scenarios); forecast version page.
- **Seed (Ridgeline):**
  - a customer forecast spreadsheet (a column per month, generated with current months) imported for two customers and activated
  - calendars for the four work centers
  - a "Second shift on the lathe" scenario
  - The plan shows CNC-104's lathe going over capacity in late months and four purchased materials short.

**Found on the way**
- Forecast month headers (`2026-11`) were rejected by the date parser: customers write months, not dates. There is now a month parser for `Nov-26`, `Nov 2026`, `11/2026`, `2026-11-15` and similar.
- Load from seal kits made for housings was all labelled "forecast": the firm/forecast split now flows from parent to component.
- Manual work centers were listed as "no machine state history" assumptions; there is no machine to measure, so they are not.
- A shortage in the current month had a need-by date on the 1st (already past); it is now today.
- The report's "largest load there" summed the whole horizon while naming one month; reworded.

**Verified (commands actually run)**
- `npm run typecheck` clean; `npm run web:build` succeeds.
- `npm test`: **260 tests passed**. The 10 new tests cover:
  - **Engine** (7, hand-computed):
    - firm consuming forecast per customer; netting through two levels
    - lathe load with a demonstrated rate, firm/forecast split
    - mill with no calendar, seal kits with a demonstrated yield, the bottleneck
    - material shortfall with need-by, order-by and lateness
    - the exact assumptions list
    - a scenario with extra hours and forecast growth that leaves firm orders alone
    - past-due firm orders and demand beyond the horizon
    - the month-header parser
  - **Database** (3):
    - forecast versions (draft, activate, frozen, superseded)
    - a wide forecast imported into the draft with the change from the previous version and firm orders above it
    - the plan from real tables: demand, production, load, assumptions, materials
    - calendar permissions, scenario comparison, report headline
- UI smoke against a freshly seeded server: **186/186 checks passed**. The 7 new checks cover:
  - the plan: load grid, the lathe, materials, assumptions
  - the second-shift scenario compared with the plan as is
  - the forecast version page
  - the report headline naming the bottleneck

**Not done (D-104):**
- labor qualifications as a constraint
- PM and downtime calendars beyond demonstrated availability
- production lead-time offsets, safety stock, lot sizes
- finite scheduling and sequencing
- consumables and chemicals, shelf life
- cross-site supply
- creating purchase requests or production orders from the plan (a planner does that today)

## 2026-10-22: S10c Store operations (retail)

**Decisions** (D-097 to D-100):
- **Conditions:** condition logs separate from meters; one request per excursion; missed readings after 1.5 × the interval.
- **Site visits:** light checklists with scoring, repeats and follow-up.

**Built**
- Migration `0022`:
  - condition points, append-only readings, excursions (one open per point)
  - visit templates, visits and items (final once completed)
  - actions on visit items; request sources `condition` and `visit`
  - visit permissions; district manager role
  - the public-request constraint narrowed to public requests: as written in S10a it blocked any request without a requester name
- **`storeops` service:**
  - condition points, record reading (excursion and request), list with state, history
  - checklist templates, start visit, answer item, complete (score, requests or actions, notify the store), visit view with repeats, list
- **Imports:** `condition_points` and `condition_readings` targets.
- **Report:** Store standards and conditions.
- **Reminders:** daily missed-readings reminder.
- **Web:**
  - Conditions & visits page: conditions with quick logging, visits, checklists editor
  - visit page: answer, change, complete
  - condition log panel on the asset page (QR flow)
- **Seed:** a fourth tenant, **Northwind Market**:
  - five stores in two districts, 11 pieces of equipment, 8 temperature logs and 3 contractors, all imported
  - three days of the temperature form (generated with recent dates, imported): a warm produce cooler sent to refrigeration with a not-to-exceed, a freezer defrost excursion that closed, and an Express store that stopped logging
  - three store walks, one dropping from 92% to 75% with a critical miss

**Found on the way**
- The standards report counted expected readings over the whole 30 days even when logging began three days ago (every store showed ~10%). It now counts from when logging began.
- The checklist kept Pass/Fail controls on answered items, so it was unclear what was left. Answered items now collapse with a "change" link.
- A visit with a critical miss showed a green score; now red.

**Verified (commands actually run)**
- `npm run typecheck` clean; `npm run web:build` succeeds.
- `npm test`: **250 tests passed**. The 5 new tests cover:
  - limits by asset managers only
  - one excursion and one request for three warm readings; closing when back in range; readings immutable
  - temperature log import (valid, out-of-limit warning, unknown equipment rejected) in store-local time; missed-reading reminder to the store
  - visit permissions, fail needs a reason, all items answered, owner for non-maintenance fails; score with n/a excluded; equipment fail → request, other fail → action due next day for a critical item; completed visit final
  - repeat failure flagged on the next visit; standards report headline and row
- UI smoke against a freshly seeded server: **179/179 checks passed**. The 8 new checks cover:
  - the store manager sees only their store's logs; a warm reading raises a request
  - the district manager sees the open excursion and the missed logs
  - a 12-item store walk with a critical equipment failure scored 91.7% and raising a request
  - the store standards report

**Not done:**
- sensor feeds (D-008)
- food-safety discard rules
- photos on visit items
- recurring scheduled checklists (opening and closing)
- per-item weights

## 2026-10-22: S10b Leasing (landlords)

**Decisions** (D-092 to D-096):
- **Leases:** rental units on spaces; renters are customers. One lease in force per unit, with holdover until move-out.
- **Billing:** rent billed as ordinary invoices with day proration and account keys.
- **Not built:** late fees, deposits, owner statements and payment portals.
- **Unit turns:** made of work orders.

**Built**
- Migration `0021`:
  - rental units, leases (exclusion constraint), lease charges, lease billing, unit turns
  - invoice line account keys and the invoice's lease
  - renter party type
  - leasing permissions on stock roles (property managers also get receivables)
- `leasing` service:
  - units; lease create, activate, cancel, notice, move-out, renew; lease view with invoices and balance
  - rent roll
  - billing preview and run (issue or draft)
  - unit turns: list, add work, ready
- Receivables payload uses the line's account key (`rental_income`, `tenant_charges` added to the account catalog).
- **Imports:** `rental_units` and `leases` targets.
- **Report:** Rent roll and occupancy.
- **Reminders:** weekly leasing reminder (leases ending without renewal, late turns).
- **Web:**
  - Leasing page: rent roll with new-lease form, unit turns, rent billing with preview
  - lease page: notice, move-out, renewal, charges, invoices
- **Seed (Harborview):**
  - the unit directory loaded a second time as rental units (common areas rejected on purpose)
  - a 13-lease rent roll: a holdover, a notice, two company tenants
  - a move-out with a late turn: painting with a contractor, carpet still open
  - two months of rent billed and paid, except one renter on notice ($3,590 past due) and one this month

**Verified (commands actually run)**
- `npm run typecheck` clean; `npm run web:build` succeeds.
- `npm test`: **245 tests passed**. The 6 new tests cover:
  - renter created as a customer with a primary contact; a second lease on the same unit refused
  - proration of a mid-month move-in (rent and charges); one invoice per lease per month; `rental_income` and `tenant_charges` in the accounting payload; due date the 1st
  - rent roll occupancy, vacancy, past due after grace; payment clears it; report headline
  - notice, a future move-out refused, the turn with work, ready refused while work is open
  - occupied on move-out day, vacant the day after; ended lease not billed again
  - renewal the day after with charges carried and no turn
  - rent roll and unit imports, with holdover detection and an unchanged re-run
- UI smoke against a freshly seeded server: **171/171 checks passed**. The 10 new checks cover:
  - holdover and past due on the rent roll
  - a new lease signed on a vacant unit
  - the late turn with its jobs
  - next month's rent run
  - a renewal
  - the rent roll report

**Not done:**
- late fees and scheduled rent increases
- deposit accounting and refunds
- move-in and move-out inspections with photos
- a renter portal and online payment
- owner statements
- commercial CAM reconciliation

## 2026-10-22: S10a Sites, portfolios and contractors (landlords and retail)

The question was whether the software works for landlords with many properties, and for retail operations. **Answer** (docs/FIT_PROPERTY_RETAIL.md): the maintenance and compliance side fits both, once four gaps are closed.
- **The gaps:**
  - properties are costly to set up and to price
  - units are not assets
  - work goes to contractors
  - there is no rent or leasing
- **Scope limits:**
  - POS, merchandising and replenishment are not built; they belong to the retailer's systems
  - owner statements, screening and listings are not built
- **This slice:** closes the shared gaps. Leasing (S10b) and store operations (S10c) follow.

**Decisions** (D-085 to D-091):
- Site kinds.
- Licensing per kind is an **open founder question** (D-086).
- Groups with expanded grants.
- Spaces as assets.
- Contractors with insurance and not-to-exceed.
- Wall-clock service levels.
- Request links without sign-in and a request inbox.

**Built**
- Migration `0020`:
  - facility kind, address and active flag
  - facility groups and group grants; `user_role_scope` view
  - asset class `space`
  - contractor fields on suppliers and work orders; invoices tied to work orders
  - service levels with defaults
  - public request links with a resolver function
  - request source, requester and decision fields
  - property and store manager roles
- **`sites` module:**
  - sites (list, create, edit) and groups
  - user grants on a site or a group
  - request links (create, list, revoke)
  - public form and intake (throttled)
- **`maintenance`:**
  - request inbox and decline
  - `vendors.ts`: dispatch, vendor updates, contractor details, service levels, `slaOf`
  - contractor completion replaces labor entries
  - service-level state on work orders and lists
- **Payables:** invoices tied to a work order, with the not-to-exceed in the match check (the work order authorises the lines, so they are not flagged as off-order).
- **Imports:**
  - new `sites` target
  - asset import understands property and store columns and space words
  - supplier import takes trades and certificate dates
- **Report:** Service levels by site and contractor.
- **Web:**
  - Sites page: list, add and edit, groups, request links
  - public request page at `/r/:token`
  - Requests tab on Work orders
  - contractor panel and service-level pills on work orders
  - contractor details on suppliers
- **Seed:** a third tenant, **Harborview Property Group**:
  - four properties in two portfolios, 19 units and common areas, 9 pieces of building equipment and 6 contractors, all imported from property-management style exports
  - two property managers with portfolio grants and a finance approver
  - resident requests through lobby links
  - a dispatched leak, a garage door past its response target
  - an HVAC job invoiced $120 over its not-to-exceed and approved with a note

**Found on the way**
- **Matching:** invoice lines tied to a work order fell into the purchase-order price check ("above order price null"). Fixed.
- **Sample data:** the sample vendor list had a certificate that had already lapsed (08/15/2026, today is 2026-10-22). Dispatch correctly refused it; the sample now has a current date, and one vendor with no certificate shows the refusal.
- **Request links:** places on the public form are labelled by building (location) as well as parent space.

**Verified (commands actually run)**
- `npm run typecheck` clean; `npm run web:build` succeeds.
- `npm test`: **239 tests passed**. The 8 new tests cover:
  - a portfolio grant reaches only member sites (RLS, notifications); admin-only site creation and validation
  - the request link shows only its site's spaces, takes a request into the inbox and notifies managers; revoked and unknown links fail alike; a space at another site is refused; decline with a reason
  - dispatch refused without a certificate or with a lapsed one; email with the not-to-exceed
  - acceptance and contractor completion; verification by someone else
  - an invoice over the not-to-exceed needs a variance note; an invoice from another contractor is refused
  - service-level states; report by contractor
- UI smoke against a freshly seeded server: **161/161 checks passed**. The 11 new checks cover:
  - a resident request without sign-in
  - the portfolio-only site list
  - a missed response target
  - the request inbox with contact and entry permission
  - request → work order → dispatch with not-to-exceed (lapsed contractor disabled)
  - the service-level report, including the over-limit spend

**Not done:**
- leasing and rent (S10b), store readings and visits (S10c)
- business-hour service calendars
- a contractor portal (contractors reply by phone or email; staff record it)
- photos on public requests
- per-kind licensing (D-086)

## 2026-10-22: S9d Reliability analytics

**Decisions** (D-083, D-084):
- **Definitions:** a failure is a merged unplanned stop. MTBF and MTTR are measured over observed time, with coverage shown. When state history is thin, work orders give a labelled estimate. No failures means no MTBF.
- **Trends:** a trend is shown only between periods on the same basis, and flagged only with 3 or more failures. Repeat failures are the same code within 30 days.

**Built**
- `assets/reliability.ts`: pure `computeReliability` and `mergeStops`.
- `reliabilityInputs` loader; `assetReliability` (current window, previous window, 12 months); `GET /api/assets/:id/reliability`.
- Report **Equipment reliability (MTBF / MTTR)**: bad-actor headline, Pareto share, MTBF falls, repeat codes, longest repairs, data basis per asset.
- Asset page: reliability panel (30/90/365 days, comparison with the previous period, failure-code pills with repeats, 12 months).
- Seed: machine state history extended from 30 to 60 days. The first 30 days use different failure rates (HMC-201 getting worse, PRS-01 improving after hydraulic work), so trends have something to show.

**Found on the way**
- My first basis rule required 50% coverage. With 30 days of history, the 90-day report fell back to sparse work orders and showed fewer failures than the 30-day report. MTBF and MTTR are ratios over observed time, so the rule now needs one week of records and reports the coverage.

**Verified (commands actually run)**
- `npm run typecheck` clean; `npm run web:build` succeeds.
- `npm test`: **231 tests passed**. The 6 new tests cover:
  - stop merging and the MTBF/MTTR/availability arithmetic
  - observed-time basis on partial coverage
  - work-order fallback (cancelled orders and sub-minute repairs ignored); no data
  - repeats across the window start
  - no failures gives no MTBF
  - report headline, trend, repeats and exceptions on a worsening asset
  - the asset view matches the report; other-site users refused
- UI smoke against a freshly seeded server: **150/150 checks passed**. The 4 new checks cover the asset panel basis, the comparison with the previous period, the report headline, and coverage.

**Not done:**
- life-data analysis (Weibull), MTBF by failure mode, reliability targets per asset class
- linking stops to their work orders (stops and work orders are counted separately; the work-order failure code is the link)
- telemetry-fed state (D-008 still open)

## 2026-10-22: S9c Business continuity

**Decisions** (D-079 to D-082):
- Continuity plans reuse the FMEA pattern: revisions, plant-manager approval, frozen approved body, shared actions and attachments.
- Dependencies are typed references checked live; gaps are shown, never block approval.
- Only timed exercises can demonstrate the RTO; results are final; shortfalls need an action.
- The call list stays editable on the approved plan (audited); review without change is a recorded confirmation.

**Built**
- Migration `0019`:
  - continuity plans (revisions under one number, one open revision, owner ≠ alternate)
  - dependencies, scenarios and contacts, frozen by trigger once submitted (contacts editable while approved)
  - exercises, final once recorded
  - actions and attachments can belong to a plan (and actions to an exercise); `continuity.view` and `continuity.manage` on stock roles
- `continuity` module:
  - create, edit draft header, save body, save call list
  - submit → approval by the operations manager → approve/supersede or back to draft; revise; confirm review
  - schedule, record and cancel exercises
  - `assessPlan` (live gap checks, readiness); read; list; editor pick lists
- Report **Continuity readiness**; weekly reminder when a review or an unscheduled exercise is due.
- Approvals inbox now names and links any registered subject (FMEA approvals previously showed a bare type); "my actions" links to every subject type.
- Web: Continuity page (list, new plan) and plan page (gaps, dependencies with live status, scenarios, call list, exercises with results and evidence, actions, review and revision).
- Seed:
  - BCP-001, the approved critical plan for HSG-220 supply to Lakeshore, with five dependencies, three scenarios (one estimated over the RTO), a call list, a tabletop, a simulation that took 52 h against a 48 h RTO with an action, and a scheduled full test
  - BCP-002, a draft press-brake plan at Fort Wayne with no call list yet
  - Carlos (E1008), terminated in the payroll export, is recorded as rehired, so he is no longer an active supervisor linked to a terminated employee (found by the continuity people check)

**Verified (commands actually run)**
- `npm run typecheck` clean; `npm run web:build` succeeds.
- `npm test`: **225 tests passed**. The 6 new tests cover:
  - permissions; owner ≠ alternate
  - typed dependency validation; every live gap (machine out of service, one qualified holder of two, a person with no cover, a sole-source supplier, an estimate over the RTO, no call list); a second qualified holder clears the skills gap
  - call list required and validated; approval by the plant manager; frozen body (database); call list editable after approval
  - a timed result over the RTO cannot be "met"; findings required; results final; an unanswered finding is a gap until an action is linked; a full test within the RTO demonstrates it
  - revision carries body, contacts and open actions; supersede; exercise history across revisions; call-list edits blocked while a revision is open
  - review-due gap, reminders to owner and alternate, review confirmation, readiness report headline
- UI smoke against a freshly seeded server: **146/146 checks passed**. The 11 new checks cover:
  - the plan list and three live gaps
  - recording a full test within the RTO, and confirming the review
  - a draft refused without a call list, then sent for approval
  - the approval card naming the plan
  - the readiness report

**Not done:**
- business impact analysis across processes (RTO is entered, not derived)
- notifying the call list from the platform
- per-tenant choice of approver role (fixed to `operations_manager`)
- importing existing plans from documents

## 2026-10-22: S9b FMEA

**Decisions** (D-075 to D-078):
- FMEA reuses the shared primitives.
- Action priority by default, RPN optional, priority always computed.
- High-priority rows need actions; approved analysis is frozen, with after-action evaluation and revisions.
- Equipment rows are checked against failure history.

**Built**
- Migration `0018`:
  - FMEAs (revisions under one number, one open revision at a time)
  - FMEA rows with a trigger that freezes the analysis after submission
  - actions, corrective actions and attachments can belong to an FMEA
- `quality/fmea`:
  - action priority table; method-aware priority
  - create; save worksheet (row ids preserved)
  - submit (high-priority rows need a response) → quality review through the approval engine → approve/supersede or back to draft
  - revise from after-action scores
  - evaluate a row after actions; corrective action from a row
  - read with failure history and occurrence check; list
- Report **FMEA risk register**.
- Web:
  - Quality gains an FMEA tab (list and start form)
  - FMEA page: worksheet editor and view with priority pills, per-row actions, after-action evaluation, failures in 12 months, revisions, files
- Seed:
  - an approved equipment FMEA for the CNC-104 turning cell (one high-priority mode reduced to low after its action; the turret sensor mode flagged as happening more than rated)
  - a draft process FMEA for HSG-220 assembly

**Verified (commands actually run)**
- `npm run typecheck` clean; `npm run web:build` succeeds.
- `npm test`: **219 tests passed**. The 6 new tests cover:
  - 18 action-priority table cases and RPN thresholds
  - permissions; equipment FMEA needs an asset; score validation; failure codes only on equipment FMEAs; failure-history count and occurrence flag
  - high-priority row blocks submission until it has an action; approval by the quality reviewer; frozen worksheet (service and database)
  - evaluation waits for actions and cannot raise severity
  - revision baseline from after-action scores; supersede on approval
  - corrective action from a row; RPN method; risk register headline
- UI smoke against a freshly seeded server: **135/135 checks passed** (5 new: failure-history flag, before/after summary, submission refused then accepted after adding an action, FMEA report).

**Not done:**
- FMEA structure, function and failure trees (rows are flat)
- linking rows to process FMEA control plans
- organization-specific S/O/D rating scales (the 1–10 scale with handbook meanings is assumed)

## 2026-10-22: S9a Maintenance materials: spares lists, repair templates, kits

**Decisions:** D-017 resolved as "both" (virtual and physical kits); D-071 to D-074.
- Spares and repair BOMs are linked to assets and asset categories.
- Kits reserve stock and can be staged.
- Staging stock and reservations are excluded from availability everywhere.
- Finishing or cancelling a work order releases an unissued kit.

**Built**
- Migration `0017`:
  - equipment parts lists (`asset_part`)
  - repair templates and their parts; `work_order.repair_template_id`
  - stock location kind (storeroom or staging)
  - kits and kit lines (one active kit per work order)
- `materials` module:
  - availability by location and at the site (net of reservations, excluding staging)
  - parts lists with availability and where-used
  - repair templates (machine or category); apply to a work order
  - kits: build, refresh, stage, issue, return and close, cancel, read, list
- PM generation builds kits.
- Maintenance releases unissued kits when a work order completes or is cancelled.
- Production material availability now subtracts kit reservations and excludes staging.
- Storerooms can be created as staging locations.
- Import target `asset_parts` with sample `11_oem_spares_list.csv`.
- Report **Kit readiness and critical spares**; reminder for short kits.
- Web:
  - asset page: spare parts card (availability, critical minimum, also-used-on, add/remove) and repair templates card (list, new template with part search)
  - work order: kit card (apply template, build, refresh, stage, issue, return unused, cancel)
  - Storerooms: Kits tab
- Seed:
  - a Dayton kit staging shelf; the OEM spares list imported (2 rows rejected with reasons)
  - two repair templates
  - PM work orders built with kits: one short of compressor oil, one staged

**Verified (commands actually run)**
- `npm run typecheck` clean; `npm run web:build` succeeds.
- `npm test`: **213 tests passed**. The 10 new materials tests cover:
  - spares availability, below-minimum flag, where-used, permission
  - category repair template applied once, with the labor estimate
  - kit reservation and shortage; reserved stock not offered to others
  - short kit can't be staged; refresh after receipt; staging only into a staging location, needs `inventory.manage`; ledger moves; staging stock not offered
  - issue from staging; return to the original storeroom; virtual-kit issue; cancel restores staged stock
  - work order cancel releases a staged kit; PM generation builds a kit
  - readiness report and critical spares
  - OEM spares import (match by manufacturer number, superseded and unknown parts rejected, re-import unchanged)
- UI smoke against a freshly seeded server: **130/130 checks passed** (5 new: short kit in the kit list, refresh after a delivery and staging on the shelf, spares and templates on the asset page).
- Found and fixed while checking: kits on work orders the seed had already completed kept stock reserved (now released on completion or cancellation); the short-kit reminder's 7-day window cut off work due later on day 7.

**Not done:**
- substitutions and alternates on kit lines
- kit lead times on PM plans (kits are built when the work order is generated)
- serial and lot tracking
- reliability analytics (MTBF/MTTR)

## 2026-10-22: S8c Calibration, internal audits, attachments

**Decisions** (D-067 to D-070):
- Instruments are assets under calibration control, and production is blocked when they are overdue.
- Out-of-tolerance results raise a nonconformance listing the affected runs; failed instruments go out of service.
- Audits record evidence per item, the auditor is independent of the area, and every finding is answered before close.
- Attachments follow the visibility of their record; incident files are restricted by default.

**Built**
- Migration `0016`:
  - calibration plans and immutable calibration records
  - audits and checklist items (database check: auditor ≠ area owner)
  - action items can belong to an audit and a checklist item
  - attachments
- `quality/calibration`: plan, record (impact assessment nonconformance, out of service / back in service), list with status (current, due soon, overdue, failed), plan detail with usage since the last good calibration; `assertCalibrated` called from production start.
- `quality/audits`: plan, start, record item, add item, report (area owner notified), corrective action for a finding, close (findings answered), read.
- `quality/attachments`: add, list, download with record-based access and the incident restriction.
- Reminders for calibration (overdue daily, due within 14 days weekly); the quality report now counts instruments overdue and unanswered audit findings.
- Web:
  - Quality gains Calibration and Audits tabs
  - calibration page: usage since the last good calibration, record form, history with nonconformance links, certificate upload
  - audit page: checklist recording, report, finding responses, close
  - an attachments panel on nonconformances, corrective actions, incidents (with "safety team only"), calibration and audits
- Seed:
  - the CMM, a micrometer (due in 5 days) and a bore gauge (3 days overdue) under calibration
  - an internal audit of the machining cell, reported with one minor finding and one observation
  - a planned maintenance and calibration audit

**Verified (commands actually run)**
- `npm run typecheck` clean; `npm run web:build` succeeds.
- `npm test`: **203 tests passed**. The 8 new tests cover:
  - calibration: overdue instrument blocks a production run; manage permission; future dates refused; next due date; immutable records
  - out of tolerance: notes required, can't be "in tolerance" as left, nonconformance with the suspect run listed
  - failed → out of service → passing returns it
  - audits: auditor ≠ area owner; start before recording; evidence required; report needs every item; area owner notice; findings answered before close by corrective action or action
  - attachments: incident photo restricted (manager can't list or download, safety staff and uploader can); nonconformance file visible to quality viewers; bad type refused; other facility refused
  - quality report instrument KPI
- UI smoke against a freshly seeded server: **125/125 checks passed** (8 new: photo upload on a nonconformance, recording a calibration, usage list, answering an audit finding with a corrective action and closing).
- Found and fixed while checking: "1 findings" on the audit page.

**Not done:**
- calibration labels and certificate parsing
- measurement uncertainty
- audit programs and auditor qualifications
- supplier audit scoring
- virus scanning of uploads (comes with the production storage adapter)

## 2026-10-22: S8b Quality and safety: nonconformances, corrective actions, incidents, shared actions

**Decisions** (D-061 to D-066):
- Concessions on major or critical nonconformances need a justification and a second person.
- Corrective actions require evidence at each step; the effectiveness check is independent of the owner and not done before its date.
- One action tracker serves corrective actions and incidents.
- Anyone can report incidents and near misses; private details are restricted to the safety team.
- A person decides recordability; there are no OSHA forms.
- The incident rate uses timesheet hours, and the report flags when there are too few.

**Built**
- Migration `0015`:
  - nonconformances, corrective actions, safety incidents, action items (all facility-scoped with RLS)
  - a database check that the effectiveness verifier is not the owner
  - one nonconformance per production run
  - `quality_manager` role; `quality.view/report/manage` and `safety.report/view/manage`, spread across existing roles (operators and technicians can report)
- `quality` module:
  - nonconformances: raise (from a production run, purchase order or sales order, or standalone), contain, disposition with concession rules and scrap costing, link, close, cancel
  - corrective actions: open (linking nonconformances or an incident), update, advance with evidence checks, verify, cancel
  - actions: add, complete, cancel; my actions; assignable users
- `safety` module: report, classify (recordability checks), investigate, close (decision, root cause and action checks), and reads with server-side redaction.
- Reminders: overdue actions (daily, to the owner); corrective actions ready for their effectiveness check (weekly, to quality staff other than the owner); incidents unclassified after a day (daily, to safety staff). New notification kinds.
- Reports **Nonconformances and corrective actions** and **Safety incidents and near misses**. The plural helper now handles "near misses" and "boxes".
- Production order page: "Raise NCR" on runs with scrap, linking to the nonconformance once raised.
- Web:
  - a Quality & safety menu group (Quality, Safety, Changes)
  - Quality: nonconformance list and form; nonconformance page (containment, disposition, corrective action link); corrective action page (step bar, containment and root cause, actions, effectiveness check); new corrective action form; my actions
  - Safety: report form (one tap for the kind), incident list, incident page (classification visible only to safety staff, investigation, corrective action, actions, close)
- Seed:
  - quality: two production nonconformances (one closed, one major under CA-000001 with an overdue action), a receiving nonconformance not yet contained, a customer nonconformance reworked, and CA-000002 waiting for its effectiveness check
  - safety: a closed first-aid case, a recordable strain with an open action, a closed near miss, and an unclassified near miss

**Verified (commands actually run)**
- `npm run typecheck` clean; `npm run web:build` succeeds.
- `npm test`: **195 tests passed**. The 9 new quality and safety tests cover:
  - nonconformance from a production run (fields derived, duplicate refused, reporter can follow it, quality notified)
  - concession rules (justification, not the reporter), return-to-supplier needs a supplier, scrap costing, closing needs a corrective action
  - corrective action step evidence, action owner rules and notices, the effectiveness date, owner can't verify, a failed check reopens, database check
  - incident reporting and notices without private details, redaction for managers, other-facility denial, future time refused
  - classification (days away imply recordable), closing rules, list visibility
  - safety report counts and "cannot compute" without hours, no names in rows
  - reminders for overdue actions and unclassified reports
  - quality report cost of poor quality and repeat part
- UI smoke against a freshly seeded server: **117/117 checks passed** (16 new):
  - quality containment and effectiveness check; owner finishing actions and moving to verification
  - safety team classifying, investigating and adding actions; a manager shown no injury details (asserted absent); an operator reporting a near miss
  - both reports
- Found and fixed while checking:
  - a corrective action with one open action said "complete at least one action" instead of "finish the open actions"
  - a nonconformance from a purchase order without a part was titled with only the PO number
  - the incident rate from a few hundred seeded hours (495 per 200,000 h) was shown without warning; it is now flagged as unstable

**Not done:**
- audits and calibration
- OSHA 300/300A/301 forms
- 8D and FMEA
- supplier corrective action requests sent to suppliers
- customer complaint intake as its own record
- attachments (photos) on nonconformances and incidents; the document store exists, the link does not
- incident reports from the asset page

## 2026-10-22: S8a Production: product revisions, production orders, shop floor

**Decisions** (D-055 to D-060):
- The BOM and routing are versioned together and frozen once released.
- Orders pin the revision at release; shortages are reported but don't block release.
- Shop-floor runs record good, scrap (with a reason) and rework, and quantities flow from operation to operation.
- Operators need the machine's operate qualification, and machines that are down can't run.
- Finished goods are valued at standard material cost.
- Short parts made in house lead to a production order, not a purchase request.

**Built**
- Migration `0014`:
  - work centers and their machines
  - product revisions with materials and operations (trigger freezes released ones)
  - production orders with copied materials and operations; production entries (one open run per operator and per machine; finished runs append-only)
  - scrap reasons; three production stock movements; `production` as an asset-state source
  - `production_supervisor` role; `production.view/manage/execute` (operators can view and execute, operations managers can manage)
- `production` module:
  - work centers; revisions (create as a copy, save whole, circular check, release)
  - orders: create (optionally for a sales order line), release with shortages, request shortages, cancel
  - materials: issue and return
  - shop floor: start/stop with checks (qualification, machine state, flow limits); finish operation
  - output: receive output, complete short, close with variance
  - reads: order detail with metrics, list, work-center floor queue
- Assets: `applyState` split out of `recordState`, so production records machine state after its own permission check.
- Import target `boms` (flat or indented, dotted or outline levels; unit mismatches rejected) with sample `10_engineering_bom_indented.csv`.
- Report **Production status and yield**.
- Sales order lines show their production orders and a "Make" action; the rep is notified when a make-to-order production order finishes.
- Web:
  - a Production menu group with Production orders and Shop floor
  - tabs for orders, shop floor, products and work centers
  - order page: operations, materials with issue and shortages, receiving, shop-floor record, stock movements, complete short or close
  - product revision page: routing and materials editor, release, new revision
  - shop floor: machines and qualification needs, the operator's running job with a stop form, queue with start, running now
- Seed:
  - Carlos (production supervisor); raw materials; the legacy BOM imported (2 rows rejected with reasons)
  - routings added and released; four Dayton work centers; a CMM operator qualification held by Tolu
  - a closed order with scrap and rework history; a make-to-order order for Miami Valley in progress (milling running live on CNC-101, short of seal kits); a planned order

**Verified (commands actually run)**
- `npm run typecheck` clean; `npm run web:build` succeeds.
- `npm test`: **186 tests passed**. The 12 new production tests cover:
  - revisions: self-containment and circular structures refused; routing required to release; released revisions frozen in the database; new revision copies and supersedes
  - orders: release copies materials scaled with scrap allowance; shortages and the purchase request (not duplicated); made-in-house shortages refused for purchase
  - materials: issue and return through the ledger
  - shop floor: machine required and must belong to the work center; one job per machine and per operator; supervisor-only recording for others; scrap reason; flow limit between operations; rework ≤ good; finished runs immutable; qualification and machine-down checks; floor queue
  - output: receipt at standard material cost; complete short reason; close; per-line material variance
  - report: yield and scrap reason
  - BOM import: indented sample; flat file; level parsing
- UI smoke against a freshly seeded server: **101/101 checks passed** (15 new: supervisor, operator on the shop floor, production report).
- Found and fixed while checking:
  - a shortage of an in-house part would have become a purchase request
  - report percentages were on a 0–100 scale instead of the platform's fractions
  - an operation still receiving units looked like it had nothing to do (now "more to come")
  - a seeded run spanned a night shift and skewed hours

**Not done:**
- MRP (multi-level explosion), scheduling and capacity
- labor from production runs is not yet fed into timesheets
- lot/serial traceability
- labor and overhead costing
- routing alternates
- work instructions are linkable in the data model but not yet in the routing editor
- quality records (S8b next)

## 2026-10-22: S7b Receivables: customer invoices, payments, credit hold and collections

**Decisions** (D-050 to D-054):
- Invoice shipped quantity only.
- Number invoices at issue.
- Credit hold over the limit, released by finance.
- Payments follow the accounting system of record.
- Payment reminders are started by a person.

**Built**
- Migration `0013`:
  - `qty_invoiced` on order lines (check ≤ shipped); credit hold on orders
  - customer invoices and lines, customer payments and allocations (append-only)
  - collections activities linked to invoices; payment-reminder emails to customer contacts
  - MOCK accounting customers and invoices
  - `ar_clerk` role; `ar.view` / `ar.manage` / `ar.credit` permissions (finance approvers get all three; sales managers and executives can view)
- `ar` module: draft from order, edit draft, issue (number, due date, stored PDF, outbox event), void, payments with allocation rules, payments from accounting, invoice PDF, to-invoice list, collections queue, call log with promises, payment reminders, customer account with credit exposure.
- Sales: credit check on acceptance, shipping refused while on hold, release with a reason; order page shows invoiced quantity and invoices.
- Integrations: AR topics in both adapters (separate receivables export file; MOCK customer find-or-create and invoices); payments pulled for open AR invoices; four new account keys.
- Notifications: credit-hold notice to credit approvers; weekly overdue-receivables reminder; promise-to-pay follow-ups link to the invoice.
- Report **Accounts receivable aging** (buckets, days sales outstanding, promises, shipped-not-invoiced, credit holds).
- Web:
  - Receivables (Sales menu): invoices, ready to invoice, collections queue, record payment
  - invoice page (edit draft, issue, PDF, collections call, reminder, payments, history, accounting status, void)
  - customer account page
  - credit-hold banner and release on the order page
- Seed: Casey (billing). Three invoices issued (one current, one overdue with a promise to pay, one older and partly paid in MOCK accounting), and a Tri-County order on credit hold.
- Report pages now format currency values (they showed raw numbers, also in the AP aging and pipeline reports).

**Verified (commands actually run)**
- `npm run typecheck` clean; `npm run web:build` succeeds.
- `npm test`: **174 tests passed**. The 10 new receivables tests cover:
  - drafting only shipped quantity; one draft per order
  - issue numbering, due date from terms, stored PDF, outbox payload accounts, invoiced ≤ shipped enforced by the database
  - void returns quantity, drafts never take a number
  - payment allocation rules (whole payment, customer match, balance cap), status transitions, append-only payments
  - credit hold, notification, release permission
  - collections queue, promise to pay, reminder email dedupe, weekly reminder
  - AR aging; file-export receivables CSV; MOCK customer and invoice records; payments from accounting, idempotent
- UI smoke against a freshly seeded server: **86/86 checks passed** (18 new: billing, collections, finance releasing a credit hold, AR aging report).
- Found and fixed while checking:
  - row lock on an outer join failed when issuing
  - the smoke test showed that Lakeshore's imported contact email had been rejected as invalid; the reminder button is now disabled with a note in that case, instead of failing
  - currency formatting on report pages

**Not done:**
- credit memos and customer returns
- unapplied cash and refunds (left in accounting)
- sales tax calculation (typed on the invoice)
- automatic dunning
- statements

## 2026-10-22: S7a CRM, quotes and sales orders

**Decisions** (D-047 to D-049):
- Pricing approval over 15% off list or under 20% margin.
- Customers are tenant-wide.
- The exact PDF sent for each quote revision is stored.

**Built**
- Migration `0012`:
  - customers, contacts (one primary), opportunities, activities
  - sales catalog
  - quotes (lines, sent PDFs), sales orders (lines), shipments (append-only lines)
  - a `shipment` stock movement
  - RLS and grants; sales rep / sales manager roles; `crm.*` / `sales.*` permissions
- `crm` module: customers, contacts, opportunities (stage probabilities, lost reason, automatic advance from quotes), activities and follow-up tasks, pipeline.
- `sales` module:
  - catalog
  - quotes: draft, pricing check, approval through the engine, send (stored PDF and email activity), revise, accept (creates the order, wins the opportunity, makes the prospect a customer), decline with reason
  - orders: promised date; shipments from storerooms through the ledger; cancel only before anything ships; the rep is notified of shipments
- Quote PDF (customer-facing; drafts watermarked).
- Approvals inbox shows quote pricing requests with their reasons.
- Reminders for overdue follow-up tasks and sent quotes about to expire.
- Report **Sales pipeline**.
- Import target `customers`, with sample `09_crm_company_export.csv` and its profile.
- Report wording: a shared plural helper ("opportunities", "people").
- Web:
  - Customers: list, pipeline board, my follow-ups, customer page with contacts, opportunities (stage moves), activity log, quotes and orders.
  - Quotes and orders: lists, catalog, quote editor with list-price discount badges, quote page with internal margin, next-step actions, sent PDFs and approvals; order page with promised date and shipping (defaults capped at stock on hand).
  - A "Sales" menu group.
- Seed:
  - Riley (rep) and Taylor (manager); the CRM export imported; a finished-goods storeroom and catalog.
  - Five opportunities, activities including an overdue follow-up.
  - Quotes: accepted with a partly shipped order now late; one waiting on pricing approval; one sent and expiring; one declined.

**Verified (commands actually run)**
- `npm run typecheck` clean; `npm run web:build` succeeds.
- `npm test`: **164 tests passed**. New tests (sales and unit) cover:
  - primary contact, lost reason
  - in-limit quote ready at once; sent PDF stored; opportunity to proposal; activity logged
  - discount and margin reasons; manager rejection back to draft, then approval
  - revisions keep their own PDFs; expired acceptance refused; decline reason
  - acceptance creates the order (lines, ship-to), wins the opportunity, converts the customer
  - shipping requires a storeroom for stocked items, refuses over-shipping, writes the ledger, notifies the rep; shipment lines are immutable
  - pipeline KPIs; follow-up reminders; customer import with contacts and idempotency; plural wording
- Seeded pipeline: $29,260 weighted across 4 open opportunities, win rate 50%, 1 order late to ship.
- UI smoke against a freshly seeded server: **68/68 checks passed** (11 new: rep, sales manager, order desk).
- Found and fixed while checking:
  - quote lines lost their unit of measure on the PDF (regression test added)
  - "opportunitys" in report text
  - shipping defaulted to more than was in stock

**Not done (S7b next):**
- customer invoices, payments, AR aging and collections queue, export to accounting
- credit-limit checks (need AR)
- customer returns
- taxes (left to accounting)

## 2026-10-22: S3b Notifications and grouped navigation

**Why now:** notifications are a Category 1 shared service in the brief, and every workflow built so far depends on people learning that something waits for them. The admin menu had also outgrown one row.

**Decisions** (D-045, D-046):
- In-app notifications plus an optional daily email digest.
- Email goes through a development adapter only, until a provider is chosen and security-reviewed.
- Reminders are deduplicated per day or per week.
- "Waiting" notices close themselves once the step is decided.

**Built**
- Migration `0011`: notifications (per-user dedupe), preferences (digest on/off, muted kinds), email queue; RLS and grants.
- `platform/notify`: `notify()` inside the caller's transaction (skips muted users and the person who caused the event); recipients by role at a facility (including active delegates), by permission, and by employee.
- Producers:
  - the approval engine: next stage's approvers on create and stage change, requester on decision, and auto-closing waiting notices (subjects register their label and link)
  - work-order assignment, training assignment, timesheet sent back, delivery received for a request
- Reminder sweep (system scope, 10 rules), digest queue and retrying sender, `DevFileMailSender`, `scripts/run-reminders.ts`.
- Web:
  - bell with unread count
  - notifications page (open marks read and goes to the record; mark all read; settings: digest and per-kind mutes)
  - main menu grouped into Maintenance / Supply / People / Admin dropdowns, positioned so they work inside the sideways-scrolling bar on phones
- Seed: runs the reminder sweep after loading the demo.

**Verified (commands actually run)**
- `npm run typecheck` clean; `npm run web:build` succeeds.
- `npm test`: **154 tests passed** (6 new). They cover:
  - stage-by-stage approver notices and the requester's outcome
  - no repeat notice for someone who already signed; waiting notices close once signed
  - delegate notified; assignment notifies the technician, not the assigner; muted kinds skipped
  - users can clear only their own
  - the reminder sweep is idempotent
  - one digest per user per day, with opt-out respected and failed sends retried
- UI smoke against a freshly seeded server: **57/57 checks passed**. The smoke test navigates through the grouped menus. Writing it caught and fixed the bug where "waiting" notices stayed unread after the request was signed.
- `scripts/run-reminders.ts` against the demo data wrote 10 digest files; the content was reviewed.

**Not done:**
- a hosted email provider (D-045)
- push or SMS
- action items as a shared service (MOC has its own actions)
- per-facility quiet hours

## 2026-10-21: S6b Time capture, approval and payroll-ready export

**Decisions taken to keep moving** (D-042 to D-044):
- Weekly timesheets with two-person approval.
- Overtime flagged, not calculated (Category 2).
- Generic payroll CSV until the pilot's payroll provider is known.

**Built**
- Migration `0010`:
  - earning codes (defaults per tenant), timesheets, time entries, payroll exports
  - a trigger that freezes entries of approved or exported weeks
  - RLS and grants; payroll administrator role; `time.approve`, `time.view_all`, `time.export`
- `time` module:
  - open or create a week (own, or on someone's behalf by an approver)
  - live work-order hours in drafts; manual entries with earning codes
  - submit (copies and locks work-order hours); approve, or send back with a note
  - second approver required when keyed on someone's behalf; reopen before export
  - overtime and long-day warnings; team week view
  - payroll preview (ready / exported / not ready) and export (summary or daily) with code mapping
- Work-order labor is refused for a week that is submitted, approved or exported.
- Report **Time and labor**: completion, waiting, worked and leave hours, wrench time (technicians), overtime-review weeks.
- Web:
  - Time page: my week with a day grid, entries, add time and submit; team view by week; timesheet review with approve, send back or reopen; payroll export with preview, files and earning-code mapping.
  - API client gained DELETE.
- Seed:
  - Lena (payroll).
  - Two weeks of routine work orders with labor for three technicians.
  - Two past weeks of timesheets: one fully approved and exported; one mixed (approved, waiting, sent back, not started).
  - A draft for the current week.

**Verified (commands actually run)**
- `npm run typecheck` clean; `npm run web:build` succeeds.
- `npm test`: **148 tests passed** (9 new time tests). They cover:
  - week boundaries; live work-order hours; date and code validation; who can see a sheet
  - submission locks work-order labor; send-back needs a note; approved entries are frozen at the database
  - reopen; on-behalf entry needs a second approver; overtime flag; team view
  - payroll preview and export content with mapped codes; exported weeks can't be reopened or exported twice
  - the time and labor report figures
- Seeded report: 64% of timesheets approved for the last 2 weeks, 1 waiting; wrench time 44% (88 of 198 h); 2 weeks flagged for overtime review.
- UI smoke against a freshly seeded server: **54/54 checks passed**. It caught and fixed:
  - the team view double-counted work-order hours on a week that had been sent back (regression test added)
  - the payroll file list did not show file names

**Not done:**
- payroll-provider formats or APIs (D-016)
- scheduling and availability
- PTO balances and accruals (Category 2)
- clock in/out
- a time tile on the home page

## 2026-10-21: S6a Accounts payable and the integration framework

**Decisions taken to keep moving** (D-038 to D-041):
- The accounting connector itself waits on the pilot's system (D-016). I built everything that does not depend on that choice instead of guessing a provider.
- Invoice approval uses two-person separation.
- Accounting owns payments once connected.
- Mocks exist only as labeled MOCK connections.

**Built**
- Migration `0009`:
  - supplier invoices and lines (duplicate-number guard), account mapping
  - integration connections (one active per tenant), outbox (append-only), delivery queue, export files
  - MOCK accounting records
  - RLS and grants; AP clerk role; `ap.view` / `ap.manage` / `integrations.manage` permissions
- `ap` module:
  - capture (from an order's received-not-invoiced quantities, or by hand) with the scanned file
  - due dates from payment terms
  - basic match against order and receipts
  - approval by a second person, with a reason required for mismatches
  - dispute, void (sends a void to accounting if already exported), due-date override
  - manual payment only in file-export mode
- Platform outbox (`emit()` with idempotency keys) and adapter interface.
- `integrations` module:
  - connections with optional backfill
  - sync runner (claim with SKIP LOCKED, deliver, record, backoff 1/5/30/120/720 minutes, dead after 6 tries, payments pulled back)
  - retry and resolve-by-hand
  - export-file download, account mapping
  - MOCK controls (pay a bill "in accounting", simulate an outage)
- Adapters:
  - generic AP CSV export
  - MOCK accounting: vendor find-or-create via the external-ID crosswalk, idempotent bill creation, voids, payments
- `scripts/run-sync.ts` for scheduling.
- Report **Accounts payable aging**.
- Web:
  - Payables page: KPIs, list, capture form pre-filled from the order with file upload, invoice detail with match warnings, approval, payment, dispute/void and accounting status.
  - Accounting page: connect, MOCK banner, sync queue with retry/resolve, export files, a view inside the MOCK system, chart-of-accounts mapping.
  - "Capture invoice" and the invoice list on purchase orders.
- Seed:
  - Ana (AP clerk).
  - Four invoices: one paid through the MOCK system, one 20 days overdue, one billed before delivery waiting for approval, one disputed.
  - The account mapping, and the MOCK connection with one payment returned.

**Verified (commands actually run)**
- `npm run typecheck` clean; `npm run web:build` succeeds.
- `npm test`: **139 tests passed** (12 new AP/integration tests plus an HTTP flow). The tests cover:
  - payment-terms parsing; capture from an order with accounts by line and the file
  - duplicate numbers refused (case-insensitive); mismatch rules; capturer cannot approve
  - exactly-once outbox emission; outbox immutability
  - unmapped account → failure → fix → backoff respected → delivery
  - a delivered-but-unrecorded retry does not duplicate
  - outage → dead after 6 tries → shown in aging KPIs → manual retry succeeds
  - payments from accounting; manual payment refused with an API connection
  - void propagates to accounting; paid invoices cannot be voided
  - file export CSV content with account codes; manual payment in file mode
  - tenant isolation
- Seeded AP aging: $4,793 open, $645 overdue (the hose repair, 20 days), 1 waiting for approval, 1 disputed.
- UI smoke against a freshly seeded server: **46/46 checks passed**. It caught and fixed:
  - the accounting page did not refresh its queue and MOCK bill list after "Sync now"
  - the admin menu overflowed off-screen on desktop (it now wraps)
  - the approvals badge stayed stale after a decision (it now refreshes on navigation)

**Not done:**
- QuickBooks Online / Xero connector (D-016)
- time capture and payroll-ready export (S6b)
- early-payment discounts
- credit memos
- recurring bills
- grouping the growing admin menu into sections

## 2026-10-21: S5 Purchasing (on the shared approval engine)

**Decisions taken to keep moving** (D-034 to D-037, all reversible):
- Approval routing is tenant data, with starter rules:
  - budget owner for every amount
  - plant manager from $2,500
  - finance from $10,000 and for all capital requests
- Any change after submission needs re-approval.
- Buyers may order up to 10% above the approved total.
- Delegation is dated and recorded on each signature.
- Purchase orders are printed, not transmitted. Invoices stay in accounting.

**Built**
- Migration `0008`:
  - suppliers and supplier prices (one preferred per part)
  - purchase approval rules
  - purchase requests and lines
  - purchase orders and lines, append-only receipts
  - approval delegation, plus `on_behalf_of` on approval steps
  - RLS and grants, new roles (buyer, finance approver), `purchasing.*` permissions, default rules for existing tenants
- Approval engine: delegation (decide, queue, history). Separation-of-duties checks cover both the delegate and the delegator.
- `purchasing` module:
  - supplier and price management
  - requests: draft, submit with a computed route, material change → superseded, cancel
  - approval callback
  - orders split by supplier with the price tolerance; cancel frees the request lines
  - receiving through the stock ledger at the order price (storeroom required for parts stocked at the site, over-receipt refused)
  - request from a work order's uncovered parts, and from the reorder report
  - printable PO PDF
- Parts-to-reorder now uses the stock position (on hand + on order + requested), with "on order" and "requested" columns.
- Work orders show their purchases.
- New report **Purchasing status**: awaiting approval and who it waits on, approved not ordered, open and late orders, committed spend, supplier on-time delivery.
- Imports:
  - `suppliers` and `supplier_prices` targets.
  - Samples `07_accounting_vendor_list.csv` (Tax ID column deliberately ignored by its profile, malformed email, inactive vendor) and `08_supplier_price_list.xlsx` (quote workbook with banner rows, text lead times, and supplier/our part-number headers that read backwards). Both have profiles.
  - A real gap found and fixed: "Item" was not recognized as our part number.
- Web:
  - Purchasing page: requests, orders and suppliers tabs; new request with line editor; request detail with route preview, edit (with a re-approval warning), submit, cancel, order placement with price check, sign-off history with on-behalf-of.
  - Purchase order detail with PDF, receiving per line into storerooms, receipts, cancel.
  - Supplier detail with prices.
  - Approvals inbox shows purchase requests (amount, spend type, requester) and a delegation panel.
  - Work order shows purchases and "Request parts not in stock".
- Seed:
  - Kim (buyer) and Morgan (finance). Alex also covers Fort Wayne.
  - Vendor and price-list imports.
  - A replenishment request from the reorder report, approved and ordered, with the Koval order received.
  - An OEM encoder for the on-hold PRS-01 work order, signed in two stages and now a late order.
  - A capital spindle request waiting on finance.
  - A draft.

**Verified (commands actually run)**
- `npm run typecheck` (API + web) clean; `npm run web:build` succeeds.
- `npm test`: **126 tests passed** (12 purchasing tests, a sample-file import check, an HTTP purchasing flow). The tests cover:
  - routing by amount and spend type, no self-approval, distinct signers, staged order, rejection needs a comment
  - re-approval after change
  - delegation (recorded, not usable for the delegator's own request, ends when revoked)
  - price tolerance, split by supplier, cancel frees lines
  - receipts posting to the ledger with average cost, over-receipt and storeroom rules, receipt immutability
  - work-order shortage requests without duplicates
  - reorder position and drafting a request from it
  - status report; vendor and price-list imports with idempotency
- `npm run seed` completes. Purchasing status on seeded data: 1 late order (the PRS-01 encoder), 1 request awaiting finance, on-time delivery 100% (1 of 1).
- UI smoke: **38/38 checks passed** (10 new: requester, finance, buyer ordering and receiving). It caught a real bug, fixed before commit: "Create purchase order" had no click handler. Screenshots reviewed.

**Not done:** department-based routing, escalation reminders, blanket/standing orders, returns to supplier, supplier portal or email/EDI sending, invoice matching (S6 accounting adapter).

## 2026-10-21: S4 Preventive maintenance + inventory essentials

**Decisions taken to keep moving** (D-029 to D-033, all reversible):
- Stock is an append-only ledger and negative stock is refused.
- A stocked part must be issued from a named storeroom.
- PM plans advance on verification.
- One open work order per plan.
- No reservations or kits until D-017 is answered.

**Built**
- Migration `0007`:
  - storerooms, stock balances, the stock ledger (immutability trigger), cycle counts
  - meter readings, PM plans and their parts lists
  - `work_order.pm_plan_id` with a one-open-work-order-per-plan index
  - RLS, grants, and `inventory.view` / `inventory.manage` permissions
- `inventory` module: receipts with moving-average cost, issues, returns, transfers, adjustments with a reason, reorder settings, cycle counts with a stale-snapshot guard, ledger queries.
- Maintenance changes:
  - Using a stocked part requires its storeroom and posts an issue.
  - Unused parts can be returned.
  - Verifying a PM work order advances its plan.
- `pm` module: calendar/meter plans, completion vs fixed schedules, lead windows, a schedule with parts availability, idempotent work-order generation (planned parts plus the current approved procedure), and meter readings that cannot go backwards.
- Import target `stock_balances`: sets on-hand by posting the difference. Re-imports are no-ops.
- Reports:
  - **Preventive maintenance compliance**: on time / late / open past due, plans due and overdue now, parts shortages.
  - **Parts to reorder**: at/below reorder point or short for PM demand in the next N days, with a suggested quantity and estimated cost.
- Web:
  - PM page: schedule, generate, new plan with parts list, plan detail with history and pause/resume.
  - Storerooms page: stock with low-stock filter, per-part ledger, adjust, reorder settings, receiving, cycle counts with the moved-stock confirmation.
  - Work order: storeroom choice when recording parts, and returns.
  - Asset page: PM plans and meter reading entry.
- Seed:
  - Dayton and Fort Wayne storerooms.
  - The storeroom export imported a second time as opening stock (new profile `storeroom-stock.json`). The rejected compressor-oil row is then added by hand with a quoted price.
  - Reorder points.
  - Six PM plans. CNC-101's monthly plan has three cycles of history (on time, late, on time). CMP-01 has a 2000-hour meter plan with readings.
  - Generated PM work orders.

**Verified (commands actually run)**
- `npm run typecheck` (API + web) clean; `npm run web:build` succeeds.
- `npm test`: **113 tests passed**. 13 are new: ledger math and average cost, negative stock refused, append-only at both layers, transfers and facility scope, work-order issue/return and the storeroom rule, counts with the moved-stock guard, opening-stock import idempotency, due states and next-due rules, generation without duplicates, plan advance on verification, both reports, and an HTTP test of the new endpoints.
- `npm run seed` completes. Results:
  - PM compliance on the seeded data reads **50.0% (2 of 4 on time; HMC-201 quarterly overdue)**.
  - Parts to reorder lists 4 parts. Compressor oil is short for the upcoming 2000-hour service.
- UI smoke: **28/28 checks passed** (13 new), with no page or console errors. Screenshots and both report PDFs reviewed visually. Fixed after review:
  - Storeroom KPI tiles counted only filtered rows.
  - Part numbers wrapped mid-number.
  - Report meter wording.

**Not done:** PM calendar view; stock reservations and kits (D-017); lot/serial tracking; meter replacement/reset; scheduled (nightly) PM generation, which waits on the job queue; purchase orders (S5).

## 2026-10-21: S3 web app, first increment

**Decisions taken to keep moving** (founder had not answered; both reversible):
- React + Vite (D-011).
- A clearly labeled development sign-in that takes a demo API token until an identity provider is chosen (D-008 stays open).

**Built**
- `web/`: app shell with permission-aware navigation and an approvals badge.
- Screens:
  - Home: my work orders, my sign-offs, my training, KPI tiles.
  - Assets: search, detail with open-change warning, documents, components, state buttons, problem report form; QR route `/a/:token`.
  - Work orders: list filters; detail with start, labor, parts, complete, verify, close and assign. Server qualification errors are shown inline.
  - Approvals inbox: approve, or reject with a comment.
  - Changes: list, request form, screening questionnaire, sign-off history, action plan with completion and work-order linking, pre-startup review checklist, close.
  - Training: my training, my qualifications with certificate PDFs, team records, enrollment detail with self-completion, trainer and evaluator sign-off, and quiz taking.
  - Reports: list, native rendering of every report with facility filter, CSV/PDF export.
  - Data import wizard: choose file, match columns with confidence, translate code values, dry run with problems file, partial import, save the mapping as a profile.
- API additions: `GET /api/work-orders?assigned=me`; the API server serves the built app with client-route fallback.
- `scripts/ui-smoke.ts` (Playwright) and `npm run ui:smoke`. CI now also builds the web app.

**Verified (commands actually run)**
- `npm run typecheck` (API + web) clean; `npm run web:build` succeeds (235 kB JS, 73 kB gzipped).
- `npm test`: 100 backend tests passed.
- UI smoke against a freshly seeded server: **15/15 checks passed**, no page or console errors, no horizontal scroll at 390 px. Screenshots reviewed visually.
- **Bugs found and fixed:** stale data briefly rendered on tab switches (crashed the qualifications tab); rebuilt asset files served as HTML; and the value-translation step listed values the server already recognizes.


## 2026-10-21: S2b Management of change (scope change SC-001)

**Scope:** MOC was not in the original brief. The founder asked to add it, and the §12.9 gate analysis is in `docs/scope-changes/SC-001-management-of-change.md` (proposed: core MOC Category 1, PSM-grade packs Category 2).

**Built**
- Migration `0006`: shared approval engine tables, MOC tables, RLS, new stock roles (operations manager, EHS reviewer, quality reviewer), MOC permissions.
- `platform/approvals`: staged, role-addressed approvals with no self-approval, distinct signers, final decisions, supersede on material change, approver queue.
- `moc` module: create/revise (material change → re-approval), versioned screening rules, generated action plan, verified action completion, PSSR checklist and startup sign-off, temporary-change controls, close and cancel. Asset detail shows open changes.
- Report: Management of change register.
- Seed: four changes in different stages (high-risk change mid-implementation, temporary change in service and ending soon, chemical change waiting on EHS, draft at Fort Wayne) and three reviewer users.

**Verified (commands actually run)**
- `npm run typecheck` clean. `npm test`: **100 tests passed** (9 MOC tests, an HTTP MOC test).
- Seeded the dev database, ran the server, checked the EHS reviewer's approval queue and the register report (JSON and PDF, reviewed visually).


## 2026-10-21: S2 LMS → qualification → equipment gating

**Built**
- Migration `0004`: courses, versions (frozen once published), learning events of six kinds, assessments, enrollments, append-only completions/attempts/evidence, qualifications, grants (never deleted; revocation recorded), certificates, external credentials, asset qualification requirements, training reviews, RLS and new role permissions. Migration `0005`: staged import rows can come from one source column (unpivot).
- `learning` module: catalog and publishing, assignment (individuals, job title, facility), completion rules per event kind, assessment delivery and deterministic grading, evidence upload/download, eligibility, grant/revoke, certificates (PDF), training reviews raised by document revisions.
- Maintenance now enforces `maintain` qualifications on assignment, start of work and labor entry.
- Imports: generic `unpivot` option and a `qualification_records` target. New sample `06_training_matrix.xlsx` with saved profile.
- Reports: Qualification status & expiries (with single-person coverage risk), Training compliance.
- Seed: 5 qualifications, the training matrix import, a 6-event spindle course and a LOTO refresher. One technician is taken through to a granted, certified qualification and one is part-way. HMC-201 requires the spindle and LOTO qualifications. A revised troubleshooting guide leaves an open training review.

**Verified (commands actually run)**
- `npm run typecheck` clean. `npm test`: **90 tests passed** (13 new LMS tests, a training-matrix import test, an HTTP test for the learning endpoints).
- Brief §13.4 LMS acceptance tests are now covered: mixed event types each recorded; assessment delivered, graded, attempt history and limit; evaluator sign-off required; completion alone grants nothing; authorized grant and revoke; validity checked before restricted assignment; revision flags training without overwriting history.
- Confirmed with `psql` as the table owner that triggers block editing training records and editing or deleting grants.
- Seeded the dev database, ran the server, and fetched both new reports and a certificate PDF. Reviewed the rendered PDFs visually.


## 2026-10-21: S0 foundation + S1 first vertical slice

**Repository audit (before work):** the repository contained only `README.md` (`# erp`) and one commit. There was no existing code, stack, auth, integrations, migrations or tests, so the build is greenfield (D-001).

**Built**
- Migrations `0001` (tenancy, identity, RBAC, entitlements, audit chain, RLS), `0002` (documents, assets, locations, state log, parts, maintenance), `0003` (import profiles, batches, rows, external-ID crosswalk).
- Platform: tenant-scoped transactions, permission model + role templates, hashed API tokens, audit append and verify, blob storage interface (local adapter), tenant provisioning.
- Modules and HTTP API: org/employees, assets (incl. utilization), documents, maintenance, parts, imports, reporting.
- Import framework: CSV/XLSX/JSON parsers, auto-mapping, declarative mapping profiles, coercion (numbers, dates with per-column order inference, facility-time-zone timestamps), 5 targets, staging/dry-run, commit with savepoints, problems CSV, re-import idempotency.
- Reports: maintenance backlog and asset availability/utilization, rendered as JSON, CSV, print HTML and PDF.
- Sample data: generator for 5 messy Ridgeline files + 1 Northgate file, 4 saved mapping profiles, demo documents. The seed loads everything through the import pipeline, then creates documents, 30 days of state history and work orders in every lifecycle state.
- CI workflow (GitHub Actions with a PostgreSQL 16 service).

**Verified (commands actually run)**
- `npm run typecheck`: clean.
- `npm test`: **75 tests passed** across 5 files:
  - unit: utilization math, coercion, transforms, auto-mapping, parsers, CSV safety
  - security: tenant isolation incl. document download, cross-tenant writes, no-scope connections, audit immutability, facility scoping, consolidated access, read-only roles
  - maintenance: document approval/visibility/revision/immutability; full corrective work-order lifecycle with costs, separation of duties and return to service; pinned procedure versions
  - imports: dry run, partial commit, idempotent re-import, explicit mappings, Excel banners, hierarchies, duplicate/overlap detection, problems file, permissions, all bundled samples
  - API + reports: auth, scoping, error mapping, document upload/download, HTTP import flow, report consistency across formats, export permissions, empty-scope messaging
- `npm run seed` against the dev database completed. All sample imports produced the expected created/rejected counts (one intentionally bad parts row and one work order for a no-longer-registered machine are rejected with reasons).
- Started the server and exercised the asset, document search, import-suggest and report endpoints with curl. Rendered both PDFs to images and reviewed them visually (fixed header wrapping, unsupported glyphs, and blank pages from the footer).

**Brief §13.4 acceptance tests: status**

| Acceptance test | Status |
|---|---|
| Tenant A cannot read/write Tenant B data, incl. document downloads and background operations | ✅ tested |
| Facility-restricted user cannot access other facility; corporate user sees consolidated | ✅ tested |
| Asset has controlled searchable documents; users see only authorized approved versions from asset/work-order views | ✅ tested |
| Corrective WO links asset, technician, parts/labor, procedure, state changes, immutable audit | ✅ tested |
| LMS mixed learning events, assessments, qualification gating, revision → training review | ✅ tested in S2 (see entry above) |
| Reporting (a) consistent metrics across formats, (b) facility-restricted exports, (f) empty data messaging | ✅ tested. (c) print without clipping / (d) units + sources checked visually. (e) drill-down path provided, UI pending |

**Not done / known gaps:** web UI; production identity provider; S3 storage adapter; async jobs for very large imports; XLSX export; PM scheduling; inventory (LMS followed in S2). See ROADMAP and ARCHITECTURE §9.

## Production readiness (D-182)
Security self-review, dependency patches, upload-serving hardening, production configuration check, `scripts/load-test.ts` with measured results, and `docs/OPERATIONS.md` (deployment, upgrade, backup and recovery, monitoring, capacity, owner decisions). New `test/security.test.ts` (8 tests). Remaining: independent pen test, hosting, real-environment load test.

## User guide
56-page HTML guide (about 56,000 words) in `docs/guide-src/`, built by `scripts/build-guide.ts` into `web/public/guide/` and served by the app at `/guide/` (Help link in the top bar). Search, print styles, dark mode, phone layout, link check (`--check`). Ordinary pages for non-experts; Administrator brief and Reference sections more technical. Writing it exposed product gaps that were fixed: New asset and New work order forms, cycle-count interval field, Record payment on bills for built-in books, offline changes kept when a session expires, SSO key and issuer-slash handling.

## People and access screens (D-183A)
Admin → People and access with Users, Roles and Tokens tabs; server routes under `/api/admin-users`, `/api/admin-roles`, `/api/admin-tokens` (`src/modules/access/`); migration 0090; control-plane scripts `scripts/create-company.ts` and `scripts/set-entitlement.ts` with a new section 11 in OPERATIONS. Users: list with grants, add a person, rename, disable and enable (immediate, ends sign-in sessions), link and unlink the single-sign-on identity; grants reuse `/api/user-grants`, now refusing any grant or removal the administrator could not make themselves (`src/modules/access/delegation.ts`). Roles: starter roles read-only, company roles as a named set of permissions. Tokens: issue (shown once, hash only, optional expiry), list with last used, revoke, rotation steps. New `test/admin-access.test.ts` (19 tests: permissions, Lite, disabled-user lockout, single-sign-on link and unlink, role rules, escalation by permission and by site, hash-only tokens, revoke and expiry, tenant isolation); a `peopleAndAccessSmoke` function appended to `scripts/ui-smoke.ts`; guide pages updated to remove the "no screen" statements (admin-sites-and-people, admin-sign-in, roles-and-access, permissions-table, faq-and-troubleshooting, admin-first-week, admin-security-and-operations, admin-features-and-editions, getting-started). Not done: a screen for the licence or company creation (by instruction), email notice to a person when disabled, an audit-log view per person.

## Real email, scheduled sync, one expiry series (D-183B)
SMTP sender behind the mail-sender interface (nodemailer 9.1.1), chosen by `SMTP_HOST`; failures kept and retried by the next daily run, administrators notified when a message is given up on; admin "Send a test email to me". Verified only against an in-process fake SMTP server (`test/fake-smtp.ts`, `test/email-smtp.test.ts`, 20 tests); not against a real provider (O-2). The accounting sync is a daily-job step per company (`modules/integrations/scheduled.ts`). Quote and temporary-change expiry notices are one series each (`test/job-sync-and-reminders.test.ts`, 11 tests). "Run it now" is recorded in `job_run` and reports per-step results; migration 0100. Guide pages and OPERATIONS config table updated.

## My day offline, rework, return material (D-183C)
- **Field service offline.** `web/src/offline.ts` now queues visit start, report draft and report submission (PUT supported, same Idempotency-Key on the first try and the queued copy, drafts and refused attempts replaced by the newer one), caches the day, visits, report drafts and parts, and keeps the report form on the device; `MyDay.tsx` shows the offline state, queued and refused items per stop, visit details and restores the draft (defect fixed). Server: omitted signature keeps the saved one; starting a started visit is a no-op. Tests: `test/field-service-offline.test.ts` (replay of start, draft, submit; labor, parts and audit once), UI smoke `offlineMyDay()` (offline start, labor and completion queue and sync; draft restore after reload).
- **Rejected changes.** Rework and resubmission in `Changes.tsx`, new revision per round, rejection reason on the change (`getChange().rejection`). Tests: `test/moc-rework.test.ts`.
- **Return material.** `Return material` panel on the production order, lot support in `returnMaterial`, gross issued and returned per line, close refused with a recorded reason when material is left over. `test/production.test.ts` closes with a reason (one line changed). Tests: `test/production-return.test.ts`.
- **Purchasing.** `Submit for approval` on an awarded quote request; supplier picker when ordering a line without a supplier (`test/order-supplier-pick.test.ts`).
- Guide pages updated: field-service-my-day, offline-and-tablets, changes-and-notices, production-orders, supplier-rfqs, purchasing, faq-and-troubleshooting.

## SC-007 D: samples and test results
- Methods, samples with append-only custody, tests, results gated by qualification and calibration, separate reviewer, out-of-specification investigations linked to Quality, certificate of analysis PDF, What is late sections, two reminders, three reports, the `Lab samples` page and guide page `samples-and-tests` (D-184D). Migration 0150. Tests: `test/lab-*.test.ts`. Generated guide output in `web/public/guide` is not rebuilt here; run `npx tsx scripts/build-guide.ts` after merging.
## Cleanroom environmental monitoring (D-184A, SC-007 A)
- **Built.** Migration `0120_cleanroom.sql` (rooms, points, point limits, append-only readings, excursions, RLS by site, role permissions), module `src/modules/cleanroom/` (limit generator in `limits.ts`, service, routes), page `web/src/pages/Cleanrooms.tsx` (list, room page with points, limits editor, reading form, trend chart, excursions, class limits table), report `cleanroom-monitoring`, import target `cleanroom_readings` with sample `samples/imports/cleanroom/particle-counter-export.csv`, What is late section, daily reminder `cleanroom_sampling`, guide page `cleanrooms.html`.
- **Tests.** `test/cleanroom-limits.test.ts`, `test/cleanroom-monitoring.test.ts`, `test/cleanroom-import.test.ts`; UI smoke `cleanroomSmoke()`; the page is in the accessibility audit (no serious findings). `test/reminder-settings.test.ts` and the smoke test no longer hard-code the number of reminders.
- **Not verified / not built.** The generated limits are not checked against a copy of ISO 14644-1 here (only against the values in the change case); no live counter connection; no unit conversion on import.
- **SC-007 C Chemicals and reagents (D-184C).** Migration 0140, module `src/modules/chemicals/` (rules, service, preparations, alerts, routes), `Chemicals.tsx` (Maintenance → Chemicals), reports `hazardous-inventory`, `chemical-expiry`, `chemical-exceptions` (`reporting/chemical-reports.ts`), reminders `chemical_expiring` and `chemical_exceptions`, a What is late section, label sheets via `renderLabels` (scan.ts), a hook in `postTxn` that makes containers on receipt, guide page `chemicals-and-reagents`. Tests: `test/chemicals-rules`, `-containers`, `-preparations`, `-alerts-reports`, `-access`.
