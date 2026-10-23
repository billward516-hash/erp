# System check on two years of data (S45)

**Answer:** every integrity, recovery and verification check passes on Stonebridge Components (two plants, 160 machines, 730 days). The run found and fixed three real problems; none remain open.

Reproduce: `npm run seed && npm run seed:history && npx tsx scripts/system-check.ts` (about 6 minutes in all).

## Data checked
asset 160, work order 4,585, work order labor 6,135, work order part 4,821, asset state event 199,588, inventory txn 18,617, time entry 41,365, timesheet 7,420, spc subgroup 25,056, production order 3,200, production entry 19,200, customer invoice 2,336, customer payment 2,058, supplier invoice 1,752, journal entry 7,758, journal line 20,649, nonconformance 420, safety incident 70, asset meter reading 8,320, supplier delivery history 1,600, audit event 17,566, outbox event 7,757.

## Found and fixed
1. **Missing foreign-key indexes (performance).** 605 foreign-key columns had no index. Row-level security on child tables (work order labor and parts, and others) tests that the parent row is visible, so without an index the database scanned the whole child table once per parent row. The Repair or replace report took **23 s** for 160 machines; it takes **0.8 s** now, and a labor lookup fell from 183 ms to 4 ms. Migration 0073 adds 358 indexes (references to people and tiny tenant-only tables are left out on purpose), and `test/schema-indexes.test.ts` fails if a later migration adds a foreign key without one.
2. **Company rollback failed on tables with identity columns (correctness).** Restoring a whole company stopped with "cannot insert a non-DEFAULT value into column id" for the ledger, meter readings, notifications and about ten other tables. Both rollback and record restore now insert with the original ids. Rolling back a two-year company takes 25 s, leaves work orders unchanged, removes records made after the archive, and the audit chain still verifies.
3. **Test-order dependency in the accessibility audit.** It opened a reading the smoke test had already acknowledged; it now skips a record that is gone.

## Integrity
| | Check | Result |
|---|---|---|
| ✅ | Audit chain verifies for every company | 6 companies, 20,200 events |
| ✅ | Stock balances equal the sum of their movements | 0 balances differ from their ledger |
| ✅ | Every movement's balance_after is the running total (in order of posting) | 0 movements out of step |
| ✅ | No stock balance is negative | 0 negative |
| ✅ | Posting order equals date order in the stock ledger | 0 movements dated before the one posted just ahead of them |
| ✅ | Every ledger entry balances (debits equal credits) | 0 unbalanced entries of 7,758 |
| ✅ | Trial balance: total debits equal total credits | debits 110,606,096.87 credits 110,606,096.87 |
| ✅ | Receivables ledger account equals open customer invoices | ledger 5,377,557.5 vs invoices less receipts 5,377,557.5 |
| ✅ | Payables ledger account equals unpaid supplier bills | ledger 842,857.49 vs approved bills less payments 842,857.49 |
| ✅ | Work orders: numbers unique and in sequence; closed ones have sensible dates | 4585 orders, sequence at 4586, 0 gaps, 0 date problems |
| ✅ | Machine states: no overlaps; hours within the calendar | 0 overlaps (last 30 days sampled; the database forbids them), 0 states longer than a day |
| ✅ | Timesheets: one per person per week, no day over 24 hours | 0 duplicate weeks, 0 days over 24 h, 0 entries outside their week |
| ✅ | Production: operation quantities match entries; received quantity does not exceed made | 0 orders over-received, 0 operations whose counts differ from their entries |
| ✅ | Immutable records reject change (stock, audit, closed reviews) | 3 of 3 tampering attempts refused |
| ✅ | Row-level isolation: no company can read another company's rows | 218 tables, both directions; 0 leaks; 0 rows visible with no company context |
| ✅ | Schema: every table with company data has row-level security on | 0 application-readable tables without RLS |
| ✅ | Every foreign key to a business record has an index (row-level security on child tables depends on it) | none missing |

## Recovery at scale
| | Step | Result | Time |
|---|---|---|---|
| ✅ | Company archive | e6455f9b-2f3d-45e7-9714-e9870bbdda53 17.9 MB | 5.3 s |
| ✅ | Archive contents listing | 56 tables | 1.2 s |
| ✅ | Browse archived work orders | 50 rows on the first page | 1.6 s |
| ✅ | Restore three deleted records from the archive | 3 of 3 back; {"restored":{"safety_incident":3},"answer":"3 records brought back from the archive of 2026-10-23 | 1.1 s |
| ✅ | Rollback to the archive (request, second administrator confirms) | 75 safety reports back to 70; 4585 work orders unchanged; audit chain intact | 25.2 s |

## Performance (slowest 12 of 70 requests; median of three, in-process)
| Request | Time | Size |
|---|---|---|
| Report: repair-or-replace | 831 ms | 16 KB |
| Spend analysis | 571 ms | 2 KB |
| Report: labor-productivity | 326 ms | 5 KB |
| Production orders | 212 ms | 191 KB |
| Report: asset-availability | 199 ms | 30 KB |
| Report: reliability | 187 ms | 35 KB |
| SPC characteristics | 98 ms | 5 KB |
| Inventory balances | 93 ms | 140 KB |
| Work orders (closed, search) | 63 ms | 119 KB |
| Customer invoices | 63 ms | 184 KB |
| Supplier invoices | 63 ms | 149 KB |
| Work orders (list) | 61 ms | 119 KB |

No request is over 1 s. Remaining soft spots, by design left alone: Repair or replace and Spend analysis (under 1 s, but they query per machine / per category), and list endpoints return up to 200 rows (about 190 KB), so pages should stay paged.

## Verification on the same data
Typecheck clean; accessibility audit 194 page views, 0 violations; 586 tests in 70 files pass; UI smoke 348 checks pass; the crawl visited 1,077 pages and 296 records as 40 users (including all Stonebridge roles) with 0 issues; the API sweep ran 4,860 calls over 612 routes with 0 server errors.

## Observations for the owner
- **Built-in books post when a sync runs.** Invoices and bills reach the ledger only when the accounting sync runs (`scripts/run-sync.ts`). The server's scheduler runs the daily job but not the sync, so until someone schedules it the ledger lags. The history generator drains it explicitly. Worth deciding: run the sync in the server every few minutes.
- The sample data are generated, not recorded: patterns (failure rates, payment delays) are plausible, not calibrated.
