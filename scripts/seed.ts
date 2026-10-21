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
import { addLearningEvent, createCourse, createCourseVersion, publishVersion } from '../src/modules/learning/catalog.js';
import { createQualification, grantQualification, issueCertificate, setAssetRequirement } from '../src/modules/learning/qualifications.js';
import { assignTraining, recordCompletion, submitAttempt } from '../src/modules/learning/training.js';
import { decideApproval } from '../src/modules/approvals/service.js';
import { cancelAction, completeAction, createChange, requestStartup, submitForReview } from '../src/modules/moc/service.js';
import { addLabor, addPart, assignTechnician, attachProcedure, createRequest, createWorkOrder, transitionWorkOrder } from '../src/modules/maintenance/service.js';
import { createLocation, receive, setStockSettings } from '../src/modules/inventory/service.js';
import { createPart } from '../src/modules/parts/service.js';
import { createPlan, generatePmWorkOrders, recordMeter } from '../src/modules/pm/service.js';
import { requestFromReorder } from '../src/modules/purchasing/reorder.js';
import { approveInvoice, captureInvoice, disputeInvoice, invoiceDraftFromOrder } from '../src/modules/ap/service.js';
import { setAccountMapping } from '../src/modules/integrations/accounts.js';
import { createConnection, mockPayBill, runSync } from '../src/modules/integrations/service.js';
import { createOrdersFromRequest, createPurchaseRequest, getOrder, receiveOrder, submitPurchaseRequest } from '../src/modules/purchasing/service.js';

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
    log(`      row ${r.rowNumber}${r.sourceColumn ? ` [${r.sourceColumn}]` : ''} ${r.status === 'error' ? 'ERROR' : 'warning'}: ${r.messages.map((m: any) => m.message).join('; ')}`);
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
  await mk('thi (technician, DAY)', 'thi.nguyen@ridgeline.example', 'Thi Nguyen', 'E1004', [{ role: 'technician', facility: t.facilities.DAY! }]);
  const jordan = await mk('jordan (EHS reviewer, all facilities)', 'jordan.pike@ridgeline.example', 'Jordan Pike', null, [{ role: 'ehs_reviewer', facility: null }]);
  const alex = await mk('alex (operations manager, DAY + FTW)', 'alex.romero@ridgeline.example', 'Alex Romero', null,
    [{ role: 'operations_manager', facility: t.facilities.DAY! }, { role: 'operations_manager', facility: t.facilities.FTW! }]);
  const kim = await mk('kim (buyer, all facilities)', 'kim.tran@ridgeline.example', 'Kim Tran', null, [{ role: 'buyer', facility: null }]);
  const ana = await mk('ana (accounts payable clerk, all facilities)', 'ana.ruiz@ridgeline.example', 'Ana Ruiz', null, [{ role: 'ap_clerk', facility: null }]);
  const morgan = await mk('morgan (finance approver, all facilities)', 'morgan.lee@ridgeline.example', 'Morgan Lee', null, [{ role: 'finance_approver', facility: null }]);
  await mk('sam (quality reviewer, all facilities)', 'sam.okafor@ridgeline.example', 'Sam Okafor', null, [{ role: 'quality_reviewer', facility: null }]);
  await mk('tolu (operator, DAY)', 'tolu.adeyemi@ridgeline.example', 'Tolu Adeyemi', 'E1006', [{ role: 'operator', facility: t.facilities.DAY! }]);
  await mk('exec (executive, read-only, all facilities)', 'ceo@ridgeline.example', 'Pat Morgan', null, [{ role: 'executive', facility: null }]);

  const asset = async (tag: string) => (await db.query('SELECT id FROM asset WHERE tenant_id = $1 AND asset_tag = $2', [t.tenantId, tag])).rows[0].id as string;
  const part = async (pn: string) => (await db.query('SELECT id FROM part WHERE tenant_id = $1 AND part_number = $2', [t.tenantId, pn])).rows[0].id as string;
  const read = (f: string) => readFile(path.join(SAMPLES, 'documents', f));

  log('Ridgeline: storerooms and opening stock');
  const stores = await asActor(admin, async (tx) => ({
    day: await createLocation(tx, admin, { facilityId: t.facilities.DAY!, code: 'DAY-MAIN', name: 'Dayton main storeroom' }),
    ftw: await createLocation(tx, admin, { facilityId: t.facilities.FTW!, code: 'FTW-CRIB', name: 'Fort Wayne maintenance crib' }),
  }));
  // The storeroom export that created the parts list also carries on-hand and bin: load it again as opening stock.
  await runImport(admin, { file: 'ridgeline/03_storeroom_parts_export.csv', target: 'stock_balances', sourceSystem: 'storeroom-csv', profile: 'ridgeline/profiles/storeroom-stock.json', allowPartial: true });
  await asActor(admin, async (tx) => {
    // The export's compressor-oil row was rejected ("call for price"); the planner adds it by hand with the quoted price and receives the drums on hand.
    const oil = await createPart(tx, admin, { partNumber: 'CMP-OIL-ROTO', description: 'Roto-Inject Fluid NDURANCE, 20 L', uom: 'EA', manufacturer: 'Atlas Copco', unitCost: 312 });
    await receive(tx, admin, { locationId: stores.day.id, partId: oil.id, qty: 2, unitCost: 312, reference: 'Quote Q-8812' });
    const settings: [string, string, number, number][] = [
      [stores.day.id, 'BRG-6205-2RS', 10, 20], [stores.day.id, 'BLT-AX38', 6, 12], [stores.day.id, 'FLT-HYD-10', 4, 8], [stores.day.id, 'FTG-90-08', 20, 50],
      [stores.day.id, 'CMP-OIL-ROTO', 2, 4], [stores.day.id, 'SEAL-KIT-VF4', 1, 1], [stores.ftw.id, 'FLT-HYD-10', 2, 4],
    ];
    for (const [loc, pn, rp, rq] of settings) {
      const id = (await tx.query('SELECT id FROM part WHERE part_number = $1', [pn])).rows[0].id as string;
      await setStockSettings(tx, admin, loc, id, { reorderPoint: rp, reorderQty: rq });
    }
    await receive(tx, admin, { locationId: stores.ftw.id, partId: await part('FLT-HYD-10'), qty: 3, unitCost: 47.25, reference: 'PO-55120' });
    await receive(tx, admin, { locationId: stores.ftw.id, partId: await part('BLT-AX38'), qty: 4, unitCost: 14.2, reference: 'PO-55120' });
  });

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

  log('Ridgeline: qualifications, training matrix import, courses');
  const quals = await asActor(admin, async (tx) => ({
    loto: await createQualification(tx, admin, { code: 'LOTO', name: 'Lockout/Tagout authorized employee', validityMonths: 12, safetyCritical: true }),
    forklift: await createQualification(tx, admin, { code: 'FORKLIFT', name: 'Powered industrial truck operator', validityMonths: 36 }),
    nfpa: await createQualification(tx, admin, { code: 'NFPA70E', name: 'Arc flash / NFPA 70E qualified person', validityMonths: 36, safetyCritical: true }),
    rigging: await createQualification(tx, admin, { code: 'RIGGING', name: 'Crane & rigging', validityMonths: 60 }),
  }));
  await runImport(admin, { file: 'ridgeline/06_training_matrix.xlsx', target: 'qualification_records', sourceSystem: 'hr-training-matrix', profile: 'ridgeline/profiles/training-matrix.json', allowPartial: true });

  const videoDoc = await asActor(admin, async (tx) => {
    const d = await createDocument(tx, admin, { facilityId: t.facilities.DAY, docNumber: 'VID-HMC-201-SPN', title: 'HMC-201 spindle overview (training video)', docType: 'video', tags: ['spindle', 'training'] });
    const v = await addVersion(tx, admin, blobs, d.id, { versionLabel: '1', fileName: 'HMC-201_spindle_overview_video.txt', mimeType: 'text/plain', content: await read('HMC-201_spindle_overview_video.txt') });
    await approveVersion(tx, admin, v.id);
    await linkDocument(tx, admin, d.id, { entityType: 'asset', entityId: await asset('HMC-201'), linkRole: 'training' });
    return d;
  });
  const spindleQuiz = [
    { id: 'q1', prompt: 'Before opening the HMC-201 spindle housing you must…', type: 'single', options: ['Tell the operator', 'Apply lockout/tagout per SOP-LOTO-001', 'Run the warm-up program'], answer: [1] },
    { id: 'q2', prompt: 'Which point to spindle bearing wear? Select all that apply.', type: 'multi', options: ['Vibration rising with rpm', 'Coolant odor', 'Heat at the spindle nose', 'Noise with no tool loaded'], answer: [0, 2, 3] },
    { id: 'q3', prompt: 'Check tool-holder balance and drawbar pressure before suspecting bearings.', type: 'true_false', options: ['True', 'False'], answer: [0] },
    { id: 'q4', prompt: 'Matched-pair bearings (BRG-7014-ACD) can be mixed between pairs.', type: 'true_false', options: ['True', 'False'], answer: [1] },
  ];
  const spn = await asActor(marcus, async (tx) => {
    const c = await createCourse(tx, marcus, { facilityId: t.facilities.DAY, code: 'SPN-201', title: 'HMC-201 spindle diagnosis & bearing service', description: 'Qualifies technicians to work on the HMC-201 spindle.' });
    const v = await createCourseVersion(tx, marcus, c.id, { objectives: 'Diagnose spindle vibration and replace spindle bearings safely to OEM spec.', reviewDueOn: '2027-10-01' });
    const e = {
      video: await addLearningEvent(tx, marcus, v.id, { kind: 'video', title: 'Spindle construction overview', documentId: videoDoc.id, durationMinutes: 25 }),
      ilt: await addLearningEvent(tx, marcus, v.id, { kind: 'instructor_led', title: 'LOTO for machining centers (classroom)', documentId: docs.loto.doc.id, durationMinutes: 60 }),
      self: await addLearningEvent(tx, marcus, v.id, { kind: 'self_study', title: 'Read the spindle troubleshooting guide', documentId: docs.tsg.doc.id }),
      ojt: await addLearningEvent(tx, marcus, v.id, { kind: 'ojt_shadowing', title: 'Shadow a spindle diagnosis with a qualified technician', durationMinutes: 240 }),
      quiz: await addLearningEvent(tx, marcus, v.id, { kind: 'assessment', title: 'Knowledge check', assessment: { passingScore: 75, maxAttempts: 3, questions: spindleQuiz } }),
      practical: await addLearningEvent(tx, marcus, v.id, { kind: 'practical_evaluation', title: 'Observed spindle diagnosis on HMC-201' }),
    };
    await publishVersion(tx, marcus, v.id);
    return { course: c, version: v, e };
  });
  const lotoCourse = await asActor(admin, async (tx) => {
    const c = await createCourse(tx, admin, { facilityId: null, code: 'LOTO-101', title: 'Lockout/Tagout annual refresher' });
    const v = await createCourseVersion(tx, admin, c.id, { objectives: 'Apply SOP-LOTO-001 on every energized machine.' });
    await addLearningEvent(tx, admin, v.id, { kind: 'self_study', title: 'Read SOP-LOTO-001', documentId: docs.loto.doc.id });
    await addLearningEvent(tx, admin, v.id, { kind: 'practical_evaluation', title: 'Demonstrate lockout on a machining center' });
    await publishVersion(tx, admin, v.id);
    return c;
  });
  const spnQual = await asActor(admin, (tx) => createQualification(tx, admin, { code: 'SPN-HMC201', name: 'HMC-201 spindle service', validityMonths: 24, safetyCritical: true, requiresPractical: true, courseIds: [spn.course.id] }));
  await asActor(admin, async (tx) => {
    await tx.query('INSERT INTO qualification_course (tenant_id, qualification_id, course_id) VALUES ($1, $2, $3)', [t.tenantId, quals.loto.id, lotoCourse.id]);
    await setAssetRequirement(tx, admin, await asset('HMC-201'), spnQual.id, 'maintain');
    await setAssetRequirement(tx, admin, await asset('HMC-201'), quals.loto.id, 'maintain');
    await setAssetRequirement(tx, admin, await asset('FLT-07'), quals.forklift.id, 'operate');
  });
  // Priya completes the spindle course and is authorized; Thi is part-way through.
  const thi = await emp('E1004');
  const enr = await asActor(marcus, (tx) => assignTraining(tx, marcus, { courseId: spn.course.id, employeeIds: [priya.employeeId!, thi], dueOn: new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10) }));
  const [priyaEnr, thiEnr] = enr.enrollmentIds as [string, string];
  await asActor(priya, async (tx) => {
    await recordCompletion(tx, priya, priyaEnr, spn.e.video.id, {});
    await recordCompletion(tx, priya, priyaEnr, spn.e.self.id, {});
    await submitAttempt(tx, priya, priyaEnr, spn.e.quiz.id, { q1: [1], q2: [0, 2], q3: [0], q4: [0] }); // 50%: retakes
    await submitAttempt(tx, priya, priyaEnr, spn.e.quiz.id, { q1: [1], q2: [0, 2, 3], q3: [0], q4: [1] });
  });
  await asActor(marcus, async (tx) => {
    await recordCompletion(tx, marcus, priyaEnr, spn.e.ilt.id, {});
    await recordCompletion(tx, marcus, priyaEnr, spn.e.ojt.id, {});
    await recordCompletion(tx, marcus, priyaEnr, spn.e.practical.id, { outcome: 'passed', attestation: 'Ran vibration survey at 2k/6k/10k rpm, isolated tool-holder imbalance, explained bearing replacement steps and LOTO points correctly.' });
    const g = await grantQualification(tx, marcus, priya.employeeId!, spnQual.id, { note: 'Authorized after observed diagnosis on HMC-201' });
    await issueCertificate(tx, marcus, g.id);
    await recordCompletion(tx, marcus, thiEnr, spn.e.video.id, {});
    await recordCompletion(tx, marcus, thiEnr, spn.e.ilt.id, {});
  });
  await asActor(marcus, (tx) => assignTraining(tx, marcus, { courseId: lotoCourse.id, employeeIds: [marcus.employeeId!, thi], dueOn: new Date(Date.now() + 9 * 86_400_000).toISOString().slice(0, 10) }));
  // The troubleshooting guide is revised after people trained on Rev A: a training review opens.
  const tsgRevB = Buffer.concat([await read('HMC-201_spindle_vibration_troubleshooting.txt'), Buffer.from('\nRev B: record spindle temperature at each speed step.\n')]);
  const tsgB = await asActor(admin, (tx) => addVersion(tx, admin, blobs, docs.tsg.doc.id, { versionLabel: 'Rev B', fileName: 'HMC-201_spindle_vibration_troubleshooting.txt',
    mimeType: 'text/plain', content: tsgRevB, extractedText: tsgRevB.toString('utf8'), changeSummary: 'Add temperature reading at each speed step' }));
  await asActor(marcus, (tx) => approveVersion(tx, marcus, tsgB.id));

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
    await attachProcedure(tx, marcus, wo.id, tsgB.id);
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
    await addPart(tx, priya, wo2.id, { partId: await part('FTG-90-08'), qtyUsed: 2, locationId: stores.day.id });
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
    await addPart(tx, luis, wo5.id, { partId: await part('FLT-HYD-10'), qtyUsed: 1, locationId: stores.ftw.id });
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
  log('Ridgeline: preventive maintenance');
  const dayStr = (offset: number) => new Date(now + offset * 24 * HOUR).toISOString().slice(0, 10);
  // CNC-101 monthly service on a fixed schedule, with three cycles of history: on time, late, on time.
  const cncPm = await asActor(marcus, async (tx) => createPlan(tx, marcus, {
    assetId: await asset('CNC-101'), code: 'PM-CNC-101-M', title: 'CNC-101 monthly lubrication & way-wiper check', triggerType: 'calendar', intervalDays: 30,
    scheduleBasis: 'fixed', firstDueOn: dayStr(-75), leadDays: 5, estimatedHours: 1.5, priority: 3, documentId: docs.manual.doc.id,
    instructions: 'Check way-lube reservoir and pump cycle, clean and inspect way wipers, check spindle chiller level, grease ATC per manual §7.',
    parts: [{ partId: await part('BLT-AX38'), qty: 1 }],
  }));
  for (const doneOffset of [-76, -42, -16]) {
    await asActor(marcus, (tx) => generatePmWorkOrders(tx, marcus, { facilityId: t.facilities.DAY }));
    const woId = (await db.query(`SELECT id FROM work_order WHERE pm_plan_id = $1 AND status = 'planned'`, [cncPm.id])).rows[0].id as string;
    await asActor(marcus, (tx) => assignTechnician(tx, marcus, woId, priya.employeeId!, 'lead'));
    await asActor(priya, async (tx) => {
      await transitionWorkOrder(tx, priya, woId, { to: 'in_progress' });
      await addLabor(tx, priya, woId, { workDate: dayStr(doneOffset), hours: 1.25, hourlyRate: 46 });
      await addPart(tx, priya, woId, { partId: await part('BLT-AX38'), qtyUsed: 1, locationId: stores.day.id });
      await transitionWorkOrder(tx, priya, woId, { to: 'completed', findings: doneOffset === -42 ? 'Way wiper on Y- torn; replaced' : 'No findings' });
    });
    // History: the work was done on the day shown (the seed runs today, so the completion time is moved back).
    const doneAt = new Date(`${dayStr(doneOffset)}T15:00:00Z`);
    await db.query('UPDATE work_order SET started_at = $2, completed_at = $3, created_at = least(created_at, $2) WHERE id = $1', [woId, new Date(doneAt.getTime() - 2 * HOUR), doneAt]);
    await asActor(marcus, async (tx) => {
      await transitionWorkOrder(tx, marcus, woId, { to: 'verified', note: 'Checked lube cycle on the control' });
      await transitionWorkOrder(tx, marcus, woId, { to: 'closed' });
    });
  }
  // CMP-01 2000-hour service (meter based); the last service is in the legacy history import (L-24533).
  await asActor(marcus, async (tx) => {
    const cmp = await asset('CMP-01');
    for (const [offset, hours] of [[-60, 40480], [-30, 41120], [-14, 41470], [-1, 41820]] as const) {
      await recordMeter(tx, marcus, cmp, { meter: 'run_hours', value: hours, readAt: new Date(now + offset * 24 * HOUR) });
    }
    await createPlan(tx, marcus, {
      assetId: cmp, code: 'PM-CMP-01-2000H', title: 'CMP-01 2000 h oil, filter & separator service', triggerType: 'meter', meter: 'run_hours', intervalMeter: 2000,
      firstDueMeter: 41900, leadMeter: 150, estimatedHours: 4, priority: 2, documentId: docs.cmpProc.doc.id,
      parts: [{ partId: await part('CMP-OIL-ROTO'), qty: 3 }],
    });
    await createPlan(tx, marcus, {
      assetId: await asset('HMC-201'), code: 'PM-HMC-201-Q', title: 'HMC-201 quarterly coolant & hydraulic service', triggerType: 'calendar', intervalDays: 91,
      firstDueOn: dayStr(-4), estimatedHours: 3, parts: [{ partId: await part('FLT-HYD-10'), qty: 1 }],
    });
    await createPlan(tx, marcus, {
      assetId: await asset('EDM-301'), code: 'PM-EDM-301-M', title: 'EDM-301 monthly filter & resin check', triggerType: 'calendar', intervalDays: 30,
      firstDueOn: dayStr(12), estimatedHours: 1, parts: [{ partId: await part('WIRE-EDM-025'), qty: 1 }],
    });
  });
  await asActor(sean, async (tx) => {
    await createPlan(tx, sean, {
      assetId: await asset('PRS-01'), code: 'PM-PRS-01-W', title: 'PRS-01 weekly guarding & safety interlock check', triggerType: 'calendar', intervalDays: 7,
      leadDays: 2, firstDueOn: dayStr(1), estimatedHours: 0.5, priority: 2,
    });
    await createPlan(tx, sean, {
      assetId: await asset('CNC-501'), code: 'PM-CNC-501-6M', title: 'CNC-501 semiannual hydraulic service', triggerType: 'calendar', intervalDays: 182,
      firstDueOn: dayStr(20), estimatedHours: 3, parts: [{ partId: await part('FLT-HYD-10'), qty: 2 }, { partId: await part('BLT-AX38'), qty: 2 }],
    });
  });
  const dayGen = await asActor(marcus, (tx) => generatePmWorkOrders(tx, marcus, { facilityId: t.facilities.DAY }));
  const ftwGen = await asActor(sean, (tx) => generatePmWorkOrders(tx, sean, { facilityId: t.facilities.FTW }));
  log(`  PM work orders generated: ${[...dayGen.created, ...ftwGen.created].map((c) => `${c.workOrder} (${c.plan}, ${c.dueState})`).join(', ')}`);

  log('Ridgeline: purchasing');
  await runImport(kim, { file: 'ridgeline/07_accounting_vendor_list.csv', target: 'suppliers', sourceSystem: 'accounting-vendors', profile: 'ridgeline/profiles/accounting-vendors.json' });
  await runImport(kim, { file: 'ridgeline/08_supplier_price_list.xlsx', target: 'supplier_prices', sourceSystem: 'distributor-quote', profile: 'ridgeline/profiles/supplier-price-list.json', allowPartial: true });
  const signPending = async (subjectId: string, byRole: Record<string, Actor>) => {
    for (;;) {
      const steps = (await db.query(`SELECT s.id, s.role_key FROM approval_step s JOIN approval_request r ON r.id = s.request_id
        WHERE r.subject_id = $1 AND r.status = 'pending' AND s.status = 'pending'
          AND s.stage = (SELECT min(stage) FROM approval_step x WHERE x.request_id = r.id AND x.status = 'pending')`, [subjectId])).rows;
      if (!steps.length || !byRole[steps[0].role_key]) return;
      for (const st of steps) await asActor(byRole[st.role_key]!, (tx) => decideApproval(tx, byRole[st.role_key]!, st.id, { decision: 'approve', comment: null }));
    }
  };
  const supplierId = async (code: string) => (await db.query('SELECT id FROM supplier WHERE tenant_id = $1 AND code = $2', [t.tenantId, code])).rows[0].id as string;
  // 1. Replenishment from the reorder report, approved, ordered; one order received on time, one still open.
  const repl = await asActor(kim, (tx) => requestFromReorder(tx, kim, { facilityId: t.facilities.DAY! }));
  await asActor(kim, (tx) => submitPurchaseRequest(tx, kim, repl.id));
  await signPending(repl.id, { maintenance_manager: marcus, operations_manager: alex });
  const replOrders = await asActor(kim, (tx) => createOrdersFromRequest(tx, kim, repl.id, { notes: 'Per price agreement Q-2026-114' }));
  for (const o of replOrders.orders) {
    const full = await asActor(kim, (tx) => getOrder(tx, kim, o.id));
    if (full.supplier_code !== 'KOVAL') continue;
    await asActor(marcus, (tx) => receiveOrder(tx, marcus, o.id, { lines: full.lines.map((l: any) => ({ orderLineId: l.id, qty: Number(l.qty_ordered) })), packingSlip: 'KBT-55871' }));
  }
  // 2. OEM encoder for the PRS-01 work order on hold: two-stage approval (Fort Wayne manager, plant manager), ordered, now late.
  const prsWo = (await db.query(`SELECT id FROM work_order WHERE tenant_id = $1 AND title = 'Backgauge drifting on Y-axis'`, [t.tenantId])).rows[0].id as string;
  const enc = await asActor(luis, async (tx) => createPurchaseRequest(tx, luis, {
    facilityId: t.facilities.FTW!, title: 'Y-axis linear encoder for PRS-01 backgauge', workOrderId: prsWo, neededBy: dayStr(3),
    justification: 'Backgauge drifts 0.3 mm on Y; OEM confirmed encoder failure. Machine is limited to non-critical jobs until replaced.',
    lines: [{ description: 'Linear encoder, Y-axis backgauge, OEM part 44-1907', qty: 1, estUnitPrice: 3850, supplierId: await supplierId('RWPRESS') }],
  }));
  await asActor(luis, (tx) => submitPurchaseRequest(tx, luis, enc.id));
  await signPending(enc.id, { maintenance_manager: sean, operations_manager: alex });
  const encPo = (await asActor(kim, (tx) => createOrdersFromRequest(tx, kim, enc.id, { expectedOn: dayStr(-2), notes: 'Expedite: machine restricted' }))).orders[0]!;
  await db.query(`UPDATE purchase_order SET created_at = now() - interval '9 days' WHERE id = $1`, [encPo.id]);
  // 3. Capital request waiting on finance after maintenance and plant manager sign-off.
  const cap = await asActor(priya, async (tx) => createPurchaseRequest(tx, priya, {
    facilityId: t.facilities.DAY!, title: 'Spare spindle cartridge for HMC-201', spendType: 'capex', neededBy: dayStr(45),
    justification: 'HMC-201 is the only horizontal; a spindle failure means 6+ weeks down while the OEM rebuilds. A spare cuts that to 2 days.',
    lines: [{ description: 'Spindle cartridge, rebuilt, with 12-month warranty', qty: 1, estUnitPrice: 18500, supplierId: await supplierId('KOVAL') }],
  }));
  await asActor(priya, (tx) => submitPurchaseRequest(tx, priya, cap.id));
  await signPending(cap.id, { maintenance_manager: marcus, operations_manager: alex });
  // 4. A draft from a technician, not yet submitted.
  await asActor(priya, async (tx) => createPurchaseRequest(tx, priya, {
    facilityId: t.facilities.DAY!, title: 'Torque wrench for spindle work', lines: [{ description: 'Torque wrench 1/2" drive, 30-250 ft-lb', qty: 1, estUnitPrice: 189 }],
  }));

  log('Ridgeline: supplier invoices and accounting sync (MOCK accounting system)');
  const poOf = async (code: string, extra = '') => (await db.query(`SELECT o.id FROM purchase_order o JOIN supplier s ON s.id = o.supplier_id
    WHERE o.tenant_id = $1 AND s.code = $2 ${extra} ORDER BY o.created_at LIMIT 1`, [t.tenantId, code])).rows[0].id as string;
  const fromPo = async (poId: string, invoiceNumber: string, invoiceDate: string, extra: Record<string, unknown> = {}) => {
    const d = await asActor(ana, (tx) => invoiceDraftFromOrder(tx, ana, poId));
    return asActor(ana, (tx) => captureInvoice(tx, ana, blobs, { supplierId: d.supplier_id, purchaseOrderId: poId, invoiceNumber, invoiceDate,
      lines: d.lines.filter((l: any) => l.toInvoice > 0 || extra.billAhead).map((l: any) => ({ poLineId: l.po_line_id, qty: l.toInvoice || Number(l.received) || 1, unitPrice: l.unit_price })), ...extra }));
  };
  // 1. Koval: received order, invoiced with freight, approved, sent to accounting and paid there.
  const kovalInv = await fromPo(await poOf('KOVAL'), 'KBT-INV-20931', dayStr(-12), { freightAmount: 18.4 });
  await asActor(morgan, (tx) => approveInvoice(tx, morgan, kovalInv.id));
  // 2. Great Lakes: hose repair without a PO, 50 days old on Net 30, approved with an explanation, unpaid (overdue).
  const glfp = await supplierId('GREATLKS');
  const hose = await asActor(ana, (tx) => captureInvoice(tx, ana, blobs, { supplierId: glfp, facilityId: t.facilities.DAY!, invoiceNumber: '558120', invoiceDate: dayStr(-50),
    lines: [{ description: 'Emergency hydraulic hose rebuild, HMC-201 (on-site call)', qty: 1, unitPrice: 645 }], taxAmount: 0 }));
  await asActor(morgan, (tx) => approveInvoice(tx, morgan, hose.id, { varianceNote: 'Breakdown call-out authorized by Marcus by phone; no PO possible at 2 a.m.' }));
  // 3. Ridgeway billed the encoder before shipping it: waiting for approval with a mismatch.
  await fromPo(await poOf('RWPRESS'), 'RW-44190', dayStr(-1), { billAhead: true });
  // 4. Atlas: invoice for oil at a higher price than ordered, disputed.
  const atlas = await fromPo(await poOf('ATLASSVC'), 'ACS-90311', dayStr(-3), { billAhead: true });
  await asActor(morgan, (tx) => disputeInvoice(tx, morgan, atlas.id, 'Billed before delivery; asked Atlas to invoice on shipment.'));
  // Accounting connection: MOCK system (demo only) with a chart-of-accounts mapping; sync and a payment made "in accounting".
  await asActor(admin, async (tx) => {
    for (const [k, code, name] of [['inventory', '1400', 'Inventory - MRO spares'], ['maintenance_expense', '6200', 'Repairs & maintenance'],
      ['capital_projects', '1750', 'Construction in progress'], ['freight', '6210', 'Freight in'], ['sales_tax', '6220', 'Sales tax paid']]) {
      await setAccountMapping(tx, admin, k!, { externalCode: code!, externalName: name! });
    }
  });
  const conn = await asActor(admin, (tx) => createConnection(tx, admin, { provider: 'mock_accounting', backfill: 'all' }));
  await runSync(admin);
  const kovalBill = (await db.query(`SELECT external_id FROM mock_accounting_record WHERE connection_id = $1 AND payload->>'invoiceId' = $2`, [conn.id, kovalInv.id])).rows[0].external_id;
  await asActor(admin, (tx) => mockPayBill(tx, admin, conn.id, { externalId: kovalBill, paidOn: dayStr(-1) }));
  const sync = await runSync(admin);
  log(`  MOCK accounting: ${sync.payments} payment received back; connection is labeled as a mock`);

  log('Ridgeline: management of change');
  const NO = { affects_safety_systems: false, new_or_changed_chemical: false, changes_operating_limits: false, affects_controls_software: false,
    affects_product_quality: false, affects_environmental: false, requires_procedure_change: false, requires_training: false, affects_staffing: false };
  const signAll = async (changeId: string, purpose: string, byRole: Record<string, Actor>) => {
    for (;;) {
      const steps = (await db.query(`SELECT s.id, s.role_key FROM approval_step s JOIN approval_request r ON r.id = s.request_id
        WHERE r.subject_id = $1 AND r.purpose = $2 AND r.status = 'pending' AND s.status = 'pending'
          AND s.stage = (SELECT min(stage) FROM approval_step x WHERE x.request_id = r.id AND x.status = 'pending')`, [changeId, purpose])).rows;
      if (!steps.length) return;
      for (const st of steps) await asActor(byRole[st.role_key]!, (tx) => decideApproval(tx, byRole[st.role_key]!, st.id, { decision: 'approve', comment: 'Reviewed' }));
    }
  };
  // 1. High-risk change, authorized and mid-implementation.
  const spnCourseId = spn.course.id;
  const moc1 = await asActor(priya, async (tx) => createChange(tx, priya, {
    facilityId: t.facilities.DAY!, title: 'Raise HMC-201 spindle limit to 12,000 rpm for aluminum housings', changeType: 'equipment',
    description: 'Raise the programmed spindle speed limit (parameter) from 10,000 to 12,000 rpm on HMC-201 for the new aluminum housing family. Pallet 2 fixtures only.',
    justification: 'Cycle time on the housing family drops about 18% at 12k rpm; the OEM rates the spindle to 12k with balanced G2.5 holders.',
    targetDate: new Date(Date.now() + 21 * 86_400_000).toISOString().slice(0, 10),
    affected: [{ entityType: 'asset', entityId: await asset('HMC-201') }, { entityType: 'document', entityId: docs.tsg.doc.id }, { entityType: 'course', entityId: spnCourseId }],
  }));
  await asActor(priya, (tx) => submitForReview(tx, priya, moc1.id, { ...NO, changes_operating_limits: true, requires_procedure_change: true, requires_training: true }));
  await signAll(moc1.id, 'moc.authorize', { ehs_reviewer: jordan, maintenance_manager: marcus, operations_manager: alex });
  const moc1Actions = (await db.query(`SELECT id, kind FROM moc_action WHERE change_id = $1 AND status = 'open'`, [moc1.id])).rows;
  await asActor(marcus, (tx) => completeAction(tx, marcus, moc1Actions.find((a) => a.kind === 'hazard_review')!.id,
    { note: 'What-if review 10/20 with ops and maintenance: added holder balance check to the setup sheet; no other findings.' }));
  // 2. Temporary change in service, ending in 10 days.
  const until = new Date(Date.now() + 10 * 86_400_000).toISOString().slice(0, 10);
  const moc2 = await asActor(priya, async (tx) => createChange(tx, priya, { ownerUserId: marcus.userId,
    facilityId: t.facilities.DAY!, title: 'Portable chiller on CNC-104 while main chiller is repaired', changeType: 'equipment', isTemporary: true, temporaryUntil: until,
    description: 'Connect the rental portable chiller to the CNC-104 coolant loop with temporary hoses routed along the cell guard.',
    justification: 'Main chiller compressor failed; replacement parts are three weeks out and CNC-104 is the bottleneck lathe.',
    affected: [{ entityType: 'asset', entityId: await asset('CNC-104') }],
  }));
  await asActor(priya, (tx) => submitForReview(tx, priya, moc2.id, NO));
  await signAll(moc2.id, 'moc.authorize', { maintenance_manager: marcus, operations_manager: alex });
  for (const a of (await db.query(`SELECT id, kind FROM moc_action WHERE change_id = $1 AND status = 'open' AND required_before = 'startup'`, [moc2.id])).rows) {
    if (a.kind === 'work_order') await asActor(marcus, (tx) => cancelAction(tx, marcus, a.id, 'Installed by the rental company; their service ticket is attached to the change.'));
    else await asActor(marcus, (tx) => completeAction(tx, marcus, a.id, { note: 'Briefed 1st and 2nd shift at the CNC-104 cell; hose routing marked.' }));
  }
  await asActor(marcus, (tx) => requestStartup(tx, marcus, moc2.id));
  // 3. Chemical change waiting on safety review.
  const moc3 = await asActor(priya, async (tx) => createChange(tx, priya, {
    facilityId: t.facilities.DAY!, title: 'Switch Cell 1 coolant to a new synthetic concentrate', changeType: 'material',
    description: 'Replace the current synthetic concentrate on CNC-101 and CNC-102 with a lower-cost synthetic from a new vendor.',
    justification: 'Vendor quote is 12% lower per gallon; trial on scrap parts showed equal tool life.',
    affected: [{ entityType: 'asset', entityId: await asset('CNC-101') }, { entityType: 'asset', entityId: await asset('CNC-102') }, { entityType: 'part', entityId: await part('CLN-TRIM-5G') }],
  }));
  await asActor(priya, (tx) => submitForReview(tx, priya, moc3.id, { ...NO, new_or_changed_chemical: true, affects_environmental: true }));
  // 4. Draft at Fort Wayne.
  await asActor(sean, async (tx) => createChange(tx, sean, {
    facilityId: t.facilities.FTW!, title: 'Add a light curtain to PRS-01 press brake', changeType: 'equipment',
    description: 'Install a category 4 light curtain on the PRS-01 operator side and integrate it with the safety controller.',
    justification: 'Near-miss on 9/30: operator reached past the backgauge during the ram cycle.',
    affected: [{ entityType: 'asset', entityId: await asset('PRS-01') }],
  }));

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
