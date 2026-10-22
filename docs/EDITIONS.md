# Editions: Lite and Standard

Founder decision, 2026-10-22: a **Lite** edition for very small companies (about $50 a month), with basic bookkeeping, that connects to the larger feature set when the company is ready. Prices are commercial and not in the software (D-015); the software enforces what each edition includes. Decisions: D-135 to D-138.

## Comparison

| | Lite | Standard |
|---|---|---|
| Sites | 1 | per licence (property cap 100, D-127) |
| Users | 5 active | per licence |
| Intranet: news, people, handbook and policies, search | ✓ | ✓ |
| Expense reports (owner approves) | ✓ | ✓ (department heads, site, department and amount rules) |
| Customers, simple invoices, payments, collections | ✓ | ✓ plus quotes, sales orders, shipments |
| Suppliers and bills | ✓ (bills without purchase orders) | ✓ plus purchasing and three-way checks |
| Built-in books (D-139) | ✓ | ✓ (or an external accounting system) |
| Imports in the customer's own layouts (bank statements, customers, suppliers, history) | ✓ | ✓ |
| Assets, maintenance, PM, storerooms, production, quality, safety, planning, budgets, leasing, store operations | Not included | ✓ |

## The built-in books

The books cover small-business depth:
- **Chart and journal.** A starter chart of accounts, and a journal of balanced entries that never change (corrections are reversals).
- **Posting.** Invoices, bills, expense reports and payments post as they happen.
- **Banking.** Bank and card statements come in, in each bank's own CSV layout, with matching, categorizing and rules, plus reconciliation.
- **Close and statements.** A period lock; profit and loss, balance sheet, trial balance, account registers; a journal export.

- **Starting partway through.** Open invoices, approved bills and approved expense reports already in the platform come in as opening balances (at setup, or Books → Settings → Bring in open items; nothing posts twice). The previous system's trial balance comes in under Data import → Opening balances, in its own layout (a QuickBooks Desktop export and its saved mapping are in `samples/imports/kessler/`).

Not included, in any edition: payroll processing, tax filing, multi-currency, consolidation, fixed-asset depreciation schedules, inventory valuation. The brief (§12.7) excluded a native general ledger; the founder's decisions (D-136, D-139) change that boundary for this small-business depth only, in every edition, and the platform still integrates with external accounting for companies that use one. D-139 records how to reverse it.

## Single-person approval

In a company where the requester is the only person who could sign (a sole owner), separation of duties cannot apply. When the licence allows it (on for Lite by default), that person may approve their own expense report, bill or reimbursement, and the audit records it as self-approved. As soon as someone else could sign, the normal rule applies.

## Upgrading

The control plane changes the edition; nothing is migrated, because both editions use the same records.
- **Keep the books.** The built-in books stay as the accounting connection, and Standard modules post through them the same way (stock purchases, capital, freight).
- **Move to an external system.** Export the journal (Books → Statements → Export journal), import opening balances into the new system, disconnect the books under Accounting, and connect the new system; events from then on go there.
