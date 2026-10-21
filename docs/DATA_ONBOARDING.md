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
| 1 | `employees` | employee directory | legacy ID, employee number | "Last, First" or "First Last" full names are split automatically. Do not import pay data |
| 2 | `assets` | assets, components, locations | legacy ID, asset tag | `location_path` like `Bldg 2 > Line 3` creates locations. Parents may appear after their components in the file |
| 3 | `parts` | part master | legacy ID, part number | Units normalized (`pcs`→`EA`, `kit`→`SET`). Unknown units are kept with a warning |
| 3b | `stock_balances` | on-hand per part and storeroom, bin, reorder point/quantity | part number + storeroom code | Parts and storerooms must exist first. Each row **sets** on-hand: the difference to the current balance is posted to the stock ledger as an opening movement, so re-importing the same file changes nothing. A file without a storeroom column uses a constant in the profile. Committing needs `inventory.manage` |
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
| `06_training_matrix.xlsx` | HR matrix: one column per qualification, Excel dates, bare "X" marks, "n/a", a contractor not on payroll | Profile `training-matrix.json`: unpivot plus a header → code value map. "X" imports with a warning; the contractor row is rejected |

`npm run seed` loads all six files this way (the storeroom export twice) and prints what each import did.

## Adding a new target or field

Add a `TargetDefinition` in `src/modules/imports/targets/` with fields, synonyms, a natural key, `validate()` and `commitRow()`. `commitRow()` must call the module's domain service rather than writing tables directly. Register it in `targets/registry.ts`. Add synonyms whenever a real customer file teaches a new header spelling. That improves auto-mapping for every later customer.
