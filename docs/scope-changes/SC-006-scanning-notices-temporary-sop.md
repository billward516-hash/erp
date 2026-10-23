# SC-006 Tablet and barcode inventory; change notices; temporary SOP changes with timers

**Requested by:** founder, 2026-10-23 ("I want inventory management to be able to leverage a tablet and bar code for receiving and issuing stock as well as for cycle counts. In MOC I want engineering change notices (and other similar notifications) and temporary SOP change features to be included for proper notification tracking. For temp changes I want expiration timers and alerts").
**Status:** built (A scan station, B change notices, C temporary SOP changes). Approved by the standing instruction to build queued work without waiting; the assumptions below are recorded as decisions and can be changed.

**Answer first:** receiving, issuing and cycle counting exist but are typed screens: there is no barcode identity for parts, locations or lots, no scan station, no labels and no count schedule. Change management (MOC) already has "temporary until" on a change with a reminder, but no notice tracking and no temporary change to a procedure that readers see. This adds three things: a **scan station** for a tablet (any USB or Bluetooth scanner, or the tablet camera where the browser supports it), **change notices** (ECN and similar) with a tracked distribution and acknowledgement list, and **temporary SOP changes** with a start, an expiry timer, alerts and a forced decision at expiry.

## (a) Workflow
1. **Scan station** (tablet, large touch targets): Receive (scan PO, then parts, quantity, lot and expiry when tracked), Issue (scan work order or a reference, then parts), Count (scan the shelf location, then each part, enter the quantity; blind by default so the count is not nudged by the expected quantity), Look up (scan anything, see what it is and where stock is). A beep and a colour confirm each scan; a wrong scan is refused with the reason.
2. **Labels:** printable Code 128 labels for parts, locations and lots (PDF sheets). A part may also carry its supplier's UPC/EAN and carton codes mapped to it with a quantity per scan.
3. **Cycle counts:** counts due by how often each part at a location should be counted; one tap opens the count sheet for what is due.
4. **Change notices:** a notice (ECN, product change, supplier change, deviation or waiver, other) is raised from a change or on its own, lists what changed and the recipients (internal users, customers, suppliers), and tracks sent, acknowledged and overdue per recipient.
5. **Temporary SOP change:** a procedure is changed for a stated period; it needs approval, shows as a banner to anyone reading that procedure (including the in-app work instruction), counts down, alerts the owner at 14, 7, 3 and 1 days and daily after, and at expiry must be **reverted, extended (with a reason and approval) or made permanent** (which opens a normal change).

## (b) Value
Fewer receiving and issue errors and faster counts; counts that are not biased; a record of who was told about a change and who has not answered; temporary procedure changes that cannot silently become permanent.

## (c) Reused
Inventory ledger and counts, lots, purchase orders and receiving, work orders and part issue, documents and work instructions, approvals, MOC, reminders catalogue and daily job, What is late, attachments, audit.

## (d) New
Part barcodes; scan resolution; label PDFs; scan station pages; count frequency and counts-due list; blind counts; change notice with recipients and acknowledgements; temporary procedure change with timers and a banner on the document.

## (e) Native vs integration
Native. Scanners that act as a keyboard need nothing. Camera scanning uses the browser's own barcode detector where present and falls back to typing. Not included: GS1 application-identifier parsing beyond plain codes, RFID, offline scanning (the station needs the connection; the technician app's offline queue is not reused yet), email delivery of notices (the notice is a PDF to attach to the sender's own email; internal recipients get an in-app notification).

## (f) Assumptions recorded as decisions (change on request)
- Count frequency is set per part at a location in days, default none; blind counting is the default for scan counts.
- Temporary SOP changes default to a 90-day ceiling (Documents settings, 1 to 365 days) for the whole period and for each extension; extension needs approval each time.
- Acknowledgement by external recipients is recorded by an internal user ("customer confirmed by email on …"), because no portal exists.

## (g) Tests
Scan resolution of each code kind and refusal of unknown codes; receive by scan posts the same ledger entries as typing; blind count hides expected; counts-due honours frequency; notice tracks sent and acknowledged and flags overdue; temporary change needs approval, banner appears on the document and instruction, alerts fire once per milestone, expiry blocks silent continuation, extension and make-permanent paths; isolation between companies.
