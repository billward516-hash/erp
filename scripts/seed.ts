/**
 * Development seed: resets the dev database and builds two fictional tenants.
 *
 *   Ridgeline Precision Machining — 2 facilities (DAY Dayton OH, FTW Fort Wayne IN). Master data is
 *     loaded the way a customer's would be: through the import pipeline from samples/imports/ridgeline
 *     (payroll CSV, Excel equipment list, semicolon/cp1252 storeroom export, JSON CMMS history,
 *     downtime tally), using auto-mapping where it suffices and saved profiles where it does not.
 *   Northgate Fabrication — 1 facility, a tiny asset list; exists to demonstrate tenant isolation.
 *
 * Writes dev API tokens to .storage/dev-tokens.json (git-ignored). Refuses to run in production.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { loadActor } from '../src/platform/auth/actor.js';
import type { Actor } from '../src/platform/auth/actor.js';
import { asActor } from '../src/platform/auth/actor.js';
import { closePools, getAdminPool } from '../src/platform/db/pool.js';
import { migrate } from '../src/platform/db/migrate.js';
import { LocalBlobStore } from '../src/platform/storage/blob-store.js';
import { createUserWithToken, provisionTenant } from '../src/platform/tenancy/provision.js';
import { config } from '../src/config.js';
import { recordState } from '../src/modules/assets/service.js';
import type { AssetState } from '../src/modules/assets/utilization.js';
import { addVersion, approveVersion, createDocument, linkDocument } from '../src/modules/documents/service.js';
import { commitImport, saveProfile, stageImport } from '../src/modules/imports/service.js';
import { addLabor, addPart, assignTechnician, attachProcedure, createRequest, createWorkOrder, transitionWorkOrder } from '../src/modules/maintenance/service.js';

if (process.env.NODE_ENV === 'production') throw new Error('refusing to seed a production database');

const SAMPLES = path.resolve('samples');
const blobs = new LocalBlobStore(config.storageDir);
const HOUR = 3_600_000;
const log = (...a: unknown[]) => console.log(...a);

/** Deterministic PRNG so every seed produces the same history shape. */
function rng(seed: number) {
  return () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
}

async function runImport(actor: Actor, opts: { file: string; target: string; sourceSystem: string; facilityId?: string; profile?: string; allowPartial?: boolean }) {
  const content = await readFile(path.join(SAMPLES, 'imports', opts.file));
  let profileId: string | undefined;
  if (opts.profile) {
    const p = JSON.parse(await readFile(path.join(SAMPLES, 'imports', opts.profile), 'utf8'));
    profileId = (await saveProfile(actor, { name: p.name, target: p.target, sourceSystem: p.sourceSystem, mapping: p.mapping })).id;
  }
  const staged = await stageImport(actor, { target: opts.target, sourceSystem: opts.sourceSystem, fileName: path.basename(opts.file), content, facilityId: opts.facilityId ?? null, profileId });
  const s = staged.stats;
  log(`  ${path.basename(opts.file)} → ${opts.target} [${profileId ? 'saved profile' : 'auto-mapped'}]: ${s.total} rows, ${s.valid} valid, ${s.warnings} with warnings, ${s.errors} errors`);
  for (const w of staged.warnings) log(`      note: ${w}`);
  for (const r of staged.preview.filter((r: any) => r.messages.length)) {
    log(`      row ${r.rowNumber} ${r.status === 'error' ? 'ERROR' : 'warning'}: ${r.messages.map((m: any) => m.message).join('; ')}`);
  }
  const committed = await commitImport(actor, staged.batchId, { allowPartial: opts.allowPartial });
  log(`      committed: ${committed.stats.created} created, ${committed.stats.updated} updated, ${committed.stats.failed} not imported`);
  return staged.batchId;
}

async function seedRidgeline() {
  const db = getAdminPool();
  const t = await provisionTenant(db, {
    slug: 'ridgeline', name: 'Ridgeline Precision Machining', legalEntity: 'Ridgeline Precision Machining LLC',
    facilities: [
      { code: 'DAY', name: 'Dayton Plant', timezone: 'America/New_York' },
      { code: 'FTW', name: 'Fort Wayne Plant', timezone: 'America/Indiana/Indianapolis' },
    ],
  });
  const tokens: Record<string, string> = {};
  const bootstrap = await createUserWithToken(db, t.tenantId, { email: 'dana.walsh@ridgeline.example', displayName: 'Dana Walsh', roles: [{ role: 'admin', facility: null }] });
  tokens['dana (admin, all facilities)'] = bootstrap.token;
  const admin = (await loadActor(t.tenantId, bootstrap.userId))!;

  log('Ridgeline: importing customer files');
  await runImport(admin, { file: 'ridgeline/01_payroll_employee_export.csv', target: 'employees', sourceSystem: 'payroll-csv' });
  await runImport(admin, { file: 'ridgeline/02_equipment_register.xlsx', target: 'assets', sourceSystem: 'ridgeline-equipment-xlsx', profile: 'ridgeline/profiles/equipment-register.json' });
  await runImport(admin, { file: 'ridgeline/03_storeroom_parts_export.csv', target: 'parts', sourceSystem: 'storeroom-csv', allowPartial: true });
  await runImport(admin, { file: 'ridgeline/04_legacy_cmms_work_history.json', target: 'work_order_history', sourceSystem: 'legacy-cmms', profile: 'ridgeline/profiles/legacy-cmms-history.json', allowPartial: true });
  await runImport(admin, { file: 'ridgeline/05_downtime_tally.csv', target: 'asset_downtime', sourceSystem: 'downtime-tally', facilityId: t.facilities.DAY, profile: 'ridgeline/profiles/downtime-tally.json' });

  // Users linked to imported employees.
  const emp = async (n: string) => (await db.query('SELECT id FROM employee WHERE tenant_id = $1 AND employee_number = $2', [t.tenantId, n])).rows[0].id as string;
  const mk = async (label: string, email: string, name: string, employeeNumber: string | null, roles: { role: string; facility: string | null }[]) => {
    const u = await createUserWithToken(db, t.tenantId, { email, displayName: name, employeeId: employeeNumber ? await emp(employeeNumber) : null, roles });
    tokens[label] = u.token;
    return (await loadActor(t.tenantId, u.userId))!;
  };
  const marcus = await mk('marcus (maintenance manager, DAY)', 'marcus.kowalski@ridgeline.example', 'Marcus Kowalski', 'E1003', [{ role: 'maintenance_manager', facility: t.facilities.DAY! }]);
  const sean = await mk('sean (maintenance lead/manager, FTW)', 'sean.brennan@ridgeline.example', 'Sean Brennan', 'E1005', [{ role: 'maintenance_manager', facility: t.facilities.FTW! }]);
  const priya = await mk('priya (technician, DAY)', 'priya.shah@ridgeline.example', 'Priya Shah', 'E1001', [{ role: 'technician', facility: t.facilities.DAY! }]);
  const luis = await mk('luis (technician, FTW)', 'luis.ortega@ridgeline.example', 'Luis Ortega', 'E1002', [{ role: 'technician', facility: t.facilities.FTW! }]);
  await mk('tolu (operator, DAY)', 'tolu.adeyemi@ridgeline.example', 'Tolu Adeyemi', 'E1006', [{ role: 'operator', facility: t.facilities.DAY! }]);
  await mk('exec (executive, read-only, all facilities)', 'ceo@ridgeline.example', 'Pat Morgan', null, [{ role: 'executive', facility: null }]);

  const asset = async (tag: string) => (await db.query('SELECT id FROM asset WHERE tenant_id = $1 AND asset_tag = $2', [t.tenantId, tag])).rows[0].id as string;
  const part = async (pn: string) => (await db.query('SELECT id FROM part WHERE tenant_id = $1 AND part_number = $2', [t.tenantId, pn])).rows[0].id as string;
  const read = (f: string) => readFile(path.join(SAMPLES, 'documents', f));

  log('Ridgeline: controlled documents');
  const docs = await asActor(admin, async (tx) => {
    const add = async (d: Parameters<typeof createDocument>[2], file: string, mime: string, label = 'Rev A', links: string[] = []) => {
      const doc = await createDocument(tx, admin, d);
      const content = await read(file);
      const v = await addVersion(tx, admin, blobs, doc.id, { versionLabel: label, fileName: file, mimeType: mime, content, extractedText: mime.startsWith('text/') ? content.toString('utf8') : undefined });
      for (const tag of links) await linkDocument(tx, admin, doc.id, { entityType: 'asset', entityId: await asset(tag) });
      return { doc, v };
    };
    return {
      manual: await add({ facilityId: t.facilities.DAY, docNumber: 'MAN-CNC-101', title: 'Haas VF-4 operator & maintenance manual', docType: 'manual', tags: ['haas', 'vf-4', 'oem'] }, 'CNC-101_operator_and_maintenance_manual.pdf', 'application/pdf', 'OEM 2016', ['CNC-101', 'CNC-101-SPN']),
      tsg: await add({ facilityId: t.facilities.DAY, docNumber: 'TSG-HMC-201-SPN', title: 'HMC-201 spindle vibration troubleshooting', docType: 'troubleshooting_guide', tags: ['spindle', 'vibration', 'okuma'], safetyCritical: true }, 'HMC-201_spindle_vibration_troubleshooting.txt', 'text/plain', 'Rev A', ['HMC-201']),
      loto: await add({ facilityId: null, docNumber: 'SOP-LOTO-001', title: 'Lockout/Tagout', docType: 'sop', tags: ['safety', 'loto'], safetyCritical: true }, 'SOP-LOTO-001_lockout_tagout.txt', 'text/plain', 'Rev 3'),
      cmpProc: await add({ facilityId: t.facilities.DAY, docNumber: 'RP-CMP-01-OIL', title: 'CMP-01 oil & separator change', docType: 'repair_procedure', tags: ['compressor', 'pm'] }, 'CMP-01_oil_change_procedure.txt', 'text/plain', 'Rev A', ['CMP-01']),
      schematic: await add({ facilityId: t.facilities.DAY, docNumber: 'DWG-CMP-01-E', title: 'CMP-01 electrical schematic', docType: 'drawing', tags: ['electrical'], restricted: true }, 'CMP-01_electrical_schematic.txt', 'text/plain', 'Rev A', ['CMP-01']),
    };
  });
  // Safety-critical documents need an approver other than the author (Dana authored; Marcus approves).
  for (const d of [docs.tsg, docs.loto]) await asActor(marcus, (tx) => approveVersion(tx, marcus, d.v.id));
  for (const d of [docs.manual, docs.cmpProc, docs.schematic]) await asActor(admin, (tx) => approveVersion(tx, admin, d.v.id));
  await asActor(admin, async (tx) => {
    await addVersion(tx, admin, blobs, docs.cmpProc.doc.id, { versionLabel: 'Rev B', fileName: 'CMP-01_oil_change_procedure_revB.txt', mimeType: 'text/plain',
      content: await read('CMP-01_oil_change_procedure_revB.txt'), changeSummary: 'Add separator differential-pressure check' });
  });

  log('Ridgeline: 30 days of machine state history');
  const now = Date.now();
  const histStart = now - 30 * 24 * HOUR;
  const profiles: Record<string, { downRate: number; idle: number }> = {
    'CNC-101': { downRate: 0.02, idle: 0.2 }, 'CNC-102': { downRate: 0.01, idle: 0.3 }, 'CNC-104': { downRate: 0.12, idle: 0.2 },
    'HMC-201': { downRate: 0.2, idle: 0.15 }, 'EDM-301': { downRate: 0.01, idle: 0.35 }, 'CMP-01': { downRate: 0.005, idle: 0 },
    'CNC-501': { downRate: 0.03, idle: 0.25 }, 'CNC-502': { downRate: 0.02, idle: 0.3 }, 'PRS-01': { downRate: 0.1, idle: 0.3 },
  };
  let seed = 7;
  for (const [tag, p] of Object.entries(profiles)) {
    const id = await asset(tag);
    const facilityActor = tag.startsWith('CNC-5') || tag.startsWith('PRS') ? sean : marcus;
    const r = rng(seed++);
    let at = histStart;
    await asActor(facilityActor, async (tx) => {
      while (at < now - 3 * HOUR) {
        const roll = r();
        let state: AssetState; let hours: number; let reason: string | null = null;
        if (roll < p.downRate) { state = 'unplanned_downtime'; hours = 0.5 + r() * 5; reason = ['MECH', 'ELEC', 'HYD', 'TOOL'][Math.floor(r() * 4)]!; }
        else if (roll < p.downRate + 0.04) { state = 'planned_downtime'; hours = 1 + r() * 3; reason = r() < 0.5 ? 'PM' : 'SETUP'; }
        else if (roll < p.downRate + 0.04 + p.idle) { state = 'idle'; hours = 1 + r() * 6; }
        else { state = 'running'; hours = 4 + r() * 10; }
        await recordState(tx, facilityActor, id, { state, at: new Date(at), reasonCode: reason, note: null });
        at += hours * HOUR;
      }
      await recordState(tx, facilityActor, id, { state: 'running', at: new Date(now - 2 * HOUR) });
    });
  }

  log('Ridgeline: open maintenance work');
  const day = (offset: number) => new Date(now + offset * 24 * HOUR).toISOString();
  const today = new Date(now).toISOString().slice(0, 10);
  // 1. HMC-201 down, in progress
  const req1 = await asActor(priya, async (tx) => createRequest(tx, priya, { assetId: await asset('HMC-201'), symptom: 'Spindle vibration and noise above 6k rpm; operator stopped machine', severity: 'critical', safetyImpact: false, assetDown: true }));
  const wo1 = await asActor(marcus, async (tx) => {
    const wo = await createWorkOrder(tx, marcus, { assetId: await asset('HMC-201'), requestId: req1.id, title: 'Spindle vibration above 6k rpm', dueAt: day(1), estimatedLaborHours: 6, safetyNotes: 'LOTO per SOP-LOTO-001 before opening spindle housing' });
    await assignTechnician(tx, marcus, wo.id, priya.employeeId!, 'lead');
    await attachProcedure(tx, marcus, wo.id, docs.tsg.v.id);
    await addPart(tx, marcus, wo.id, { partId: await part('BRG-7014-ACD'), qtyPlanned: 1 });
    return wo;
  });
  await asActor(priya, async (tx) => {
    await transitionWorkOrder(tx, priya, wo1.id, { to: 'in_progress' });
    await addLabor(tx, priya, wo1.id, { workDate: today, hours: 2.5, hourlyRate: 46, note: 'Vibration survey; drawbar pressure OK' });
  });
  // 2. CNC-104 completed, awaiting verification
  const wo2 = await asActor(marcus, async (tx) => {
    const wo = await createWorkOrder(tx, marcus, { assetId: await asset('CNC-104'), title: 'Turret clamp alarm intermittent', priority: 2, dueAt: day(2) });
    await assignTechnician(tx, marcus, wo.id, priya.employeeId!);
    return wo;
  });
  await asActor(priya, async (tx) => {
    await transitionWorkOrder(tx, priya, wo2.id, { to: 'in_progress' });
    await addLabor(tx, priya, wo2.id, { workDate: today, hours: 1.5, hourlyRate: 46 });
    await addPart(tx, priya, wo2.id, { partId: await part('FTG-90-08'), qtyUsed: 2 });
    await transitionWorkOrder(tx, priya, wo2.id, { to: 'completed', remedy: 'Re-seated clamp sensor connector; replaced leaking fitting', findings: 'Coolant ingress at connector', failureCode: 'ELEC-SENSOR' });
  });
  // 3. CMP-01 overdue, unassigned
  await asActor(marcus, async (tx) => {
    const wo = await createWorkOrder(tx, marcus, { assetId: await asset('CMP-01'), title: 'Oil weeping at separator housing', priority: 2, dueAt: day(-3), woType: 'corrective' });
    await attachProcedure(tx, marcus, wo.id, docs.cmpProc.v.id);
  });
  // 4. FLT-07 inspection scheduled
  await asActor(marcus, async (tx) => {
    const wo = await createWorkOrder(tx, marcus, { assetId: await asset('FLT-07'), title: 'Brake pad re-inspection (40% at annual)', woType: 'inspection', priority: 3, dueAt: day(4) });
    await transitionWorkOrder(tx, marcus, wo.id, { to: 'scheduled' });
  });
  // 5. CNC-501 full lifecycle at FTW: Luis completes, Sean verifies and closes
  const wo5 = await asActor(sean, async (tx) => {
    const wo = await createWorkOrder(tx, sean, { assetId: await asset('CNC-501'), title: 'Chuck pressure low alarm', priority: 2, dueAt: day(-1) });
    await assignTechnician(tx, sean, wo.id, luis.employeeId!);
    return wo;
  });
  await asActor(luis, async (tx) => {
    await transitionWorkOrder(tx, luis, wo5.id, { to: 'in_progress' });
    await addLabor(tx, luis, wo5.id, { workDate: today, hours: 2, hourlyRate: 42 });
    await addPart(tx, luis, wo5.id, { partId: await part('FLT-HYD-10'), qtyUsed: 1 });
    await transitionWorkOrder(tx, luis, wo5.id, { to: 'completed', remedy: 'Replaced clogged hydraulic filter; pressure restored to spec' });
  });
  await asActor(sean, async (tx) => {
    await transitionWorkOrder(tx, sean, wo5.id, { to: 'verified', note: 'Cycled chuck 20x at spec pressure' });
    await transitionWorkOrder(tx, sean, wo5.id, { to: 'closed' });
  });
  // 6. PRS-01 on hold, overdue
  await asActor(sean, async (tx) => {
    const wo = await createWorkOrder(tx, sean, { assetId: await asset('PRS-01'), title: 'Backgauge drifting on Y-axis', priority: 3, dueAt: day(-6) });
    await assignTechnician(tx, sean, wo.id, luis.employeeId!);
    await transitionWorkOrder(tx, sean, wo.id, { to: 'on_hold', note: 'Waiting on OEM encoder' });
  });
  return { tenantId: t.tenantId, tokens };
}

async function seedNorthgate() {
  const db = getAdminPool();
  const t = await provisionTenant(db, { slug: 'northgate', name: 'Northgate Fabrication', legalEntity: 'Northgate Fabrication Inc.',
    facilities: [{ code: 'MAIN', name: 'Main Shop', timezone: 'America/Chicago' }] });
  const u = await createUserWithToken(db, t.tenantId, { email: 'admin@northgate.example', displayName: 'Northgate Admin', roles: [{ role: 'admin', facility: null }] });
  const admin = (await loadActor(t.tenantId, u.userId))!;
  log('Northgate: importing asset list');
  await runImport(admin, { file: 'northgate/assets.csv', target: 'assets', sourceSystem: 'northgate-csv', profile: 'northgate/profiles/assets.json' });
  return { tokens: { 'northgate admin (other tenant)': u.token } };
}

await migrate(undefined, { reset: true });
log('database reset and migrated');
const r = await seedRidgeline();
const n = await seedNorthgate();
const tokens = { ...r.tokens, ...n.tokens };
await mkdir(config.storageDir, { recursive: true });
await writeFile(path.join(config.storageDir, 'dev-tokens.json'), JSON.stringify(tokens, null, 2));
const counts = (await getAdminPool().query(`SELECT (SELECT count(*) FROM asset) assets, (SELECT count(*) FROM work_order) work_orders,
  (SELECT count(*) FROM asset_state_event) state_events, (SELECT count(*) FROM audit_event) audit_events`)).rows[0];
log('\ntotals:', counts);
log(`\ndev tokens written to ${path.join(config.storageDir, 'dev-tokens.json')}:`);
for (const [k, v] of Object.entries(tokens)) log(`  ${k.padEnd(44)} ${v}`);
await closePools();
