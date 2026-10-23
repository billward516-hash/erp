# SC-005 Requests for quote (as buyer and as supplier) and commercial timing measures

**Requested by:** founder, 2026-10-23 ("How does this software handle an RFQ process, either as a requester or as a supplier responding? We should also put the measurements such as aging PO, invoice, delayed payment, deadlines for work or quotes to be provided").
**Status:** proposal, not approved; nothing built. "RFW" read as RFQ (request for quote); the same flow serves an RFP.

**Answer first:** today neither side of an RFQ exists as a process. As a **buyer**, a purchase request names one supplier per line and goes to approval, then becomes a purchase order; there is no way to send one request to several suppliers, collect their prices, compare them side by side and award. As a **supplier**, we can write, number, revise, send, win or lose a **quote** with an expiry date and an approval step, and track the opportunity, but a customer's incoming RFQ is not a record: no due date, no bid or no-bid, no owner, no clock. Most of the timing measures you list **are** reported (receivables and payables aging, days sales outstanding, promises to pay, late purchase orders, supplier on-time delivery, quotes awaiting a decision, orders late to ship); what is missing is the *deadline* side (quotes and RFQ responses due) and the *delayed payment behavior* side (how late each customer or supplier actually pays). Both sides plus the missing measures are about **4 weeks**.

## What exists
| Need | Today |
|---|---|
| Buying: request, approval, order | Purchase requests with amount, department and capex rules, delegation, re-approval on change; purchase orders; receiving; invoice matching |
| Supplier prices | Price lists per supplier and part (supplier prices import) |
| Selling: quote | Quotes with number, revision, valid-until date, approval reasons, send, accept or decline with reason; becomes a sales order |
| Pipeline | Opportunities by stage with expected close; win rate |
| Aging and delay | AR aging with days sales outstanding and promises to pay; AP aging with due this week; purchasing status with late orders and supplier on-time delivery; orders late to ship; supplier scorecards |
| Deadlines | Approval and review due dates (documents, specification reviews, readings) |

## Gaps and proposal
### A. Buying RFQ ("sourcing")
Create from a purchase request, or from scratch: lines, quantities, needed-by date and a **response deadline**; choose suppliers (from the supplier list, tagged by trade/part); send (email once connected, otherwise a link/PDF to send yourself); record each supplier's response per line (price, lead time, minimum, validity, notes, attachment); a **comparison grid** with total landed cost and lead time, lowest and preferred flagged; **award** by line or whole, which creates the purchase request/order at the awarded price and keeps the losing bids as the record of why. Overdue responses and awards nearing the needed-by date are flagged.
### B. Selling RFQ (customer requests to us)
An **inbound RFQ** record: customer, their number, received on, **response due**, scope, attachments (customer drawings and specs land in the document server as external documents with the impact review that already exists), owner/estimator, bid or no-bid with reason, status; **response = a quote** created from it (reusing quote lines, revisions and approval); win/loss closes the loop to the opportunity. A due-date board: due today, this week, overdue; response time measured from receipt.
### C. Timing measures (missing ones)
1. **Quotes and RFQs due**: due soon, overdue, response time (receipt to sent), quote age and expiring quotes, quote-to-order conversion by age.
2. **Delayed payment**: per customer, average and worst days beyond terms, trend, share paid late; per supplier, how late *we* pay, and any early-payment discount missed.
3. **Aging of purchase orders**: open lines by days past promise date and by age since order, by supplier.
4. **Work deadlines**: work orders and production orders due, overdue, due this week (partly present); per-owner deadline load.
5. One page, **"What is late"**, listing everything with a date that has passed across quotes, RFQs, purchase orders, invoices, bills, work, reviews and readings, grouped by owner.

## (c) Reuse, (d) cost, (e) packaging
Reuses purchase requests and orders, suppliers and price lists, quotes, opportunities, documents (external type and impact review), approvals, reminders, notifications, reports and the table tools. **New tables:** `rfq`, `rfq_line`, `rfq_invite`, `rfq_response_line`, `inbound_rfq`. **Build:** A about 1.5 weeks, B about 1.5, C about 1 week. **Ongoing:** low to moderate. **Packaging:** A in Standard with purchasing; B with sales; C everywhere the data exists.
## (f) Native versus integration
Native. Sending uses outbound email, which needs the sending domain (O-2); until then each RFQ has a printable page and a link. No supplier portal is proposed: suppliers answer by email or the buyer keys their reply (a portal is a later decision).
## (g) Tests
Several suppliers, partial responses, award splitting lines, awarding creates a request that goes through approval, a deadline passing raises reminders and the late list, incoming RFQ to quote to order, delayed-payment figures against known invoices and payments, isolation between companies, and the two-year dataset.

## Questions
1. Approve A, B and C? (C alone is about a week and needs no new workflow.)
2. Do your target customers receive RFQs as emails with attachments (most likely), through customer portals, or both? Portals cannot be automated without a named customer's system.
3. For the buyer side: do prospects compare quotes mainly on price, or on landed cost and lead time too? (The grid supports both; the default sort changes.)
