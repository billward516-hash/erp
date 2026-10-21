/**
 * Generates the sample customer files under samples/. These imitate how a prospect's data actually
 * arrives (payroll CSV, a hand-kept Excel equipment list, a semicolon/Windows-1252 storeroom export,
 * a nested JSON export from a legacy CMMS, a paper-style downtime tally) — deliberately inconsistent
 * headers, codes, date styles and a few bad rows. All companies, people and serial numbers are fictional.
 *
 *   npx tsx scripts/generate-samples.ts
 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import ExcelJS from 'exceljs';
import PDFDocument from 'pdfkit';

const ROOT = path.resolve('samples');
const R = path.join(ROOT, 'imports', 'ridgeline');
const N = path.join(ROOT, 'imports', 'northgate');
const D = path.join(ROOT, 'documents');

const csv = (rows: (string | number)[][], delimiter = ',') =>
  rows.map((r) => r.map((v) => { const s = String(v); return /[",;\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; }).join(delimiter)).join('\r\n') + '\r\n';

/** Minimal Windows-1252 encoder for the characters used below. */
function cp1252(text: string): Buffer {
  const map: Record<string, number> = { '–': 0x96, '—': 0x97, '°': 0xb0, '’': 0x92, 'µ': 0xb5, 'é': 0xe9, 'ø': 0xf8 };
  return Buffer.from([...text].map((c) => map[c] ?? (c.charCodeAt(0) < 128 ? c.charCodeAt(0) : 0x3f)));
}

async function employees() {
  await writeFile(path.join(R, '01_payroll_employee_export.csv'), csv([
    ['Emp ID', 'Employee Name', 'Home Site', 'Department', 'Job Title', 'Hire Dt', 'Status', 'Shift'],
    ['E1001', 'Shah, Priya', 'DAY', 'Maintenance', 'Maintenance Technician II', '04/17/2019', 'A', '1st'],
    ['E1002', 'Ortega, Luis', 'FTW', 'Maintenance', 'Maintenance Technician I', '09/03/2021', 'A', '2nd'],
    ['E1003', 'Kowalski, Marcus', 'DAY', 'Maintenance', 'Maintenance Manager', '01/08/2015', 'A', '1st'],
    ['E1004', 'Nguyen, Thi', 'DAY', 'Maintenance', 'Electrician', '06/22/2020', 'A', '1st'],
    ['E1005', 'Brennan, Sean', 'FTW', 'Maintenance', 'Maintenance Lead', '11/30/2016', 'A', '1st'],
    ['E1006', 'Adeyemi, Tolu', 'DAY', 'Production', 'CNC Operator', '02/14/2022', 'A', '2nd'],
    ['E1007', 'Fischer, Hanna', 'FTW', 'Production', 'CNC Operator', '07/05/2023', 'LOA', '1st'],
    ['E1008', 'Reyes, Carlos', 'DAY', 'Maintenance', 'Maintenance Technician I', '03/11/2018', 'T', '2nd'],
    ['E1009', 'Walsh, Dana', 'DAY', 'Operations', 'Operations Director', '08/19/2012', 'A', '1st'],
  ]));
}

async function equipment() {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Equipment');
  ws.addRow(['Ridgeline Precision — Equipment List (maintained by M. Kowalski, last updated 3/2026)']);
  ws.addRow([]);
  ws.addRow(['Equip #', 'Description', 'Type', 'Site', 'Bldg', 'Line/Area', 'Parent Equip', 'Mfr', 'Model', 'S/N', 'Crit (A/B/C)', 'Install Date', 'Status', 'Coolant', 'Notes']);
  const d = (s: string) => new Date(`${s}T00:00:00Z`);
  const rows: unknown[][] = [
    ['CNC-101', 'Haas VF-4 Vertical Machining Center', 'Machine', 'DAY', 'Bldg 1', 'Cell 1', '', 'Haas', 'VF-4', '1145872', 'A', d('2016-05-12'), 'In Service', 'Synthetic', ''],
    ['CNC-101-SPN', 'VF-4 Spindle Assembly 40T 8.1k', 'Component', 'DAY', 'Bldg 1', 'Cell 1', 'CNC-101', 'Haas', '93-1000', '', 'A', d('2016-05-12'), 'In Service', '', 'Rebuilt 2023'],
    ['CNC-102', 'Haas VF-2SS Vertical Machining Center', 'Machine', 'DAY', 'Bldg 1', 'Cell 1', '', 'Haas', 'VF-2SS', '1162093', 'B', d('2018-09-03'), 'In Service', 'Synthetic', ''],
    ['CNC-104', 'Mazak QTN-250 CNC Lathe', 'Machine', 'DAY', 'Bldg 1', 'Cell 2', '', 'Mazak', 'Quick Turn Nexus 250', '228714', 'A', d('2014-02-20'), 'In Service', 'Semi-synthetic', ''],
    ['CNC-104-TUR', 'QTN-250 12-station turret', 'Component', 'DAY', 'Bldg 1', 'Cell 2', 'CNC-104', 'Mazak', '', '', 'A', d('2014-02-20'), 'In Service', '', ''],
    ['HMC-201', 'Okuma MB-5000H Horizontal Machining Center', 'Machine', 'DAY', 'Bldg 2', 'Line 3', '', 'Okuma', 'MB-5000H', '1B4471', 'A', d('2019-11-15'), 'In Service', 'Synthetic', 'Pallet changer serviced by OEM'],
    ['EDM-301', 'Sodick AG400L Wire EDM', 'Machine', 'DAY', 'Bldg 2', 'EDM Room', '', 'Sodick', 'AG400L', '40-1932', 'B', d('2017-07-01'), 'In Service', 'DI water', ''],
    ['CMP-01', 'Atlas Copco GA30 VSD Air Compressor', 'Utility', 'DAY', 'Bldg 1', 'Utilities', '', 'Atlas Copco', 'GA30 VSD', 'API882211', 'A', d('2013-04-04'), 'In Service', '', 'Plant air — single point of failure'],
    ['FLT-07', 'Toyota 8FGU25 Forklift', 'Vehicle', 'DAY', 'Bldg 1', 'Shipping', '', 'Toyota', '8FGU25', '8FGU25-71234', 'C', d('2020-01-15'), 'In Service', '', ''],
    ['CMM-01', 'Zeiss Contura G2 CMM', 'Inspection', 'DAY', 'Bldg 2', 'Quality Lab', '', 'Zeiss', 'Contura G2', '7821', 'B', '03/01/2019', 'In Service', '', 'Install date typed as text'],
    ['CNC-501', 'DMG MORI NLX 2500 CNC Lathe', 'Machine', 'FTW', 'Plant 2', 'Line 1', '', 'DMG MORI', 'NLX 2500', 'NLX25-0099', 'A', d('2021-06-10'), 'In Service', 'Semi-synthetic', ''],
    ['CNC-502', 'Haas ST-20Y CNC Lathe', 'Machine', 'FTW', 'Plant 2', 'Line 1', '', 'Haas', 'ST-20Y', '3120044', 'B', d('2022-02-28'), 'In Service', 'Semi-synthetic', ''],
    ['SAW-01', 'HE&M H90A Horizontal Band Saw', 'Machine', 'FTW', 'Plant 2', 'Saw Area', '', 'HE&M', 'H90A', '77612', 'C', d('2015-08-08'), 'Standby', '', 'Backup saw'],
    ['PRS-01', 'Amada HG-1303 Press Brake', 'Machine', 'FTW', 'Plant 2', 'Fab', '', 'Amada', 'HG-1303', '1303-554', 'A', d('2020-10-01'), 'In Service', '', ''],
  ];
  rows.forEach((r) => ws.addRow(r));
  ws.getColumn(12).numFmt = 'm/d/yyyy';
  ws.getRow(1).font = { bold: true, size: 14 };
  ws.getRow(3).font = { bold: true };
  const notes = wb.addWorksheet('Revision notes');
  notes.addRow(['Date', 'Change']);
  notes.addRow(['3/2026', 'Added CMM-01']);
  await wb.xlsx.writeFile(path.join(R, '02_equipment_register.xlsx'));
}

async function parts() {
  // Storeroom export: semicolons, Windows-1252, "$" prices, free-form units, one unusable price.
  const text = csv([
    ['Item Code', 'Item Description', 'U/M', 'Manufacturer', 'Mfr P/N', 'Avg Cost', 'On Hand', 'Bin', 'Status'],
    ['BRG-6205-2RS', 'Ball bearing 6205-2RS 25x52x15', 'EA', 'SKF', '6205-2RSH', '$8.75', '24', 'A-01-03', 'Active'],
    ['BRG-7014-ACD', 'Spindle bearing 7014 ACD/P4A (matched pair)', 'PR', 'SKF', '7014 ACD/P4ADGA', '$1,248.00', '2', 'CAGE-1', 'Active'],
    ['BLT-AX38', 'V-belt AX38', 'each', 'Gates', 'AX38', '$14.20', '6', 'B-02-11', 'Active'],
    ['FLT-HYD-10', 'Hydraulic filter element 10 µm', 'pcs', 'Parker', '937399Q', '$46.10', '8', 'B-03-02', 'Active'],
    ['FTG-90-08', '90° elbow fitting 1/2" JIC', 'pcs', 'Parker', '6C5MX5', '$7.35', '40', 'C-01-01', 'Active'],
    ['CLN-TRIM-5G', 'Coolant concentrate – 5 gal pail', 'pail', 'Master Fluid Solutions', 'TRIM SC520', '$189.00', '5', 'FLOOR', 'Active'],
    ['WIRE-EDM-025', 'EDM wire 0.25 mm brass, 8 kg spool', 'spool', 'Sodick', 'BS-025-8', '$212.40', '3', 'EDM-1', 'Active'],
    ['SEAL-KIT-VF4', 'Spindle drawbar seal kit', 'kit', 'Haas', '93-3215', '$96.00', '1', 'CAGE-1', 'Active'],
    ['FLT-AIR-OLD', 'Air filter (superseded by FLT-AIR-2)', 'EA', 'Atlas Copco', '1613740800', '$22.00', '0', '', 'Obsolete'],
    ['CMP-OIL-ROTO', 'Compressor oil Roto-Inject 5 L', 'EA', 'Atlas Copco', '2901052200', 'call for price', '2', 'B-04-01', 'Active'],
  ], ';');
  await writeFile(path.join(R, '03_storeroom_parts_export.csv'), cp1252(text));
}

async function workHistory() {
  // Legacy CMMS API export: nested objects, type codes, minutes instead of hours, zone-less timestamps.
  const records = [
    { woNumber: 'L-24517', equipment: { tag: 'CNC-104', site: 'DAY' }, problem: 'Turret will not index — alarm 2104', type: 'BD', priority: 'Emergency', status: 'Closed',
      opened: '2026-02-11T06:40:00', closed: '2026-02-11 14:05', assignedTo: 'Priya Shah', laborMinutes: '315', actionTaken: 'Replaced turret clamp proximity switch; recalibrated', failureCode: 'ELEC-SENSOR' },
    { woNumber: 'L-24533', equipment: { tag: 'CMP-01', site: 'DAY' }, problem: '2000 h service', type: 'PM', priority: 'Normal', status: 'Closed',
      opened: '2026-02-18T07:00:00', closed: '2026-02-18 10:30', assignedTo: 'Thi Nguyen', laborMinutes: '180', actionTaken: 'Oil, oil filter, air filter, separator element' },
    { woNumber: 'L-24540', equipment: { tag: 'HMC-201', site: 'DAY' }, problem: 'Pallet changer slow / hesitates at 90°', type: 'BD', priority: 'High', status: 'Closed',
      opened: '2026-02-23T13:15:00', closed: '2026-02-24 09:50', assignedTo: 'J. Temp (contractor)', laborMinutes: '420', actionTaken: 'OEM tech adjusted hydraulic flow control', failureCode: 'HYD-FLOW' },
    { woNumber: 'L-24561', equipment: { tag: 'CNC-501', site: 'FTW' }, problem: 'Coolant pump not priming', type: 'BD', priority: 'High', status: 'Closed',
      opened: '2026-03-02T09:20:00', closed: '2026-03-02 12:00', assignedTo: 'Luis Ortega', laborMinutes: '150', actionTaken: 'Cleared chip packing at intake; replaced strainer', failureCode: 'MECH-BLOCKED' },
    { woNumber: 'L-24570', equipment: { tag: 'FLT-07', site: 'DAY' }, problem: 'Annual forklift inspection', type: 'INSP', priority: 'Normal', status: 'Closed',
      opened: '2026-03-05T08:00:00', closed: '2026-03-05 09:15', assignedTo: 'E1001', laborMinutes: '75', actionTaken: 'Passed; brake pads at 40%' },
    { woNumber: 'L-24588', equipment: { tag: 'PRS-01', site: 'FTW' }, problem: 'Ram drift under load', type: 'BD', priority: 'High', status: 'Closed',
      opened: '2026-03-09T10:00:00', closed: '2026-03-10 16:30', assignedTo: 'Sean Brennan', laborMinutes: '600', actionTaken: 'Replaced cylinder seals', failureCode: 'HYD-SEAL', notes: 'Seals had 7 yrs service' },
    { woNumber: 'L-24590', equipment: { tag: 'CNC-102', site: 'DAY' }, problem: 'Way lube low alarm', type: 'BD', priority: 'Normal', status: 'Cancelled',
      opened: '2026-03-12T11:00:00', closed: null, assignedTo: null, laborMinutes: null, actionTaken: null, notes: 'Operator refilled reservoir' },
    { woNumber: 'L-24602', equipment: { tag: 'VMC-9', site: 'DAY' }, problem: 'Spindle warmup program update', type: 'PM', priority: 'Low', status: 'Closed',
      opened: '2026-03-16T08:00:00', closed: '2026-03-16 08:30', assignedTo: 'Priya Shah', laborMinutes: '30', actionTaken: 'Updated O9001', notes: 'VMC-9 was sold in 2024 — not in register' },
  ];
  await writeFile(path.join(R, '04_legacy_cmms_work_history.json'), JSON.stringify({ exportedAt: '2026-03-31T23:00:00Z', system: 'LegacyCMMS v4', records }, null, 2) + '\n');
}

async function downtime() {
  // Operator tally sheet: date and times in separate columns, Y/N planned flag, free-text reasons.
  await writeFile(path.join(R, '05_downtime_tally.csv'), csv([
    ['Machine', 'Date', 'Down At', 'Up At', 'Reason', 'Planned?', 'Comments'],
    ['CNC-104', '02/11/2026', '06:40', '14:05', 'ELEC', 'N', 'Turret index alarm'],
    ['CNC-101', '02/16/2026', '07:00', '09:00', 'PM', 'Y', 'Quarterly PM'],
    ['HMC-201', '02/23/2026', '13:15', '23:59', 'HYD', 'N', 'Pallet changer'],
    ['HMC-201', '02/24/2026', '06:00', '09:50', 'HYD', 'N', 'Pallet changer (cont.)'],
    ['CNC-501', '03/02/2026', '09:20', '12:00', 'MECH', 'N', ''],
    ['CNC-102', '03/04/2026', '10:15', '11:00', 'Coolant leak', 'N', 'Reason not on the official code list'],
    ['PRS-01', '03/09/2026', '10:00', '23:59', 'HYD', 'N', 'Ram drift'],
    ['PRS-01', '03/10/2026', '06:00', '16:30', 'HYD', 'N', 'Ram drift (cont.)'],
    ['CNC-101', '03/11/2026', '13:00', '14:30', 'SETUP', 'Y', 'Fixture change'],
  ]));
}

async function northgate() {
  await writeFile(path.join(N, 'assets.csv'), csv([
    ['Asset ID', 'Asset Name', 'Site', 'Type', 'Make', 'Critical?'],
    ['NG-LASER-1', 'Trumpf TruLaser 3030 fiber laser', 'MAIN', 'Machine', 'Trumpf', 'Yes'],
    ['NG-WELD-3', 'Miller Invision 352 MPa welder', 'MAIN', 'Machine', 'Miller', 'No'],
  ]));
}

function pdf(title: string, lines: string[]): Promise<Buffer> {
  const doc = new PDFDocument({ size: 'LETTER', margin: 54 });
  const chunks: Buffer[] = [];
  doc.on('data', (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((r) => doc.on('end', () => r(Buffer.concat(chunks))));
  doc.font('Helvetica-Bold').fontSize(16).text(title).moveDown().font('Helvetica').fontSize(11);
  lines.forEach((l) => doc.text(l).moveDown(0.5));
  doc.end();
  return done;
}

async function documents() {
  await writeFile(path.join(D, 'CNC-101_operator_and_maintenance_manual.pdf'), await pdf('Haas VF-4 — Operator & Maintenance Manual (sample excerpt)', [
    'Sample placeholder created for the demo tenant. It is not an OEM document.',
    'Daily: check way lube and coolant levels; clear chips from enclosure.',
    'Quarterly: inspect spindle drawbar force; grease axis ball screws per schedule.',
  ]));
  await writeFile(path.join(D, 'HMC-201_spindle_vibration_troubleshooting.txt'), [
    'HMC-201 Spindle vibration — troubleshooting guide (Rev A, demo content)',
    '',
    'SAFETY: Apply lockout/tagout per SOP-LOTO-001 before opening the spindle housing.',
    '1. Record vibration at 2k / 6k / 10k rpm using the handheld analyzer.',
    '2. If amplitude rises with speed, check tool holder balance and drawbar pressure.',
    '3. If noise persists with no tool, suspect spindle bearings (part BRG-7014-ACD, matched pair).',
    '4. Do not attempt bearing replacement without the OEM spindle procedure.',
    '',
    'Demo content only; not a validated repair instruction.',
  ].join('\n'));
  await writeFile(path.join(D, 'SOP-LOTO-001_lockout_tagout.txt'), [
    'SOP-LOTO-001 Lockout/Tagout (demo content)',
    'Scope: all energized equipment at Ridgeline facilities.',
    '1. Notify affected operators. 2. Shut down. 3. Isolate all energy sources. 4. Apply personal locks and tags.',
    '5. Release stored energy. 6. Verify zero energy state before work.',
  ].join('\n'));
  await writeFile(path.join(D, 'CMP-01_oil_change_procedure.txt'), 'CMP-01 oil and separator change (Rev A, demo content)\nUse Roto-Inject fluid only. Drain hot. Replace oil filter at every change.\n');
  await writeFile(path.join(D, 'CMP-01_oil_change_procedure_revB.txt'), 'CMP-01 oil and separator change (Rev B DRAFT, demo content)\nAdds a step: record differential pressure across the separator before and after.\n');
  await writeFile(path.join(D, 'CMP-01_electrical_schematic.txt'), 'CMP-01 electrical schematic (restricted, demo content)\n480V 3ph main, VSD drive, control transformer 120V.\n');
}

await Promise.all([R, N, D].map((d) => mkdir(d, { recursive: true })));
await Promise.all([employees(), equipment(), parts(), workHistory(), downtime(), northgate(), documents()]);
console.log('samples written to', ROOT);
