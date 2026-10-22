# Customer data onboarding

How a prospect's existing data gets into the platform, whatever shape it is in, without custom code.

## Supported inputs

| Format | Handled automatically | Options you can set |
|---|---|---|
| CSV / TSV / pipe-delimited | delimiter sniffing; UTF-8, UTF-16 (BOM) and Windows-1252 decoding; quoted fields; blank lines; title rows above the header | `delimiter`, `encoding`, `headerRow` |
| Excel `.xlsx` | picks the largest sheet (warns if there are several); formula results; rich text; date cells; banner rows | `sheet` (name or number), `headerRow` |
| JSON | an array of records, or an object wrapping one (`{"records": [...]}`); nested objects become `parent.child` columns; arrays of values are joined with `; ` | — |

Legacy `.xls` files are rejected with a "save as .xlsx or .csv" message.

## Workflow

1. **Suggest** (`POST /api/imports/suggest`). Returns the detected file structure plus a proposed mapping with a confidence level per column, required fields that are still unmapped, columns that will be preserved as custom fields, and code values that need a decision (e.g. `Critical? = Yes/No`).
2. **Stage** (`POST /api/imports/stage`). Runs the full pipeline as a **dry run**: every row is parsed, mapped, type-checked and validated against existing data (duplicates, unknown parents or assets, facility access, overlapping downtime). Nothing is written to operational tables. The response contains totals, rows to create or update, a preview, every problem, and warnings about assumptions made (e.g. ambiguous date order).
3. **Fix and repeat**. Either adjust the mapping, or download `GET /api/imports/:id/problems.csv`, which has the failing rows with their original values and the reason for each. The customer fixes their own spreadsheet and re-stages it.
4. **Commit** (`POST /api/imports/:id/commit`). Re-validates against current data and writes through the normal domain services, so audit, permissions and business rules apply. By default any error blocks the whole batch. `{"allowPartial": true}` imports the good rows and reports the rest.
5. **Save the mapping** (`POST /api/import-profiles`) so the next export from the same system imports with no re-mapping.

Re-importing is safe. Records are matched by legacy ID (`external_id`, per source system) or by natural key (asset tag, part number, employee number), so a re-import updates instead of duplicating. Blank cells never erase existing values, and legacy work-order history is never overwritten.

## Targets and recommended load order

| Order | Target key | Creates/updates | Matches existing by | Notes |
|---|---|---|---|---|
| 0 | `sites` | properties, stores, plants, warehouses; their portfolio / region / district | site code | Property directories and store lists: `Property Type` words (residential, multi-family, retail center, store, warehouse…) map to the kind; a `Portfolio`/`Region`/`District` column creates the group and adds the site to it (never removes). No kind → property, with a warning. Committing needs `tenant.admin` |
| 1 | `employees` | employee directory | legacy ID, employee number | "Last, First" or "First Last" full names are split automatically. Do not import pay data |
| 2 | `assets` | assets, components, locations, **spaces** (units, suites, common areas) | legacy ID, asset tag | `location_path` like `Bldg 2 > Line 3` creates locations. Parents may appear after their components in the file. Class words `unit`, `apartment`, `suite`, `room`, `common area`, `sales floor` → space. Property and store columns (`Property`, `Store #`) find the site |
| 3 | `parts` | part master | legacy ID, part number | Units normalized (`pcs`→`EA`, `kit`→`SET`). Unknown units are kept with a warning |
| 3b | `stock_balances` | on-hand per part and storeroom, bin, reorder point/quantity | part number + storeroom code | Parts and storerooms must exist first. Each row **sets** on-hand: the difference to the current balance is posted to the stock ledger as an opening movement, so re-importing the same file changes nothing. A file without a storeroom column uses a constant in the profile. Committing needs `inventory.manage` |
| 3c | `suppliers` | vendor master, contractor trades and certificate of insurance | legacy ID, supplier code | Contact, email (malformed emails dropped with a warning), terms, active flag, `Trade` (semicolon list) and `COI Exp`. Do not import bank or tax details: use a profile with `unmappedColumns: "ignore"` when the export carries them |
| 3d | `supplier_prices` | price list per supplier and part | supplier code + part number | Price, lead time, supplier part number, preferred flag. A blank preferred cell leaves the existing flag alone. Committing needs `purchasing.manage` |
| 3e | `customers` | customer/prospect accounts, primary contact per row | legacy ID, customer code | Lifecycle words map to prospect/customer. A row's contact becomes (or updates) the primary contact. Committing needs `crm.manage` |
| 3e1 | `rental_units` | leasing details of spaces | unit asset tag | Unit types (`apartment`, `townhome` → residential; `retail suite`, `office` → commercial; storage, parking). `Bd/Ba` like `2/1` split with two `split` transforms. Spaces must be loaded as assets first. Committing needs `leasing.manage` |
| 3e1b | `leases` | leases in force (rent roll), renters as customers | legacy lease ID, or unit + start date | Leases are signed on import; a move-out date puts them on notice. Renters are matched by name and email, else created. Balances owed are not imported (they stay in the old system or accounting). Re-importing the same file changes nothing |
| 3e2 | `asset_parts` | equipment parts lists (spares per machine) | asset tag + part | Parts are matched by our part number or, when the list only carries the OEM's number, by manufacturer part number (a warning says so). Inactive (superseded) parts are rejected. Critical flags read Y/N/X and similar. Committing needs `assets.manage` |
| 3f | `boms` | component lines on each manufactured part's **draft** revision | parent part + component part | Flat exports (parent on every row) or indented ones (a level column such as `0`, `.1`, `..2` or outline `1.2.1`; the parent is the nearest row above at the level before). Each parent gets a draft revision (a copy of the released one, if any); lines are added or updated, never removed. Nothing reaches production until a person adds the routing and releases. A unit that differs from the part's stocking unit is rejected rather than guessed. Committing needs `production.manage` |
| 3g | `condition_points` | what is logged on which equipment, with limits and interval | asset tag + measure | Min/Max/Log-every columns from an equipment list; rows without limits are rejected (nothing to log). Committing needs `assets.manage` |
| 3h | `condition_readings` | temperature (or other) log entries | — | Paper logs typed into a sheet or a form export, one row per reading, in store-local time. Applied in file order through the same path as in-app readings: out-of-limit rows open an excursion and a request (warned at staging). Committing needs `assets.record_state` |
| 4 | `work_order_history` | closed or open legacy work orders | legacy WO number | Technicians are matched by employee number or exact name. If no match, the name and hours are kept on the record and labor is not attached |
| 5 | `asset_downtime` | historical state intervals | — | Needs start plus end or duration. Overlaps are rejected. Unknown reason codes are kept in the note |
| 6 | `qualification_records` | legacy qualification grants | employee + qualification + completion date | Qualifications must be defined first. Committing needs `qualifications.grant`, since the importer vouches the records were authorized. Rows are marked as legacy, and reports say their evidence lives in the source system. A bare "X" with no date imports with a warning and validity counted from today |

`GET /api/imports/targets` lists every field with its type, allowed values and example header names.

## Mapping reference

```jsonc
{
  "fields": {
    "asset_tag":        { "source": "Equip #", "transforms": [{ "op": "trim" }, { "op": "upper" }] },
    "location_path":    { "template": "{Bldg} > {Line/Area}" },
    "criticality":      { "source": "Critical?", "valueMap": { "Yes": "high", "No": "low" } },
    "labor_hours":      { "source": "laborMinutes", "transforms": [{ "op": "multiply", "factor": 0.0166667 }] },
    "commissioned_on":  { "source": "Install", "dateFormats": ["DD.MM.YYYY"] },
    "facility_code":    { "constant": "DAY" },
    "name":             { "source": ["Asset Name", "Description"] }   // first non-blank wins
  },
  "options": {
    "unmappedColumns": "custom_fields",   // or "ignore"
    "dateOrder": "MDY",                   // or "DMY" — tie-breaker for ambiguous columns only
    "decimal": "auto",                    // "." | "," | "auto"
    "skipBlankRows": true,
    "mode": "upsert",                     // "create_only" | "update_only"
    "unpivot": {                         // optional: wide sheets, one column per item
      "allExcept": ["Emp #", "Name"],     // or "columns": [...] to list the value columns
      "nameColumn": "Qualification",       // header text of each filled cell lands here
      "valueColumn": "Completed"          // the cell value lands here
    }
  }
}
```

**Wide sheets.** A training matrix, or a sheet with one column per month, is turned into one record per filled cell with `unpivot`. Blank, `N/A` and `TBD` cells are skipped. Problems are reported by source row and column (`Source column` in the problems CSV), so the customer can find the exact cell.

**Transforms**, applied in order: `trim`, `upper`, `lower`, `title`, `collapse_whitespace`, `replace {pattern, with, flags}`, `regex_extract {pattern, group}`, `split {separator, index}`, `prefix`, `suffix`, `null_if {values}`, `default {value}`, `multiply {factor}`.

**Values the coercion layer already understands:**
- **Numbers:** `$1,234.50`, `1.234,50`, `12,5`, `(12.00)`, `15-`, `45%`, `USD 99`.
- **Blanks:** `N/A`, `-`, `TBD` and `unknown` are treated as blank.
- **Dates:** ISO, `M/D/YYYY`, `D/M/YYYY`, `MM/DD/YY`, `D.M.YYYY`, `4-Mar-2026`, `Mar 4, 2026`, `20260304`, Excel serial numbers and Excel date cells.
  - Date order is decided per column. One value such as `25/04/2026` settles a column as day-first.
  - A column where every value fits both orders produces a warning stating the assumption.
- **Timestamps:** values without a UTC offset are read in the time zone of that row's facility, including daylight-saving changes.
- **Booleans:** `Y/N`, `yes/no`, `x`, `1/0`, `active/inactive`, plus per-field synonyms such as `Obsolete` → inactive.
- **Codes:** synonym tables cover common conventions, e.g. criticality `A/B/C`; work types `BD/CM/PM/INSP`; statuses `Closed/Complete/Void/WIP/On hold`; priorities `Emergency/High/P3`. Anything else goes through `valueMap`.

## Worked examples (in `samples/imports/ridgeline`)

| File | What is awkward about it | How it is handled |
|---|---|---|
| `01_payroll_employee_export.csv` | "Last, First" names, `A/T/LOA` status codes, `Hire Dt` | Fully auto-mapped |
| `02_equipment_register.xlsx` | Title banner and blank row above the header, second sheet, location split across two columns, `Crit (A/B/C)`, one date typed as text | Profile `equipment-register.json`: location template, `Type` → asset class with a value map |
| `03_storeroom_parts_export.csv` | Semicolons, Windows-1252 (`°`, `µ`, `–`), `$1,248.00`, units `each/pcs/pail/spool/kit`, `Obsolete` status, one price "call for price" | Auto-mapped as `parts`. The bad row is rejected with a reason. Committed with `allowPartial`. Loaded a second time as `stock_balances` with profile `storeroom-stock.json` (On Hand, Bin, and the storeroom code as a constant, since the export has no storeroom column) |
| `04_legacy_cmms_work_history.json` | Nested `equipment.tag`, labor in minutes, `BD/PM/INSP`, a contractor not in the employee list, a machine sold years ago | Profile `legacy-cmms-history.json`: minutes → hours. Unknown technician kept as reference. Unknown asset rejected |
| `05_downtime_tally.csv` | Date and times in separate columns, `Planned? Y/N`, a free-text reason | Profile `downtime-tally.json`: two templates and a value map. Unknown reason kept in the note |
| `07_accounting_vendor_list.csv` | Accounting export with a Tax ID column, one malformed email, an inactive vendor | Profile `accounting-vendors.json`: maps the useful columns and ignores the rest, so the tax ID is never stored |
| `08_supplier_price_list.xlsx` | Distributor quote: banner rows, `$1,195.00`, lead time as text (`21 days`, `stock`), and 'Your P/N' / 'Our Item #' written from the distributor's side, so auto-mapping would swap them | Profile `supplier-price-list.json`: explicit columns, `null_if` + `regex_extract` for lead time. A part we do not stock is rejected |
| `09_crm_company_export.csv` | CRM export with no customer code, address in four columns, contact on the row, a malformed email, a blank row | Profile `crm-company-export.json`: code built from the record ID (`C-{Record ID}`), address template, lifecycle stage mapped |
| `10_engineering_bom_indented.csv` | Legacy ERP indented BOM: dotted levels (`.1`, `..2`), a sub-assembly made in house, a sealant nobody set up as a part, a carton quantity in feet on a part stocked each | Auto-mapped (`Lvl`, `Item No.`, `Qty Per`, `U/M`, `Scrap %`). Two draft revisions result (housing and seal kit); the unknown part and the unit mismatch are rejected with reasons |
| `11_oem_spares_list.csv` | OEM recommended-spares spreadsheet: OEM part numbers with our item number only sometimes filled in, Y/N critical, a superseded air filter, a turret seal nobody has set up, a press at the other site | Auto-mapped. Three rows match by manufacturer number (with a warning); the superseded and unknown parts are rejected with reasons |
| `06_training_matrix.xlsx` | HR matrix: one column per qualification, Excel dates, bare "X" marks, "n/a", a contractor not on payroll | Profile `training-matrix.json`: unpivot plus a header → code value map. "X" imports with a warning; the contractor row is rejected |

### Landlord (in `samples/imports/harborview`)

| File | What is awkward about it | How it is handled |
|---|---|---|
| `01_property_directory.csv` | Property-management directory: `Property Type` in the system's own words (Residential, Multi-Family, Retail Center), portfolio as a column | Auto-mapped as `sites`; portfolios become groups |
| `02_unit_directory.csv` | Unit numbers repeat across properties (every building has a 101), `Bd/Ba` as `2/1`, `$1,150.00` rents, `Vacant-Unrented` statuses, a `COMMON` row per property | Profile `unit-directory.json`: tag `{Property}-{Unit}`, class constant `space`, building as the location, "Unit COMMON" renamed "Common areas". Beds/baths, size, rent and status kept as custom fields |
| `03_building_equipment.csv` | Equipment located "in" a unit number, types like Boiler/Elevator/Appliance | Profile `building-equipment.json`: parent built as `{Property}-{Located In}`, type → class value map |
| `02_unit_directory.csv` (second pass) | Same file as units | Profile `rental-units.json` as `rental_units`: `Bd/Ba` split into beds and baths, unit types mapped; the three common-area rows are rejected on purpose (not rentable) and the rest committed |
| `05_rent_roll.csv` | Rent roll export: `$1,125.00`, US dates, `Notice-Unrented` with a move-out date, a lease past its end date (holding over), company tenants (LLC, PC) | Profile `rent-roll.json`: tag template, company flag from the name with `regex_extract` + `replace` + `default` |
| `04_vendor_list.csv` | Vendor ID is the only code, trades `Plumbing; Drains`, certificate of insurance dates, one vendor with none | Profile `vendor-list.json`. The vendor without a certificate imports but cannot be dispatched until one is recorded |

### Retail (in `samples/imports/northwind-market`)

| File | What is awkward about it | How it is handled |
|---|---|---|
| `01_store_list.csv` | Store numbers only (`101`), formats (Grocery, Express) that are not site kinds, districts as a column, `Open/Closed` | Profile `store-list.json`: code `S{Store #}`, kind constant `store`, district → group |
| `02_store_equipment.csv` (twice) | Equipment IDs repeat in every store (`WIC-1`), temperature limits in the same sheet, blank for HVAC and doors | Profile `store-equipment.json` (tags `S{Store #}-{Equip ID}`), then `store-temperature-limits.json` as `condition_points` (rows without limits rejected on purpose) |
| `03_contractors.csv` | Vendor # as the only code, trades, COI dates | Profile `contractors.json` |
| temperature form export (generated by the seed with recent dates) | Date and time in separate columns, store-local time, equipment ID without the store, initials, corrective action | Profile `temp-log-form.json`: two templates. Out-of-limit rows warn at staging and raise requests when committed |

`npm run seed` loads all nine files this way (the storeroom export twice) and prints what each import did.

## Adding a new target or field

Add a `TargetDefinition` in `src/modules/imports/targets/` with fields, synonyms, a natural key, `validate()` and `commitRow()`. `commitRow()` must call the module's domain service rather than writing tables directly. Register it in `targets/registry.ts`. Add synonyms whenever a real customer file teaches a new header spelling. That improves auto-mapping for every later customer.
