# SC-004 Fit interview, gentle suggestions, source-system presets, table tools and working styles

**Requested by:** founder, 2026-10-23 (six asks in one message; each answered below).
**Status:** proposal, not approved, except item D (table sorting, filtering and search), which the founder asked to be implemented liberally and which changes no data or rules.

**Answer first:** all of this is feasible on what exists. A **fit interview** (plain questions about what the business does) is the right way to decide which features a company should switch on or buy, and the same answers power **gentle suggestions** later, backed by what the company actually does in the product. Suggestions are rules over usage, shown rarely and never in the way. **Source-system presets** for major products can only be as good as the export layouts we can verify from the vendors' own documentation, so each preset states how it was verified. **Working-style options** should come from how individuals prefer to work, not from gender.

## A. Fit interview (feature selection)
- **Who:** a new customer's administrator, or us on a call. 15 to 25 plain questions, branching: what the business makes or does; sites and headcount; whether it maintains its own equipment, makes product, sells to customers, buys and receives goods, services other people's equipment, runs stores or restaurants, rents space; what it must prove to auditors or customers (ISO 9001, IATF, food safety, OSHA); what it uses today for books, payroll, maintenance, quality.
- **Result:** a recommended set of features (which of the 38 visible features to show), the implementation plan depth, which imports apply, and what is *not* a fit yet, in plain words. Re-takeable; an administrator edits the answers.
- **Reuse:** feature visibility by role (D-149), implementation plan (D-175), edition and entitlements. **New:** an interview definition in code (questions, branches, rules), answers stored per company, a results page.
- **Cost:** about 2 weeks for the engine and a first interview covering manufacturing, maintenance, property, retail and food service. Ongoing: low; questions and rules are versioned code.
- **Packaging:** part of onboarding in every edition.

## B. Gentle suggestions ("worth a look")
- **What:** a small, dismissible card on the administrator's home, at most one a week per person, never a modal, never blocking, never showing a price. Each says what was noticed and what the feature would do, with "Show me" and "Not now". Examples: *storeroom parts are issued often with no reorder points set → reorder settings; invoices are created by hand every week → recurring invoices; PM work orders are completed late → PM compliance report; many customer complaints are logged as plain nonconformances → CAPA/8D.*
- **How it knows:** counts over the company's own records (no outside data, nothing leaves the system), compared with thresholds in a rule table. Suggestions for a feature the company has not licensed point to "talk to us", written by us, not by the product.
- **Safeguards:** off switch per company and per person, a log of what was shown, no suggestion about a feature just dismissed for 90 days.
- **Cost:** about 1.5 weeks for the engine and 12 starter rules. Ongoing: each rule is a few lines; they need review when features change.

## C. Source-system presets (data import)
- **What:** for each major product, a saved mapping and a short guide to the export that feeds it, so the usual file loads without matching columns. Candidate list, by likelihood in the target customers: accounting (QuickBooks Online and Desktop, Xero, Sage), payroll (ADP, Paychex, Gusto), maintenance (UpKeep, Fiix, MaintainX, eMaint, Limble), ERP/MRP for small manufacturers (Fishbowl, Epicor, Infor, JobBOSS, ProShop), CRM (HubSpot, Salesforce, Zoho), banks' own statement CSVs, spreadsheets as most customers really have them.
- **Rule:** I do not invent report names or column headings. Each preset is built from the vendor's published help pages for that export or a real sample file, and is labelled **checked against vendor documentation**, **checked against a real file**, or **generic**. Where neither exists, the generic importer and the saved-mapping step stay the route.
- **Cost:** about 0.5 week for the preset mechanism; then about one day per product, mostly research. Ongoing: moderate (vendors change exports). Ask for sample files from first customers; each real file upgrades a preset.

## D. Table sorting, filtering and search (building now)
Every list table gets: click a column heading to sort (keyboard and screen-reader friendly), a column filter row on demand, and a quick search above the table, applied to the rows already loaded; where a list is fetched in pages the table says how many it is showing and the existing server filters stay. One shared component, so it reaches every page at once, with tests.

## E. Working styles (not gender)
There is no solid evidence that women and men as groups prefer different ways of working with data; the differences between individuals are far larger than any difference between groups, and a feature that assumes otherwise would be wrong for most people. What *is* well supported is that people vary in how they take in information and how they like to collaborate. Options worth offering, set per person under "How I like to work", none of them labelled by gender or any other group:
1. **Show it as** picture first, table first, or sentence first (already "answer first"; the choice makes it a setting).
2. **Density**: roomy, normal, compact. **Text size** and contrast, color-blind-safe palette, reduced motion.
3. **Explain it**: a "how was this worked out?" panel on every calculated number, off or on by default.
4. **Guided or expert**: step-by-step with checks and confirmations, or keyboard-first shortcuts.
5. **Interruptions**: notifications immediately, in a daily digest, or only when asked; quiet hours.
6. **Working with others**: comments and mentions on records, a shared-with-me view, "ask a colleague" before sending an approval, visible hand-offs.
7. **Pace**: save drafts automatically (exists), undo for recent changes, a preview of what a change will do before it happens.
8. **Language level**: plain wording versus technical terms (e.g. "stock level to reorder at" versus "reorder point").
We should also **ask**: the fit interview and early customer visits should include women (and others) who do maintenance, quality, purchasing and finance work, and ask what slows them down. That is a better source of options than any assumption of mine.
- **Cost:** settings storage and the first four options about 1.5 weeks; collaboration features (comments, mentions) about 2 weeks and are the largest piece.

## F. Marketing interview
Deferred by the founder until all build activity is complete and every feature is stress-tested. The question list is drafted (see docs/OWNER_REGISTER.md O-19) but the interview is not held until then.

## Questions
1. Approve A and B (fit interview and suggestions) as the next slice after field service and planner work? (Blocking for A and B only.)
2. For C: which three or four source products do your first prospects actually use? That orders the research.
3. For E: should "How I like to work" start with options 1 to 5, with 6 (collaboration) as its own slice?
