import { readFile } from 'node:fs/promises';
import ExcelJS from 'exceljs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { asActor } from '../src/platform/auth/actor.js';
import { closePools } from '../src/platform/db/pool.js';
import { many, one } from '../src/platform/db/tx.js';
import { commitImport, errorReportRows, getBatch, stageImport } from '../src/modules/imports/service.js';
import { createQualification, qualificationStatus } from '../src/modules/learning/qualifications.js';
import type { World } from './fixtures.js';
import { makeWorld } from './fixtures.js';

let w: World;
const csv = (s: string) => Buffer.from(s.replace(/\n/g, '\r\n'));

beforeAll(async () => { w = await makeWorld('imp'); });
afterAll(closePools);

describe('import pipeline', () => {
  it('stages without touching operational tables, then commits idempotently', async () => {
    const file = csv('Equip #,Description,Site,Bldg,Line,Crit,Install Dt,Mfr,Coolant\nM-1,Mill one,A,Bldg 1,Cell 1,A,03/15/2019,Haas,Synthetic\nM-2,Mill two,B,,,c,15/03/2019,Haas,\n');
    const staged = await stageImport(w.admin, { target: 'assets', sourceSystem: 'sheet', fileName: 'eq.csv', content: file });
    // Install Dt mixes 03/15 and 15/03 -> one of them must fail rather than be silently swapped.
    expect(staged.stats).toMatchObject({ total: 2, errors: 1, toCreate: 1 });
    expect(staged.problems[0]).toMatchObject({ rowNumber: 3, messages: [expect.objectContaining({ field: 'commissioned_on' })] });
    expect(await asActor(w.admin, (tx) => many(tx, 'SELECT 1 FROM asset'))).toHaveLength(0);

    await expect(commitImport(w.admin, staged.batchId)).rejects.toThrow(/1 row\(s\) have errors/);
    const r = await commitImport(w.admin, staged.batchId, { allowPartial: true });
    expect(r.stats).toMatchObject({ created: 1, failed: 1 });
    const m1 = await asActor(w.admin, (tx) => one(tx, `SELECT a.*, l.name AS loc FROM asset a LEFT JOIN functional_location l ON l.id = a.location_id WHERE asset_tag = 'M-1'`));
    expect(m1).toMatchObject({ name: 'Mill one', criticality: 'high', commissioned_on: '2019-03-15', manufacturer: 'Haas', loc: 'Bldg 1', custom_fields: { line: 'Cell 1', coolant: 'Synthetic' } });

    // Same file again: matches existing record instead of duplicating; committed batches are frozen.
    await expect(commitImport(w.admin, staged.batchId)).rejects.toThrow(/committed/);
    const again = await stageImport(w.admin, { target: 'assets', sourceSystem: 'sheet', fileName: 'eq.csv', content: file });
    expect(again.warnings.join(' ')).toMatch(/already committed/);
    expect(again.preview[0]).toMatchObject({ action: 'update' });
  });

  it('applies an explicit mapping with templates, value maps and unit conversion', async () => {
    await asActor(w.admin, (tx) => tx.query(`INSERT INTO asset (tenant_id, facility_id, asset_tag, name) VALUES ($1, $2, 'PUMP-9', 'Pump')`, [w.tenantId, w.facilities.A]));
    const file = csv('Ticket,Unit,What,Kind,Opened,Closed,Mins,Who\nT-1,pump-9,Seal leak,BD,2026-03-02 09:20,2026-03-02 12:00,150,Priya Shah\nT-2,PUMP-9,Quarterly,PM,2026-03-05 08:00,2026-03-05 09:00,60,Unknown Person\n');
    const mapping = {
      fields: {
        external_id: { source: 'Ticket' }, asset_tag: { source: 'Unit', transforms: [{ op: 'upper' }] }, title: { source: 'What' },
        wo_type: { source: 'Kind' }, reported_at: { source: 'Opened' }, completed_at: { source: 'Closed' },
        labor_hours: { source: 'Mins', transforms: [{ op: 'multiply', factor: 1 / 60 }] }, technician: { source: 'Who' },
      },
    };
    const staged = await stageImport(w.admin, { target: 'work_order_history', sourceSystem: 'old-cmms', fileName: 'h.csv', content: file, mapping, facilityId: w.facilities.A });
    expect(staged.stats).toMatchObject({ valid: 1, warnings: 1, errors: 0 });
    await commitImport(w.admin, staged.batchId);
    const rows = await asActor(w.admin, (tx) => many(tx, `SELECT w.legacy_number, w.wo_type, w.status, w.created_at, w.custom_fields,
      (SELECT sum(hours) FROM work_order_labor l WHERE l.work_order_id = w.id) AS hours FROM work_order w WHERE origin = 'import' ORDER BY legacy_number`));
    expect(rows[0]).toMatchObject({ legacy_number: 'T-1', wo_type: 'corrective', status: 'closed', hours: 2.5 });
    expect(rows[0].created_at.toISOString()).toBe('2026-03-02T14:20:00.000Z'); // Plant A is America/New_York
    expect(rows[1]).toMatchObject({ legacy_number: 'T-2', wo_type: 'preventive', hours: null, custom_fields: { legacy_technician: 'Unknown Person', legacy_labor_hours: 1 } });

    // Re-importing history never duplicates or overwrites.
    const again = await stageImport(w.admin, { target: 'work_order_history', sourceSystem: 'old-cmms', fileName: 'h.csv', content: file, mapping, facilityId: w.facilities.A });
    const r = await commitImport(w.admin, again.batchId);
    expect(r.stats).toMatchObject({ created: 0, unchanged: 2 });
  });

  it('reads Excel workbooks with banner rows and real date cells', async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Parts');
    ws.addRow(['Storeroom list']);
    ws.addRow(['Part No', 'Item Description', 'UOM', 'Unit Price', 'Status']);
    ws.addRow(['BRG-1', 'Bearing', 'each', 12.5, 'Active']);
    ws.addRow(['BRG-2', 'Bearing 2', 'Box', '$1,020.00', 'Obsolete']);
    const content = Buffer.from(await wb.xlsx.writeBuffer());
    const staged = await stageImport(w.admin, { target: 'parts', sourceSystem: 'xlsx', fileName: 'parts.xlsx', content });
    expect(staged.parseInfo).toMatchObject({ format: 'xlsx', headerRow: 2, sheet: 'Parts' });
    expect(staged.stats).toMatchObject({ valid: 2, errors: 0 });
    await commitImport(w.admin, staged.batchId);
    const parts = await asActor(w.admin, (tx) => many(tx, 'SELECT part_number, uom, unit_cost, active FROM part ORDER BY part_number'));
    expect(parts).toEqual([
      { part_number: 'BRG-1', uom: 'EA', unit_cost: 12.5, active: true },
      { part_number: 'BRG-2', uom: 'BX', unit_cost: 1020, active: false },
    ]);
  });

  it('builds component hierarchies regardless of row order and rejects unknown parents', async () => {
    const file = csv('Tag,Name,Parent,Site\nGB-1,Gearbox,LINE-1,A\nLINE-1,Line 1 conveyor,,A\nX-1,Orphan,NOPE,A\n');
    const staged = await stageImport(w.admin, { target: 'assets', sourceSystem: 'h', fileName: 'h.csv', content: file });
    expect(staged.problems).toEqual([{ rowNumber: 4, messages: [expect.objectContaining({ field: 'parent_asset_tag' })] }]);
    await commitImport(w.admin, staged.batchId, { allowPartial: true });
    const gb = await asActor(w.admin, (tx) => one(tx, `SELECT c.asset_class, p.asset_tag AS parent FROM asset c JOIN asset p ON p.id = c.parent_asset_id WHERE c.asset_tag = 'GB-1'`));
    expect(gb).toEqual({ asset_class: 'component', parent: 'LINE-1' });
  });

  it('detects duplicates within a file and downtime overlaps', async () => {
    const dup = await stageImport(w.admin, { target: 'parts', sourceSystem: 'p', fileName: 'p.csv', content: csv('Part Number,Description\nZ-1,a\nz-1,b\n') });
    expect(dup.problems[0]!.messages[0]!.message).toMatch(/duplicate part number "z-1" \(first seen on row 2\)/);

    const down = csv('Machine,Start,End,Reason\nPUMP-9,2026-01-05 08:00,2026-01-05 10:00,MECH\nPUMP-9,2026-01-05 09:30,2026-01-05 11:00,MECH\n');
    const staged = await stageImport(w.admin, { target: 'asset_downtime', sourceSystem: 'tally', fileName: 'd.csv', content: down, facilityId: w.facilities.A });
    expect(staged.problems).toEqual([{ rowNumber: 3, messages: [expect.objectContaining({ message: 'overlaps row 2 for the same asset' })] }]);
  });

  it('produces a problems file with original values for the customer to fix', async () => {
    const staged = await stageImport(w.admin, { target: 'parts', sourceSystem: 'p2', fileName: 'stock.csv', content: csv('Part Number,Description,Cost\nQ-1,,5\nQ-2,ok,lots\n') });
    const report = await errorReportRows(w.admin, staged.batchId);
    expect(report.fileName).toBe('stock-problems.csv');
    expect(report.rows.map((r: any) => [r['Source row'], r.Cost])).toEqual([[2, '5'], [3, 'lots']]);
    expect(report.rows[1].Problems).toMatch(/ERROR \[unit_cost\]: "lots" is not a number/);
  });

  it('enforces permissions and facility scope at stage and commit', async () => {
    await expect(stageImport(w.techA, { target: 'parts', sourceSystem: 'p', fileName: 'p.csv', content: csv('Part Number,Description\nT-1,a\n') })).rejects.toThrow(/imports.run/);
    // Manager at A cannot load assets into B.
    const staged = await stageImport(w.managerA, { target: 'assets', sourceSystem: 's', fileName: 'b.csv', content: csv('Tag,Name,Site\nB-9,b,B\n') });
    expect(staged.problems[0]!.messages[0]!.message).toMatch(/unknown facility "B"/);
    // Another tenant cannot see or commit the batch.
    const other = await makeWorld('imp-other');
    await expect(getBatch(other.admin, staged.batchId)).rejects.toThrow(/not found/);
    await expect(commitImport(other.admin, staged.batchId)).rejects.toThrow(/not found/);
  });

  it('loads every bundled sample file end to end', async () => {
    const world = await makeWorld('samples');
    // Sample files reference DAY/FTW facility codes; rename the test facilities to match.
    await asActor(world.admin, async (tx) => {
      await tx.query(`UPDATE facility SET code = 'DAY' WHERE id = $1`, [world.facilities.A]);
      await tx.query(`UPDATE facility SET code = 'FTW' WHERE id = $1`, [world.facilities.B]);
    });
    const load = async (file: string, target: string, profile?: string, allowPartial = false) => {
      const p = profile ? JSON.parse(await readFile(`samples/imports/ridgeline/profiles/${profile}`, 'utf8')) : undefined;
      const s = await stageImport(world.admin, { target, sourceSystem: p?.sourceSystem ?? target, fileName: file, content: await readFile(`samples/imports/ridgeline/${file}`), mapping: p?.mapping, facilityId: world.facilities.A });
      return (await commitImport(world.admin, s.batchId, { allowPartial })).stats;
    };
    expect(await load('01_payroll_employee_export.csv', 'employees')).toMatchObject({ created: 9, failed: 0 });
    expect(await load('02_equipment_register.xlsx', 'assets', 'equipment-register.json')).toMatchObject({ created: 14, failed: 0 });
    expect(await load('03_storeroom_parts_export.csv', 'parts', undefined, true)).toMatchObject({ created: 9, failed: 1 });
    expect(await load('04_legacy_cmms_work_history.json', 'work_order_history', 'legacy-cmms-history.json', true)).toMatchObject({ created: 7, failed: 1 });
    expect(await load('05_downtime_tally.csv', 'asset_downtime', 'downtime-tally.json')).toMatchObject({ created: 9, failed: 0 });
    expect(await load('07_accounting_vendor_list.csv', 'suppliers', 'accounting-vendors.json')).toMatchObject({ created: 6, failed: 0 });
    // CMP-OIL-ROTO was rejected from the parts file ("call for price") and GEARBOX-X9 is not a Ridgeline part.
    expect(await load('08_supplier_price_list.xlsx', 'supplier_prices', 'supplier-price-list.json', true)).toMatchObject({ created: 6, failed: 2 });
    const acme = await asActor(world.admin, (tx) => one(tx, `SELECT email, custom_fields FROM supplier WHERE code = 'ACMEIND'`));
    expect(acme).toEqual({ email: null, custom_fields: {} }); // bad email dropped with a warning; Tax ID never imported
    const brg = await asActor(world.admin, (tx) => many(tx, `SELECT p.part_number, sp.supplier_part_number, sp.unit_price, sp.lead_time_days, sp.preferred
      FROM supplier_part sp JOIN part p ON p.id = sp.part_id WHERE p.part_number IN ('BRG-6205-2RS', 'BRG-7014-ACD') ORDER BY 1`));
    expect(brg).toEqual([
      { part_number: 'BRG-6205-2RS', supplier_part_number: 'K-6205-2RS', unit_price: 8.4, lead_time_days: null, preferred: true },
      { part_number: 'BRG-7014-ACD', supplier_part_number: 'K-7014ACD-P4A-DB', unit_price: 1195, lead_time_days: 21, preferred: true },
    ]);
  });

  it('unpivots a wide training matrix into qualification records', async () => {
    const world = await makeWorld('matrix');
    await asActor(world.admin, async (tx) => {
      await tx.query(`UPDATE facility SET code = 'DAY' WHERE id = $1`, [world.facilities.A]);
      await tx.query(`UPDATE facility SET code = 'FTW' WHERE id = $1`, [world.facilities.B]);
    });
    const payroll = await stageImport(world.admin, { target: 'employees', sourceSystem: 'payroll', fileName: 'p.csv', content: await readFile('samples/imports/ridgeline/01_payroll_employee_export.csv'), facilityId: world.facilities.A });
    await commitImport(world.admin, payroll.batchId);
    await asActor(world.admin, async (tx) => {
      await createQualification(tx, world.admin, { code: 'LOTO', name: 'Lockout/Tagout authorized employee', validityMonths: 12, safetyCritical: true });
      await createQualification(tx, world.admin, { code: 'FORKLIFT', name: 'Powered industrial truck operator', validityMonths: 36 });
      await createQualification(tx, world.admin, { code: 'NFPA70E', name: 'Arc flash / NFPA 70E qualified person', validityMonths: 36, safetyCritical: true });
      await createQualification(tx, world.admin, { code: 'RIGGING', name: 'Crane & rigging', validityMonths: 60 });
    });
    const p = JSON.parse(await readFile('samples/imports/ridgeline/profiles/training-matrix.json', 'utf8'));
    const staged = await stageImport(world.admin, { target: 'qualification_records', sourceSystem: p.sourceSystem, fileName: 'm.xlsx',
      content: await readFile('samples/imports/ridgeline/06_training_matrix.xlsx'), mapping: p.mapping });
    // One record per filled cell (blank and "n/a" cells are skipped) = 17; the contractor is not an employee.
    expect(staged.stats).toMatchObject({ total: 17, errors: 1 });
    expect(staged.problems).toEqual([{ rowNumber: 9, sourceColumn: 'LOTO (annual)', messages: [expect.objectContaining({ field: 'employee_number' })] }]);
    const xRow = staged.preview.find((r: any) => r.sourceColumn === 'Crane & Rigging' && r.values.employee_number === 'E1001');
    expect(xRow!.messages[0]!.message).toMatch(/no completion date/);
    const problems = await errorReportRows(world.admin, staged.batchId);
    expect(problems.columns.slice(0, 2)).toEqual(['Source row', 'Source column']);
    const r = await commitImport(world.admin, staged.batchId, { allowPartial: true });
    expect(r.stats).toMatchObject({ created: 16, failed: 1 });
    const status = await asActor(world.admin, async (tx) => {
      const emp = await one(tx, `SELECT id FROM employee WHERE employee_number = 'E1003'`);
      const q = await one(tx, `SELECT id FROM qualification WHERE code = 'FORKLIFT'`);
      return qualificationStatus(tx, emp.id, q.id);
    });
    expect(status).toMatchObject({ status: 'expired', grant: { effective_on: '2023-03-02', expires_on: '2026-03-02' } });
    // Re-committing the same matrix creates nothing new.
    const again = await stageImport(world.admin, { target: 'qualification_records', sourceSystem: p.sourceSystem, fileName: 'm.xlsx',
      content: await readFile('samples/imports/ridgeline/06_training_matrix.xlsx'), mapping: p.mapping });
    const r2 = await commitImport(world.admin, again.batchId, { allowPartial: true });
    expect(r2.stats).toMatchObject({ created: 0, unchanged: 16 });
  });
});
