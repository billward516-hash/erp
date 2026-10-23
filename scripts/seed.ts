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
import { addVersion, approveVersion, createDocument, linkDocument, saveFolder } from '../src/modules/documents/service.js';
import { log, runImport, runImportContent } from './seed-lib.js';
import { createEmployee } from '../src/modules/org/service.js';
import { issueScar } from '../src/modules/purchasing/supplier-performance.js';
import { addReadAcross, addTeamMember, decideReadAcross } from '../src/modules/quality/eight-d.js';
import { postAnnouncement, saveQuickLink } from '../src/modules/intranet/service.js';
import { attachReceipt, createReport, markPaid, saveLine, submitReport } from '../src/modules/expenses/service.js';
import { approveBudget, createBudget, getBudget, proposeLines, setTarget, submitBudget } from '../src/modules/budgets/service.js';
import { acknowledgeHandbook, expenseRules, getPolicy, installTemplates, publishPolicy, saveDraft, saveExpenseCategory, saveExpensePolicy } from '../src/modules/policies/service.js';
import { decide as decideImp, markImplemented as implementedImp, measureResult as resultImp, planImprovement as planImp, setBaseline as baselineImp, submitIdea, validateSavings as validateImp } from '../src/modules/improve/service.js';
import { acknowledge as acknowledgeShift, getHandover as getShift, handOver as handOverShift, saveHandover as saveShift, startHandover as startShift } from '../src/modules/shift/service.js';
import { recordSubgroup as recordSpcSubgroup, saveCharacteristic as saveSpcCharacteristic, setLimits as setSpcLimits } from '../src/modules/spc/service.js';
import { activateForecast, saveScenario, saveWorkCenterCalendar } from '../src/modules/planning/service.js';
import { seedHarborview } from './seed-harborview.js';
import { seedNorthwindMarket } from './seed-northwind-market.js';
import { seedKessler } from './seed-kessler.js';
import { addLearningEvent, createCourse, createCourseVersion, publishVersion } from '../src/modules/learning/catalog.js';
import { createQualification, grantQualification, issueCertificate, setAssetRequirement } from '../src/modules/learning/qualifications.js';
import { assignTraining, recordCompletion, submitAttempt } from '../src/modules/learning/training.js';
import { decideApproval } from '../src/modules/approvals/service.js';
import { createProforma, submitProforma } from '../src/modules/proforma/service.js';
import { createArchive } from '../src/modules/archives/service.js';
import { cancelAction, completeAction, createChange, requestStartup, submitForReview } from '../src/modules/moc/service.js';
import { addLabor, addPart, assignTechnician, attachProcedure, createRequest, createWorkOrder, transitionWorkOrder } from '../src/modules/maintenance/service.js';
import { createLocation, receive, setStockSettings } from '../src/modules/inventory/service.js';
import { setTracking } from '../src/modules/inventory/lot-service.js';
import { createPart } from '../src/modules/parts/service.js';
import { createPlan, generatePmWorkOrders, recordMeter } from '../src/modules/pm/service.js';
import { requestFromReorder } from '../src/modules/purchasing/reorder.js';
import { approveInvoice, captureInvoice, disputeInvoice, invoiceDraftFromOrder } from '../src/modules/ap/service.js';
import { setAccountMapping } from '../src/modules/integrations/accounts.js';
import { createConnection, mockPayBill, runSync } from '../src/modules/integrations/service.js';
import { runReminders } from '../src/modules/notifications/reminders.js';
import { logActivity, saveOpportunity, updateCustomer } from '../src/modules/crm/service.js';
import { acceptQuote, createQuote, declineQuote, saveItem, sendQuote, setPromisedDate, shipOrder, submitQuote } from '../src/modules/sales/service.js';
import { draftInvoiceFromOrder, issueInvoice, logCollection, updateDraft } from '../src/modules/ar/service.js';
import {
  addAction, advanceCapa, closeNcr, completeAction as completeQAction, containNcr, createCapa, createNcr, dispositionNcr, holdLotsForNcr, updateCapa,
} from '../src/modules/quality/service.js';
import { classifyIncident, closeIncident, investigateIncident, reportIncident } from '../src/modules/safety/service.js';
import { recordCalibration, savePlan } from '../src/modules/quality/calibration.js';
import { saveTemplate, stageKit } from '../src/modules/materials/service.js';
import { createFmea, evaluateRow, getFmea, saveRows, submitFmea } from '../src/modules/quality/fmea.js';
import { createPlan as createBcp, getPlan as getBcp, recordExercise, saveContacts, savePlanBody, scheduleExercise, submitPlan as submitBcp } from '../src/modules/continuity/service.js';
import { addAction as addQAction } from '../src/modules/quality/service.js';
import { myApprovalQueue } from '../src/platform/approvals/engine.js';
import { createAudit, getAudit, recordItem, reportAudit, startAudit } from '../src/modules/quality/audits.js';
import { createAsset, updateAsset } from '../src/modules/assets/service.js';
import {
  closeOrder as closeMo, completeShort, createOrder as createMo, getOrder as getMo, issueMaterials, receiveOutput, releaseOrder as releaseMo, releaseRevision,
  saveRevision, saveWorkCenter, startOperation, stopOperation,
} from '../src/modules/production/service.js';
import { addEntry, createPayrollExport, decideTimesheet, getOrCreateTimesheet, submitTimesheet, weekStartOf, addDays as addDay } from '../src/modules/time/service.js';
import { createOrdersFromRequest, createPurchaseRequest, getOrder, receiveOrder, submitPurchaseRequest } from '../src/modules/purchasing/service.js';
import { saveSettings as savePerformanceSettings } from '../src/modules/performance/service.js';

if (process.env.NODE_ENV === 'production') throw new Error('refusing to seed a production database');

const SAMPLES = path.resolve('samples');
const blobs = new LocalBlobStore(config.storageDir);
const HOUR = 3_600_000;

/** Deterministic PRNG so every seed produces the same history shape. */
function rng(seed: number) {
  return () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
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
  const thiUser = await mk('thi (technician, DAY)', 'thi.nguyen@ridgeline.example', 'Thi Nguyen', 'E1004', [{ role: 'technician', facility: t.facilities.DAY! }]);
  const jordan = await mk('jordan (EHS reviewer, all facilities)', 'jordan.pike@ridgeline.example', 'Jordan Pike', null, [{ role: 'ehs_reviewer', facility: null }]);
  const alex = await mk('alex (operations manager, DAY + FTW)', 'alex.romero@ridgeline.example', 'Alex Romero', null,
    [{ role: 'operations_manager', facility: t.facilities.DAY! }, { role: 'operations_manager', facility: t.facilities.FTW! }]);
  const kim = await mk('kim (buyer, all facilities)', 'kim.tran@ridgeline.example', 'Kim Tran', null, [{ role: 'buyer', facility: null }]);
  const riley = await mk('riley (sales rep, all facilities)', 'riley.chen@ridgeline.example', 'Riley Chen', null, [{ role: 'sales_rep', facility: null }]);
  const taylor = await mk('taylor (sales manager, all facilities)', 'taylor.brooks@ridgeline.example', 'Taylor Brooks', null, [{ role: 'sales_manager', facility: null }]);
  const casey = await mk('casey (billing / receivables, all facilities)', 'casey.nguyen@ridgeline.example', 'Casey Nguyen', null, [{ role: 'ar_clerk', facility: null }]);
  const lena = await mk('lena (payroll administrator and HR, all facilities)', 'lena.park@ridgeline.example', 'Lena Park', null, [{ role: 'payroll_admin', facility: null }, { role: 'hr_manager', facility: null }]);
  const ana = await mk('ana (accounts payable clerk, all facilities)', 'ana.ruiz@ridgeline.example', 'Ana Ruiz', null, [{ role: 'ap_clerk', facility: null }]);
  const morgan = await mk('morgan (finance approver, all facilities)', 'morgan.lee@ridgeline.example', 'Morgan Lee', null, [{ role: 'finance_approver', facility: null }]);
  const sam = await mk('sam (quality reviewer, all facilities)', 'sam.okafor@ridgeline.example', 'Sam Okafor', null, [{ role: 'quality_reviewer', facility: null }]);
  // Carlos left in the payroll export (status T) and was rehired as production supervisor after it was taken.
  await db.query(`UPDATE employee SET status = 'active', job_title = 'Production Supervisor' WHERE tenant_id = $1 AND employee_number = 'E1008'`, [t.tenantId]);
  const carlos = await mk('carlos (production supervisor, DAY)', 'carlos.reyes@ridgeline.example', 'Carlos Reyes', 'E1008', [{ role: 'production_supervisor', facility: t.facilities.DAY! }]);
  const tolu = await mk('tolu (operator, DAY)', 'tolu.adeyemi@ridgeline.example', 'Tolu Adeyemi', 'E1006', [{ role: 'operator', facility: t.facilities.DAY! }]);
  await mk('exec (executive, read-only, all facilities)', 'ceo@ridgeline.example', 'Pat Morgan', null, [{ role: 'executive', facility: null }]);

  const asset = async (tag: string) => (await db.query('SELECT id FROM asset WHERE tenant_id = $1 AND asset_tag = $2', [t.tenantId, tag])).rows[0].id as string;
  const part = async (pn: string) => (await db.query('SELECT id FROM part WHERE tenant_id = $1 AND part_number = $2', [t.tenantId, pn])).rows[0].id as string;
  const read = (f: string) => readFile(path.join(SAMPLES, 'documents', f));

  log('Ridgeline: storerooms and opening stock');
  const stores = await asActor(admin, async (tx) => ({
    day: await createLocation(tx, admin, { facilityId: t.facilities.DAY!, code: 'DAY-MAIN', name: 'Dayton main storeroom' }),
    ftw: await createLocation(tx, admin, { facilityId: t.facilities.FTW!, code: 'FTW-CRIB', name: 'Fort Wayne maintenance crib' }),
    dayKit: await createLocation(tx, admin, { facilityId: t.facilities.DAY!, code: 'DAY-KIT', name: 'Dayton kit staging shelf', kind: 'staging' }),
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
  // Every document needs an approver other than its author (D-168): Dana authored, Marcus approves.
  for (const d of [docs.tsg, docs.loto, docs.manual, docs.cmpProc, docs.schematic]) await asActor(marcus, (tx) => approveVersion(tx, marcus, d.v.id));
  // The document server's other kinds (D-168): a work instruction, a test method in a folder only quality and
  // maintenance managers read, and a customer specification issued by Lakeshore Hydraulics.
  await asActor(admin, async (tx) => {
    const methods = await saveFolder(tx, admin, { name: 'Quality methods', readRoles: ['quality_manager', 'quality_reviewer', 'maintenance_manager', 'operations_manager'] });
    const wi = await createDocument(tx, admin, { facilityId: t.facilities.DAY, title: 'Deburr cross-drilled ports on HSG-100', docType: 'work_instruction', tags: ['deburr', 'hsg-100'] });
    const wiV = await addVersion(tx, admin, blobs, wi.id, { versionLabel: 'A', fileName: 'WI-deburr-HSG-100.txt', mimeType: 'text/plain',
      content: Buffer.from('1. Brush each cross-drilled port for 5 s.\n2. Inspect with the borescope.\n3. Blow out with filtered air.\n'), extractedText: 'deburr cross-drilled ports brush borescope' });
    const tm = await createDocument(tx, admin, { facilityId: t.facilities.DAY, title: 'Leak test at 6 bar (pressure decay)', docType: 'method', folderId: methods.id, tags: ['leak', 'test'] });
    const tmV = await addVersion(tx, admin, blobs, tm.id, { versionLabel: 'A', fileName: 'TM-leak-test.txt', mimeType: 'text/plain', content: Buffer.from('Fill to 6 bar, settle 10 s, measure decay over 20 s; reject above 2 Pa/s.\n') });
    const cs = await createDocument(tx, admin, { facilityId: null, title: 'Component cleanliness requirements', docType: 'customer_spec', issuer: 'Lakeshore Hydraulics', issuerDocNumber: 'LH-ES-104', tags: ['cleanliness', 'lakeshore'] });
    const csV = await addVersion(tx, admin, blobs, cs.id, { versionLabel: '1', fileName: 'LH-ES-104_revC.txt', mimeType: 'text/plain', issuerRevision: 'C', receivedOn: '2026-09-15',
      content: Buffer.from('Residual particulate below 2 mg per part; no particle larger than 600 µm (ISO 16232).\n') });
    return { wiV, tmV, csV };
  }).then(async (x) => {
    for (const v of [x.wiV, x.tmV, x.csV]) await asActor(marcus, (tx) => approveVersion(tx, marcus, v.id));
  });
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
    await approveVersion(tx, marcus, v.id);
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

  log('Ridgeline: 60 days of machine state history');
  const now = Date.now();
  const histStart = now - 60 * 24 * HOUR;
  // `before` scales the failure rate in the first 30 days, so the reliability report has a trend to show:
  // HMC-201's spindle is getting worse, PRS-01 improved after its hydraulic work.
  const profiles: Record<string, { downRate: number; idle: number; before?: number }> = {
    'CNC-101': { downRate: 0.02, idle: 0.2 }, 'CNC-102': { downRate: 0.01, idle: 0.3 }, 'CNC-104': { downRate: 0.12, idle: 0.2 },
    'HMC-201': { downRate: 0.2, idle: 0.15, before: 0.4 }, 'EDM-301': { downRate: 0.01, idle: 0.35 }, 'CMP-01': { downRate: 0.005, idle: 0 },
    'CNC-501': { downRate: 0.03, idle: 0.25 }, 'CNC-502': { downRate: 0.02, idle: 0.3 }, 'PRS-01': { downRate: 0.1, idle: 0.3, before: 1.8 },
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
        const down = at < now - 30 * 24 * HOUR ? p.downRate * (p.before ?? 1) : p.downRate;
        if (roll < down) { state = 'unplanned_downtime'; hours = 0.5 + r() * 5; reason = ['MECH', 'ELEC', 'HYD', 'TOOL'][Math.floor(r() * 4)]!; }
        else if (roll < down + 0.04) { state = 'planned_downtime'; hours = 1 + r() * 3; reason = r() < 0.5 ? 'PM' : 'SETUP'; }
        else if (roll < down + 0.04 + p.idle) { state = 'idle'; hours = 1 + r() * 6; }
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
  log(`  PM work orders generated: ${[...dayGen.created, ...ftwGen.created].map((c) => `${c.workOrder} (${c.plan}, ${c.dueState}${c.kit ? `, ${c.kit}` : ''})`).join(', ')}`);

  log('Ridgeline: spare parts lists, repair templates and kits');
  // The OEM recommended-spares spreadsheet goes through the importer (one superseded part and one unknown part are rejected).
  await runImport(admin, { file: 'ridgeline/11_oem_spares_list.csv', target: 'asset_parts', sourceSystem: 'oem-spares', allowPartial: true });
  await asActor(marcus, async (tx) => {
    await saveTemplate(tx, marcus, { code: 'VF-DRAWBAR-SEALS', title: 'Replace spindle drawbar seals (Haas VF)', assetId: await asset('CNC-101'), estLaborHours: 3,
      parts: [{ partId: await part('SEAL-KIT-VF4'), qty: 1 }] });
    await saveTemplate(tx, marcus, { code: 'HMC-PALLET-BRG', title: 'Replace pallet changer bearings', assetId: await asset('HMC-201'), estLaborHours: 6,
      parts: [{ partId: await part('BRG-6205-2RS'), qty: 4 }] });
  });
  // The first fully reserved PM kit at Dayton is staged on the kit shelf (a physical kit); the rest stay reserved in the storeroom.
  const dayKits = (await db.query(`SELECT k.id, k.number FROM kit k WHERE k.tenant_id = $1 AND k.facility_id = $2 AND k.status = 'reserved'
    AND NOT EXISTS (SELECT 1 FROM kit_line l WHERE l.kit_id = k.id AND l.qty_reserved < l.qty_needed) ORDER BY k.number`, [t.tenantId, t.facilities.DAY])).rows;
  if (dayKits[0]) await asActor(admin, (tx) => stageKit(tx, admin, dayKits[0].id, stores.dayKit.id));
  log(`  kits: ${dayKits.length} fully reserved at Dayton${dayKits[0] ? `, ${dayKits[0].number} staged on DAY-KIT` : ''}`);

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
      ['capital_projects', '1750', 'Construction in progress'], ['freight', '6210', 'Freight in'], ['sales_tax', '6220', 'Sales tax paid'],
      ['sales_revenue', '4000', 'Sales - machined parts'], ['service_revenue', '4100', 'Sales - engineering & services'], ['freight_income', '4900', 'Freight billed'],
      ['sales_tax_payable', '2200', 'Sales tax payable'], ['travel_expense', '6500', 'Travel'], ['meals_entertainment', '6510', 'Meals and entertainment'],
      ['supplies_expense', '6300', 'Office and shop supplies'], ['training_expense', '6520', 'Training and education'], ['telecom_expense', '6530', 'Telephone and internet'],
      ['other_expense', '6900', 'Other expenses'], ['employee_reimbursement', '2150', 'Employee reimbursements payable'], ['utilities_expense', '6600', 'Utilities'],
      ['contract_services', '6700', 'Contract services'], ['production_materials', '5100', 'Materials used']]) {
      await setAccountMapping(tx, admin, k!, { externalCode: code!, externalName: name! });
    }
  });
  const conn = await asActor(admin, (tx) => createConnection(tx, admin, { provider: 'mock_accounting', backfill: 'all' }));
  await runSync(admin);
  const kovalBill = (await db.query(`SELECT external_id FROM mock_accounting_record WHERE connection_id = $1 AND payload->>'invoiceId' = $2`, [conn.id, kovalInv.id])).rows[0].external_id;
  await asActor(admin, (tx) => mockPayBill(tx, admin, conn.id, { externalId: kovalBill, paidOn: dayStr(-1) }));
  const sync = await runSync(admin);
  log(`  MOCK accounting: ${sync.payments} payment received back; connection is labeled as a mock`);

  log('Ridgeline: timesheets and payroll export');
  const thisWeek = weekStartOf(today);
  const W1 = addDay(thisWeek, -7);
  const W0 = addDay(thisWeek, -14);
  // Routine work orders in the past two weeks, so timesheets and wrench time reflect real work-order hours.
  const routine: [Actor, Actor, string, string, number[]][] = [
    [priya, marcus, 'CNC-102', 'Way lube pump replacement and coolant tank clean-out', [4, 5.5, 3, 4.5, 2]],
    [thiUser, marcus, 'EDM-301', 'Power supply fan and filter replacement; panel thermography', [3, 2.5, 5, 0, 4]],
    [luis, sean, 'CNC-502', 'Turret indexing alarm and tool-setter recalibration', [5, 4, 3.5, 4, 3]],
  ];
  for (const [week, label] of [[W0, 'week 1'], [W1, 'week 2']] as const) {
    for (const [tech, mgr, tag, title, hours] of routine) {
      const wo = await asActor(mgr, async (tx) => {
        const o = await createWorkOrder(tx, mgr, { assetId: await asset(tag), title: `${title} (${label})`, woType: 'inspection', priority: 3, dueAt: `${addDay(week, 4)}T21:00:00Z` });
        await assignTechnician(tx, mgr, o.id, tech.employeeId!, 'lead');
        return o;
      });
      await asActor(tech, async (tx) => {
        await transitionWorkOrder(tx, tech, wo.id, { to: 'in_progress' });
        for (const [d, h] of hours.entries()) if (h) await addLabor(tx, tech, wo.id, { workDate: addDay(week, d), hours: h, hourlyRate: 44 });
        await transitionWorkOrder(tx, tech, wo.id, { to: 'completed', findings: 'Done; no further defects found' });
      });
      await db.query('UPDATE work_order SET created_at = $2, started_at = $2, completed_at = $3 WHERE id = $1', [wo.id, `${week}T12:00:00Z`, `${addDay(week, 4)}T20:00:00Z`]);
      await asActor(mgr, async (tx) => {
        await transitionWorkOrder(tx, mgr, wo.id, { to: 'verified' });
        await transitionWorkOrder(tx, mgr, wo.id, { to: 'closed' });
      });
    }
  }
  /** Fills a normal week: 8 h a weekday, regular time around whatever is already booked to work orders. */
  const fillWeek = async (who: Actor, employeeNumber: string, week: string, opts: { leaveDay?: number; extra?: number; extraNote?: string; submit?: boolean } = {}) => {
    const e = await emp(employeeNumber);
    return asActor(who, async (tx) => {
      const ts = await getOrCreateTimesheet(tx, who, { employeeId: e, weekStart: week });
      for (let d = 0; d < 5; d++) {
        const date = addDay(week, d);
        if (date > today) break;
        if (d === opts.leaveDay) { await addEntry(tx, who, ts.id, { workDate: date, earningCode: 'PTO', hours: 8 }); continue; }
        const wo = Number((await tx.query('SELECT coalesce(sum(hours), 0) AS h FROM work_order_labor WHERE employee_id = $1 AND work_date = $2', [e, date])).rows[0].h);
        const reg = 8 - wo + (d === 4 ? (opts.extra ?? 0) : 0);
        if (reg > 0) await addEntry(tx, who, ts.id, { workDate: date, earningCode: 'REG', hours: reg, note: d === 4 && opts.extra ? opts.extraNote ?? 'Stayed for compressor alarm' : null });
      }
      if (opts.submit !== false) await submitTimesheet(tx, who, ts.id);
      return ts.id as string;
    });
  };
  const approve = (who: Actor, id: string) => asActor(who, (tx) => decideTimesheet(tx, who, id, { decision: 'approve' }));
  // Two weeks ago: everyone submitted and approved, then exported to payroll.
  for (const [who, num, approver] of [[priya, 'E1001', marcus], [thiUser, 'E1004', marcus], [tolu, 'E1006', marcus], [luis, 'E1002', sean], [marcus, 'E1003', alex], [sean, 'E1005', alex]] as const) {
    await approve(approver, await fillWeek(who, num, W0, { leaveDay: num === 'E1004' ? 2 : undefined }));
  }
  await approve(marcus, await fillWeek(alex, 'E1009', W0)); // operations director's paper timecard, entered by Alex
  await asActor(lena, (tx) => createPayrollExport(tx, lena, { from: W0, to: W0, layout: 'summary' }));
  // Last week: a mix of states for the supervisor views.
  await approve(marcus, await fillWeek(thiUser, 'E1004', W1));
  await approve(alex, await fillWeek(marcus, 'E1003', W1, { extra: 6 }));
  await fillWeek(priya, 'E1001', W1, { extra: 1 });                                   // submitted, waiting for Marcus
  const luisW1 = await fillWeek(luis, 'E1002', W1);
  await asActor(sean, (tx) => decideTimesheet(tx, sean, luisW1, { decision: 'reject', comment: 'Thursday shows 8 h but you were at the Gates belt training; code 4 h to training (REG, note it)' }));
  // This week: drafts in progress (work-order hours appear automatically).
  await fillWeek(priya, 'E1001', thisWeek, { submit: false });

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
    // ISO 9001 6.3 planning (D-158)
    consequences: 'Higher spindle load and heat; risk of tool or holder failure if an unbalanced holder is used; housing bore finish may change.',
    qmsImpact: 'HMC-201 setup sheet and troubleshooting guide revised; spindle course updated; PPAP not affected (same dimensions and process).',
    resources: 'Balanced G2.5 holders on hand (6); programmer 4 h; no capital needed.',
    responsibilities: 'Priya Shah owns the change; Marcus Kowalski authorizes setup sheet changes; operators trained by the trainer before use.',
    customerImpact: 'notify', customerNote: 'Lakeshore Hydraulics: tell their buyer the housing cycle time improves; no fit, form or function change.',
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
    origin: 'emergency',
    consequences: 'Coolant temperature may run warmer than the main chiller holds; trip hazard from hoses; leaks onto the floor.',
    qmsImpact: 'Temporary only: no document changes; the coolant temperature check is added to the shift log until removal.',
    resources: 'Rental chiller and hoses (rented for 4 weeks); maintenance 3 h to connect and 2 h to remove.',
    responsibilities: 'Marcus Kowalski owns the change and its removal; shift leads check temperature each shift.',
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
    consequences: 'Different chemistry: skin sensitisation, waste treatment and residue on parts may change; tool life may differ.',
    qmsImpact: 'Approved materials list, safety data sheet file and the coolant concentration check change.',
    resources: 'Trial quantity from the vendor; EHS review of the safety data sheet; disposal quote for the old concentrate.',
    responsibilities: 'Priya Shah owns the trial; the EHS reviewer approves the safety data sheet; purchasing changes the approved supplier.',
  }));
  await asActor(priya, (tx) => submitForReview(tx, priya, moc3.id, { ...NO, new_or_changed_chemical: true, affects_environmental: true }));
  // 4. Draft at Fort Wayne.
  await asActor(sean, async (tx) => createChange(tx, sean, {
    facilityId: t.facilities.FTW!, title: 'Add a light curtain to PRS-01 press brake', changeType: 'equipment',
    description: 'Install a category 4 light curtain on the PRS-01 operator side and integrate it with the safety controller.',
    justification: 'Near-miss on 9/30: operator reached past the backgauge during the ram cycle.',
    affected: [{ entityType: 'asset', entityId: await asset('PRS-01') }],
  }));

  log('Ridgeline: customers, quotes and orders');
  await runImport(riley, { file: 'ridgeline/09_crm_company_export.csv', target: 'customers', sourceSystem: 'crm-companies', profile: 'ridgeline/profiles/crm-company-export.json' });
  const cust = async (code: string) => (await db.query('SELECT id FROM customer WHERE tenant_id = $1 AND code = $2', [t.tenantId, code])).rows[0].id as string;
  const contactOf = async (customerId: string) => (await db.query('SELECT id FROM contact WHERE customer_id = $1 AND is_primary', [customerId])).rows[0]?.id as string | undefined;
  // Finished goods: machined housings for a hydraulics customer ship from a finished-goods storeroom.
  const fg = await asActor(admin, async (tx) => {
    const loc = await createLocation(tx, admin, { facilityId: t.facilities.DAY!, code: 'DAY-FG', name: 'Dayton finished goods' });
    const p = await createPart(tx, admin, { partNumber: 'HSG-220', description: 'Valve housing AH-220, 6061-T6, machined', uom: 'EA' });
    await receive(tx, admin, { locationId: loc.id, partId: p.id, qty: 100, unitCost: 41, reference: 'Production lot 2610-14' });
    return { loc, p };
  });
  const items = await asActor(admin, async (tx) => ({
    hsg: await saveItem(tx, admin, { code: 'HSG-220', description: 'Valve housing AH-220, 6061-T6, machined to drawing rev C', listPrice: 68, unitCost: 41, partId: fg.p.id }),
    proto: await saveItem(tx, admin, { code: 'PROTO-RUN', description: 'Prototype run: programming, first article and inspection report', kind: 'service', uom: 'LOT', listPrice: 2400, unitCost: 1350 }),
    mach: await saveItem(tx, admin, { code: 'MACH-5AX', description: '5-axis machining time', kind: 'service', uom: 'HR', listPrice: 145, unitCost: 82 }),
    rebuild: await saveItem(tx, admin, { code: 'SVC-SPINDLE', description: 'Spindle rebuild service (customer machine)', kind: 'service', uom: 'EA', listPrice: 6800, unitCost: 4300 }),
  }));
  const mvh = await cust('C-80114'); const bmd = await cust('C-80127'); const lsr = await cust('C-80131'); const tca = await cust('C-80142'); const gma = await cust('C-80155');
  const opps = await asActor(riley, async (tx) => ({
    mvh: await saveOpportunity(tx, riley, { customerId: mvh, title: 'AH-220 housings, Q4 release', stage: 'negotiation', amount: 16000, expectedClose: dayStr(10), source: 'Existing customer' }),
    bmd: await saveOpportunity(tx, riley, { customerId: bmd, title: 'Surgical handle prototype', stage: 'qualified', amount: 9000, expectedClose: dayStr(30), source: 'Trade show' }),
    gma: await saveOpportunity(tx, riley, { customerId: gma, title: 'Bracket family, AS9100 supplier add', stage: 'proposal', amount: 42000, expectedClose: dayStr(45), source: 'Referral' }),
    lsr: await saveOpportunity(tx, riley, { customerId: lsr, title: 'Gripper fingers', stage: 'lead', amount: 6000, expectedClose: dayStr(60), source: 'Website' }),
    tca: await saveOpportunity(tx, riley, { customerId: tca, title: 'Spindle rebuild for their VMC', stage: 'proposal', amount: 6800, source: 'Existing customer' }),
  }));
  await asActor(riley, async (tx) => {
    await logActivity(tx, riley, { customerId: mvh, opportunityId: opps.mvh.id, kind: 'call', summary: 'Grace confirmed 200 pcs for November, wants 120 shipped by the 20th.' });
    await logActivity(tx, riley, { customerId: gma, opportunityId: opps.gma.id, kind: 'meeting', summary: 'Plant tour with Priyanka; she wants our AS9100 certificate and a capability study.' });
    await logActivity(tx, riley, { customerId: gma, opportunityId: opps.gma.id, kind: 'task', summary: 'Send AS9100 certificate and Cpk study for the bracket family', dueOn: dayStr(-2) });
    await logActivity(tx, riley, { customerId: bmd, opportunityId: opps.bmd.id, kind: 'task', summary: 'Book a call to review the handle drawing', dueOn: dayStr(3) });
  });
  // 1. Housings: quoted, sent, accepted; 120 shipped from finished goods, the rest promised for last week (now late).
  const q1 = await asActor(riley, async (tx) => createQuote(tx, riley, { facilityId: t.facilities.DAY!, customerId: mvh, contactId: await contactOf(mvh), opportunityId: opps.mvh.id,
    title: 'AH-220 valve housings, 200 pcs', lines: [{ itemId: items.hsg.id, qty: 200, unitPrice: 64 }, { itemId: items.mach.id, qty: 8, description: 'Fixture rework for rev C' }] }));
  await asActor(riley, async (tx) => { await submitQuote(tx, riley, q1.id); await sendQuote(tx, riley, blobs, q1.id, {}); });
  const so1 = await asActor(riley, (tx) => acceptQuote(tx, riley, q1.id, { customerPo: 'MVH-PO-55120', requestedDate: dayStr(-5) }));
  const so1Lines = (await db.query('SELECT id, line_no FROM sales_order_line WHERE order_id = $1 ORDER BY line_no', [so1.id])).rows;
  await asActor(admin, async (tx) => {
    await setPromisedDate(tx, admin, so1.id, dayStr(-2));
    await shipOrder(tx, admin, so1.id, { shippedOn: dayStr(-4), carrier: 'R+L Carriers', tracking: 'RL-88213004', lines: [{ orderLineId: so1Lines[0].id, qty: 60, locationId: fg.loc.id }, { orderLineId: so1Lines[1].id, qty: 8 }] });
  });
  // 2. Aerospace brackets: 22% off list to win the supplier add → waiting on the sales manager.
  const q2 = await asActor(riley, async (tx) => createQuote(tx, riley, { facilityId: t.facilities.DAY!, customerId: gma, contactId: await contactOf(gma), opportunityId: opps.gma.id,
    title: 'Bracket family BR-10/12/14, first-year volumes', lines: [{ itemId: items.mach.id, qty: 260, unitPrice: 113 }, { itemId: items.proto.id, qty: 1, unitPrice: 2400 }],
    notes: 'Pricing assumes material supplied at our cost plus 8%. First-article inspection to AS9102 included.' }));
  await asActor(riley, (tx) => submitQuote(tx, riley, q2.id));
  // 3. Spindle rebuild: sent, waiting on the customer, expires in 5 days.
  const q3 = await asActor(riley, async (tx) => createQuote(tx, riley, { facilityId: t.facilities.DAY!, customerId: tca, contactId: await contactOf(tca), opportunityId: opps.tca.id,
    title: 'Spindle rebuild, Haas VF-2', validUntil: dayStr(5), lines: [{ itemId: items.rebuild.id, qty: 1 }] }));
  await asActor(riley, async (tx) => { await submitQuote(tx, riley, q3.id); await sendQuote(tx, riley, blobs, q3.id, {}); });
  // 4. Robotics: declined on lead time.
  const q4 = await asActor(riley, async (tx) => createQuote(tx, riley, { facilityId: t.facilities.DAY!, customerId: lsr, opportunityId: opps.lsr.id, title: 'Gripper fingers, 40 sets',
    lines: [{ itemId: items.mach.id, qty: 36 }] }));
  await asActor(riley, async (tx) => { await submitQuote(tx, riley, q4.id); await sendQuote(tx, riley, blobs, q4.id, {}); await declineQuote(tx, riley, q4.id, 'Needed in 2 weeks; our lead time was 5 weeks'); });
  void taylor;

  log('Ridgeline: customer invoices, payments, collections and credit hold');
  const shipAll = async (orderId: string, shippedOn: string) => {
    const lines = (await db.query('SELECT id, qty FROM sales_order_line WHERE order_id = $1', [orderId])).rows;
    await asActor(admin, (tx) => shipOrder(tx, admin, orderId, { shippedOn, lines: lines.map((l) => ({ orderLineId: l.id, qty: Number(l.qty) })) }));
  };
  const sold = async (customerId: string, title: string, lines: any[], customerPo: string) => {
    const q = await asActor(riley, async (tx) => createQuote(tx, riley, { facilityId: t.facilities.DAY!, customerId, contactId: await contactOf(customerId), title, lines }));
    await asActor(riley, async (tx) => { await submitQuote(tx, riley, q.id); await sendQuote(tx, riley, blobs, q.id, {}); });
    return asActor(riley, (tx) => acceptQuote(tx, riley, q.id, { customerPo }));
  };
  const invoiceOrder = async (orderId: string, invoiceDate: string, extra: { freightAmount?: number; notes?: string } = {}) => asActor(casey, async (tx) => {
    const d = await draftInvoiceFromOrder(tx, casey, orderId);
    if (extra.freightAmount || extra.notes) await updateDraft(tx, casey, d.id, extra);
    await issueInvoice(tx, casey, blobs, d.id, { invoiceDate });
    return d.id as string;
  });
  // 1. The housings shipped so far are invoiced with freight; due in about four weeks.
  await invoiceOrder(so1.id, dayStr(-3), { freightAmount: 145, notes: 'Partial shipment: 60 of 200 housings. Balance to follow.' });
  // 2. Buckeye's prototype run, invoiced 52 days ago on Net 45: overdue, with a promise to pay.
  const proto = await sold(bmd, 'Handle prototype, first article', [{ itemId: items.proto.id, qty: 1 }, { itemId: items.mach.id, qty: 12 }], 'BMD-7731');
  await shipAll(proto.id, dayStr(-53));
  const protoInv = await invoiceOrder(proto.id, dayStr(-52));
  await asActor(casey, (tx) => logCollection(tx, casey, { customerId: bmd, invoiceId: protoInv, summary: 'Accounts payable says the invoice was routed to engineering for approval; will pay on next check run.', promiseDate: dayStr(3) }));
  // 3. Lakeshore's machining job, 75 days old: partly paid in accounting, the rest well overdue, no contact yet.
  const grip = await sold(lsr, 'Gripper finger sample batch', [{ itemId: items.mach.id, qty: 20 }], 'LR-2290');
  await shipAll(grip.id, dayStr(-76));
  const gripInv = await invoiceOrder(grip.id, dayStr(-75));
  // 4. Tri-County has a 5,000 credit limit; a 7,250 order goes on credit hold.
  await asActor(riley, (tx) => updateCustomer(tx, riley, tca, { creditLimit: 5000 }));
  await sold(tca, 'Spare spindle cartridge machining', [{ itemId: items.mach.id, qty: 50 }], 'TCA-1182');
  // Issued invoices go to the MOCK accounting system; Lakeshore paid 1,200 there.
  await runSync(admin);
  const gripRec = (await db.query(`SELECT external_id FROM mock_accounting_record WHERE connection_id = $1 AND payload->>'invoiceId' = $2`, [conn.id, gripInv])).rows[0].external_id;
  await asActor(admin, (tx) => mockPayBill(tx, admin, conn.id, { externalId: gripRec, paidOn: dayStr(-20), amount: 1200 }));
  const arSync = await runSync(admin);
  log(`  3 invoices issued and sent to MOCK accounting; ${arSync.payments} customer payment received back; Tri-County order on credit hold`);

  log('Ridgeline: production (work centers, BOM import, routings, shop floor)');
  const dayton = t.facilities.DAY!;
  const rmLoc = await asActor(admin, async (tx) => {
    const loc = await createLocation(tx, admin, { facilityId: dayton, code: 'DAY-RM', name: 'Dayton raw material' });
    for (const [pn, desc, uom, qty, cost] of [['BAR-6061-250', 'Round bar 2.50 in, 6061-T6', 'IN', 1200, 0.42], ['ORING-2-214', 'O-ring 2-214, Viton 75', 'EA', 300, 0.38],
      ['PLUG-SAE-6', 'Plug SAE-6 hex, steel zinc', 'EA', 60, 1.15], ['TAG-SER-01', 'Serial tag, anodized', 'EA', 500, 0.22], ['KIT-AH220-SEAL', 'Seal kit AH-220 (assembled in house)', 'EA', 120, 1.95],
      ['BOX-HSG-4', 'Carton, 4 housings', 'EA', 0, 0]] as const) {
      const p = await createPart(tx, admin, { partNumber: pn, description: desc, uom });
      if (qty) await receive(tx, admin, { locationId: loc.id, partId: p.id, qty, unitCost: cost, reference: 'Opening stock' });
    }
    return loc;
  });
  // The legacy ERP's indented BOM goes through the importer (two rows are rejected with reasons) and lands as drafts.
  await runImport(carlos, { file: 'ridgeline/10_engineering_bom_indented.csv', target: 'boms', sourceSystem: 'legacy-erp', allowPartial: true });
  const wc = await asActor(carlos, async (tx) => ({
    lathe: (await saveWorkCenter(tx, carlos, { facilityId: dayton, code: 'LATHE', name: 'CNC turning', assetIds: [await asset('CNC-104')] })).id,
    vmc: (await saveWorkCenter(tx, carlos, { facilityId: dayton, code: 'VMC', name: 'Vertical machining', assetIds: [await asset('CNC-101'), await asset('CNC-102')] })).id,
    assy: (await saveWorkCenter(tx, carlos, { facilityId: dayton, code: 'DEBURR', name: 'Deburr, wash and assemble' })).id,
    insp: (await saveWorkCenter(tx, carlos, { facilityId: dayton, code: 'INSPECT', name: 'Final inspection (CMM)', assetIds: [await asset('CMM-01')] })).id,
  }));
  await asActor(admin, async (tx) => {
    const q = await createQualification(tx, admin, { code: 'CMM-OP', name: 'CMM operator (Calypso programs)', validityMonths: 24 });
    await setAssetRequirement(tx, admin, await asset('CMM-01'), q.id, 'operate');
    await grantQualification(tx, admin, tolu.employeeId!, q.id, { note: 'Zeiss operator course, 2025' });
  });
  const draftOf = async (pn: string) => (await db.query(`SELECT r.id FROM product_revision r JOIN part p ON p.id = r.part_id WHERE p.tenant_id = $1 AND p.part_number = $2 AND r.status = 'draft'`, [t.tenantId, pn])).rows[0].id as string;
  const materialsOf = async (revId: string) => (await db.query('SELECT part_id, qty_per::float AS qty_per, scrap_pct::float AS scrap_pct FROM product_material WHERE revision_id = $1 ORDER BY line_no', [revId])).rows
    .map((m: any) => ({ partId: m.part_id, qtyPer: m.qty_per, scrapPct: m.scrap_pct }));
  await asActor(carlos, async (tx) => {
    const kit = await draftOf('KIT-AH220-SEAL');
    await saveRevision(tx, carlos, kit, { materials: await materialsOf(kit), operations: [{ opNo: 10, workCenterId: wc.assy, description: 'Bag O-rings and plug, label', runMinutesPerUnit: 0.8 }] });
    await releaseRevision(tx, carlos, kit);
    const hsg = await draftOf('HSG-220');
    const mats = await materialsOf(hsg);
    await saveRevision(tx, carlos, hsg, { notes: 'Rev C drawing. Routing added after import; carton line rejected by the importer (unit error) is left off.', materials: mats, operations: [
      { opNo: 10, workCenterId: wc.lathe, description: 'Face, turn OD and bore from bar', setupMinutes: 40, runMinutesPerUnit: 5.5 },
      { opNo: 20, workCenterId: wc.vmc, description: 'Mill ports and drill cross holes (fixture rev C)', setupMinutes: 60, runMinutesPerUnit: 8 },
      { opNo: 30, workCenterId: wc.assy, description: 'Deburr, wash, install seal kit and serial tag', runMinutesPerUnit: 3 },
      { opNo: 40, workCenterId: wc.insp, description: 'CMM inspection, 1 in 5 full layout', runMinutesPerUnit: 2.5 },
    ] });
    await releaseRevision(tx, carlos, hsg);
  });
  // Shop-floor runs recorded after the fact (back-dated, so machine states are not rewritten).
  const at = (daysAgo: number, h: number, m = 0) => { const d = new Date(Date.now() - daysAgo * 86_400_000); d.setUTCHours(h, m, 0, 0); return d; };
  const run = async (orderId: string, opNo: number, who: Actor, assetTag: string | null, from: Date, to: Date, q: { qtyGood?: number; qtyScrap?: number; qtyRework?: number; scrapReason?: string; note?: string }, kind: 'run' | 'setup' = 'run') => {
    const op = (await asActor(carlos, (tx) => getMo(tx, carlos, orderId))).operations.find((o: any) => o.op_no === opNo);
    const e = await asActor(carlos, async (tx) => startOperation(tx, carlos, op.id, { employeeId: who.employeeId, assetId: assetTag ? await asset(assetTag) : null, at: from, kind }));
    await asActor(carlos, (tx) => stopOperation(tx, carlos, e.id, { ...q, at: to }));
  };
  const issueAll = async (orderId: string) => {
    const mo = await asActor(carlos, (tx) => getMo(tx, carlos, orderId));
    const lines = mo.materials.filter((m: any) => m.remaining > 0 && m.stock.length).map((m: any) => ({ materialId: m.id, locationId: m.stock[0].location_id, qty: Math.min(m.remaining, m.stock[0].on_hand) }));
    if (lines.length) await asActor(carlos, (tx) => issueMaterials(tx, carlos, orderId, lines));
  };
  // 1. Last month's batch of 50 housings: closed, with scrap and rework on record.
  const mo1 = await asActor(carlos, (tx) => createMo(tx, carlos, { facilityId: dayton, partId: fg.p.id, qty: 50, dueDate: dayStr(-18), outputLocationId: fg.loc.id }));
  await asActor(carlos, (tx) => releaseMo(tx, carlos, mo1.id));
  await issueAll(mo1.id);
  await run(mo1.id, 10, carlos, 'CNC-104', at(24, 12), at(24, 12, 40), { qtyScrap: 1, scrapReason: 'SETUP', note: 'First piece used for bore setting' }, 'setup');
  await run(mo1.id, 10, tolu, 'CNC-104', at(24, 13), at(24, 17, 50), { qtyGood: 47, qtyScrap: 2, scrapReason: 'DIM', note: 'Bore 0.02 over on two parts; insert changed' });
  await run(mo1.id, 20, tolu, 'CNC-101', at(23, 12), at(23, 20, 10), { qtyGood: 46, qtyScrap: 1, scrapReason: 'MACH', note: 'Spindle alarm mid-cycle' });
  await run(mo1.id, 30, carlos, null, at(22, 12), at(22, 14, 45), { qtyGood: 46, qtyRework: 4, note: 'Four ports re-deburred after wash' });
  await run(mo1.id, 40, tolu, 'CMM-01', at(22, 15), at(22, 17), { qtyGood: 45, qtyScrap: 1, scrapReason: 'SURF', note: 'Sealing face scratch' });
  await asActor(carlos, (tx) => receiveOutput(tx, carlos, mo1.id, { qty: 45 }));
  await asActor(carlos, async (tx) => { await completeShort(tx, carlos, mo1.id, '5 scrapped across operations; shortfall covered from stock'); await closeMo(tx, carlos, mo1.id); });
  // 2. Housings for Miami Valley's late order: turning done, milling running now on CNC-101, deburr waiting; plugs are short.
  const so1Line = so1Lines[0].id;
  const mo2 = await asActor(carlos, (tx) => createMo(tx, carlos, { facilityId: dayton, partId: fg.p.id, qty: 80, dueDate: dayStr(2), outputLocationId: fg.loc.id, salesOrderLineId: so1Line }));
  const rel = await asActor(carlos, (tx) => releaseMo(tx, carlos, mo2.id));
  await issueAll(mo2.id);
  await run(mo2.id, 10, carlos, 'CNC-104', at(3, 12), at(3, 12, 35), {}, 'setup');
  await run(mo2.id, 10, tolu, 'CNC-104', at(3, 12, 40), at(3, 20, 25), { qtyGood: 78, qtyScrap: 2, scrapReason: 'DIM' });
  await run(mo2.id, 20, tolu, 'CNC-101', at(1, 12), at(1, 18), { qtyGood: 40 });
  const op20 = (await asActor(carlos, (tx) => getMo(tx, carlos, mo2.id))).operations.find((o: any) => o.op_no === 20);
  await asActor(carlos, async (tx) => startOperation(tx, carlos, op20.id, { assetId: await asset('CNC-101') }));
  // 3. Next batch planned, not released.
  await asActor(carlos, (tx) => createMo(tx, carlos, { facilityId: dayton, partId: fg.p.id, qty: 120, dueDate: dayStr(21), outputLocationId: fg.loc.id, notes: 'Stock replenishment' }));
  log(`  products: HSG-220 and KIT-AH220-SEAL released; ${mo1.number} closed, ${mo2.number} in progress (short: ${rel.shortages.map((x: any) => x.part_number).join(', ') || 'none'}), one planned`);
  void rmLoc;

  log('Ridgeline: quality (nonconformances, corrective actions) and safety (incidents, near misses)');
  const scrapRun = async (mo: string, opNo: number) => (await db.query(`SELECT e.id FROM production_entry e JOIN production_operation op ON op.id = e.operation_id
    JOIN production_order o ON o.id = e.order_id WHERE o.tenant_id = $1 AND o.number = $2 AND op.op_no = $3 AND e.qty_scrap > 0 AND e.kind = 'run'`, [t.tenantId, mo, opNo])).rows[0].id as string;
  const userOf = async (email: string) => (await db.query('SELECT id FROM app_user WHERE email = $1', [email])).rows[0].id as string;
  // 1. Last month's turning scrap: written up, scrapped, closed.
  const ncr1 = await asActor(tolu, async (tx) => createNcr(tx, tolu, { productionEntryId: await scrapRun(mo1.number, 10), description: 'Bore 0.02 mm over on two housings after insert wear' }));
  await asActor(sam, async (tx) => { await containNcr(tx, sam, ncr1.id, 'Both parts tagged red and moved to the MRB cage'); await dispositionNcr(tx, sam, ncr1.id, { disposition: 'scrap' }); await closeNcr(tx, sam, ncr1.id); });
  // 2. The same defect again on the live order: major, contained, scrapped, under a corrective action.
  const ncr2 = await asActor(tolu, async (tx) => createNcr(tx, tolu, { productionEntryId: await scrapRun(mo2.number, 10), severity: 'major', description: 'Bore oversize again on CNC-104, second order in a month' }));
  await asActor(sam, async (tx) => { await containNcr(tx, sam, ncr2.id, '100% bore check on all HSG-220 WIP; 78 good parts verified'); await dispositionNcr(tx, sam, ncr2.id, { disposition: 'scrap' }); });
  const capa1 = await asActor(sam, (tx) => createCapa(tx, sam, { facilityId: dayton, title: 'Repeat bore oversize on HSG-220 turning', problem: 'Two orders in a month scrapped housings for bore oversize at op 10 (CNC-104).',
    source: 'nonconformance', priority: 'high', ownerUserId: carlos.userId, dueDate: dayStr(14), ncrIds: [ncr2.id] }));
  await asActor(carlos, async (tx) => {
    await updateCapa(tx, carlos, capa1.id, { containment: '100% bore gauging at op 10 until the fix is verified' });
    await advanceCapa(tx, carlos, capa1.id);
    await updateCapa(tx, carlos, capa1.id, { rootCauseMethod: 'five_whys', rootCause: 'Insert wear is not tracked; operators change the offset by feel, and the bore drifts over the last parts of each insert edge.' });
    await advanceCapa(tx, carlos, capa1.id);
    const a1 = await addAction(tx, carlos, { subjectType: 'corrective_action', subjectId: capa1.id, title: 'Set tool-life counter for the boring insert on CNC-104', ownerUserId: marcus.userId, dueDate: dayStr(-5) });
    await addAction(tx, carlos, { subjectType: 'corrective_action', subjectId: capa1.id, title: 'Add in-process bore check every 10 parts to op 10 (routing rev 2)', ownerUserId: carlos.userId, dueDate: dayStr(-2) });
    void a1;
  });
  const a1 = (await db.query(`SELECT id FROM action_item WHERE subject_id = $1 ORDER BY due_date LIMIT 1`, [capa1.id])).rows[0].id;
  await asActor(marcus, (tx) => completeQAction(tx, marcus, a1, 'Tool-life counter set to 180 parts per edge; alarm stops the cycle'));
  // 3. Receiving: O-rings out of spec from the supplier, major, not yet contained.
  const po = (await db.query(`SELECT id FROM purchase_order WHERE tenant_id = $1 ORDER BY created_at LIMIT 1`, [t.tenantId])).rows[0];
  await asActor(sam, (tx) => createNcr(tx, sam, { purchaseOrderId: po.id, severity: 'major', partId: null, qty: 40, description: 'Certificate shows hardness 68 Shore A against 75 ± 5 specified; lot held at receiving' }));
  // 4. Customer return: burrs in a port, minor, reworked.
  const ncr4 = await asActor(sam, (tx) => createNcr(tx, sam, { salesOrderId: so1.id, partId: fg.p.id, qty: 2, description: 'Customer found burrs in the cross-drilled port on 2 housings' }));
  await asActor(sam, async (tx) => { await containNcr(tx, sam, ncr4.id, 'Remaining stock inspected; 0 found'); await dispositionNcr(tx, sam, ncr4.id, { disposition: 'rework', reason: 'Deburr and re-wash, return to customer', cost: 64 }); });
  // 5. A corrective action ready for its effectiveness check (owner Marcus, verified by quality, not by him).
  const capa2 = await asActor(sam, (tx) => createCapa(tx, sam, { facilityId: dayton, title: 'Scrap from spindle alarms on CNC-101', problem: 'Mid-cycle spindle alarms scrapped parts in 3 of the last 5 weeks.',
    source: 'internal', ownerUserId: marcus.userId, dueDate: dayStr(3) }));
  await asActor(marcus, async (tx) => {
    await updateCapa(tx, marcus, capa2.id, { containment: 'Alarmed parts quarantined for inspection', rootCauseMethod: 'fishbone', rootCause: 'Spindle drawbar seals worn; clamping force drops when warm' });
    await advanceCapa(tx, marcus, capa2.id); await advanceCapa(tx, marcus, capa2.id);
    const a = await addAction(tx, marcus, { subjectType: 'corrective_action', subjectId: capa2.id, title: 'Replace drawbar seal kit and add clamp-force check to quarterly PM', ownerUserId: marcus.userId, dueDate: dayStr(-10) });
    await completeQAction(tx, marcus, a.id, 'Seal kit replaced; clamp force 4,850 lbf; PM-101 updated');
    await updateCapa(tx, marcus, capa2.id, { verifyAfter: dayStr(0) });
    await advanceCapa(tx, marcus, capa2.id);
  });
  // 6. The customer asked for an 8D on the port burrs (D-126): team, is / is not, verified containment and both root
  // causes done; corrective action open, one read-across still to decide, so D5–D7 are in progress.
  const eightD = await asActor(sam, (tx) => createCapa(tx, sam, { facilityId: dayton, title: 'Burrs in cross-drilled port (Lakeshore 8D)', format: 'eight_d',
    problem: 'Lakeshore Hydraulics found burrs in the cross-drilled port on 2 housings at their assembly line and asked for an 8D within 30 days.',
    source: 'customer_complaint', priority: 'high', ownerUserId: sam.userId, dueDate: dayStr(24), ncrIds: [ncr4.id] }));
  await asActor(sam, async (tx) => {
    await updateCapa(tx, sam, eightD.id, { championUserId: alex.userId,
      isIsNot: { what: { is: 'Burr at the intersection of the 6 mm cross-drill and the main bore', isNot: 'Burrs on external edges or other ports' },
        where: { is: 'Housings drilled on VMC-2 (op 30)', isNot: 'Housings drilled on VMC-1 with the same program' },
        when: { is: 'Lots shipped since the 6 mm drill change', isNot: 'Earlier lots (none returned)' }, extent: { is: '2 of 160 shipped', isNot: 'In-house stock: 0 of 340 sorted' } },
      containment: 'Stock at Ridgeline and at Lakeshore sorted with a borescope; deburr and re-wash before shipping', containmentVerification: 'Borescope sort of 340 housings: 0 burrs; Lakeshore confirmed 0 since' });
    await addTeamMember(tx, sam, eightD.id, { userId: tolu.userId, expertise: 'VMC operator, op 30' });
    await addTeamMember(tx, sam, eightD.id, { userId: carlos.userId, expertise: 'Production supervisor' });
    await advanceCapa(tx, sam, eightD.id);
    await updateCapa(tx, sam, eightD.id, { rootCauseMethod: 'five_whys', rootCause: 'The 6 mm drill on VMC-2 exits into the bore without a back-deburr pass; the new drill grind leaves a larger exit burr',
      escapePoint: 'Final visual inspection (op 50)', escapeRootCause: 'The port intersection cannot be seen without a borescope; the checklist only covers external edges',
      rootCauseVerification: 'Ten parts drilled with the new grind all had exit burrs; ten with a back-deburr pass had none' });
    await advanceCapa(tx, sam, eightD.id);
    await addAction(tx, sam, { subjectType: 'corrective_action', subjectId: eightD.id, title: 'Add a back-deburr tool pass to the VMC-2 op 30 program', ownerUserId: carlos.userId, dueDate: dayStr(7), discipline: 'corrective' });
    await addAction(tx, sam, { subjectType: 'corrective_action', subjectId: eightD.id, title: 'Borescope check of the port at op 50 (1 in 20), added to the inspection plan', ownerUserId: sam.userId, dueDate: dayStr(10), discipline: 'preventive' });
    const ra = await addReadAcross(tx, sam, eightD.id, 'VMC-1 drilling of the same port');
    await decideReadAcross(tx, sam, ra.id, { applies: false, note: 'VMC-1 runs the older drill grind with a back-deburr pass already in the program' });
    await addReadAcross(tx, sam, eightD.id, 'Other cross-drilled parts (KIT-AH220 manifold)');
  });
  // Safety: a recordable strain with an open action, an unclassified near miss, closed earlier reports.
  const at2 = (daysAgo: number, h: number) => { const d = new Date(Date.now() - daysAgo * 86_400_000); d.setUTCHours(h, 15, 0, 0); return d; };
  const thiEmp = (await db.query(`SELECT id FROM employee WHERE tenant_id = $1 AND employee_number = 'E1004'`, [t.tenantId])).rows[0].id;
  const fa = await asActor(tolu, (tx) => reportIncident(tx, tolu, { facilityId: dayton, kind: 'first_aid', occurredAt: at2(41, 14), location: 'Saw area', description: 'Cut on palm from a bar end burr while loading', immediateActions: 'Cleaned and bandaged; gloves issued' }));
  await asActor(jordan, async (tx) => { await classifyIncident(tx, jordan, fa.id, { severity: 'low', involvedEmployeeId: tolu.employeeId, injuryDescription: 'Minor cut, right palm', medicalTreatment: false, recordable: false }); await closeIncident(tx, jordan, fa.id); });
  const strain = await asActor(tolu, async (tx) => reportIncident(tx, tolu, { facilityId: dayton, kind: 'injury', occurredAt: at2(12, 15), location: 'Raw material rack', assetId: await asset('CNC-104'),
    description: 'Strained lower back lifting a 12 ft bar onto the lathe bar feeder', immediateActions: 'Stopped work; supervisor drove him to the clinic' }));
  await asActor(jordan, async (tx) => {
    await classifyIncident(tx, jordan, strain.id, { severity: 'medium', involvedEmployeeId: thiEmp, injuryDescription: 'Lumbar strain', medicalTreatment: true, daysAway: 0, daysRestricted: 3, recordable: true });
    await investigateIncident(tx, jordan, strain.id, { rootCause: 'Full-length bars are loaded by hand; no lift assist at the bar feeder', contributingFactors: 'Bars arrive in 12 ft lengths; rack is at floor level' });
    await addAction(tx, jordan, { subjectType: 'safety_incident', subjectId: strain.id, title: 'Install bar cart and lift assist at the CNC-104 bar feeder', ownerUserId: marcus.userId, dueDate: dayStr(10) });
  });
  const nm1 = await asActor(carlos, async (tx) => reportIncident(tx, carlos, { facilityId: dayton, kind: 'near_miss', occurredAt: at2(30, 13), location: 'Dock 2', assetId: await asset('FLT-07'),
    description: 'Forklift reversed out of trailer without a spotter; pedestrian stepped back in time' }));
  await asActor(jordan, async (tx) => { await classifyIncident(tx, jordan, nm1.id, { severity: 'low' }); await closeIncident(tx, jordan, nm1.id); });
  await asActor(tolu, async (tx) => reportIncident(tx, tolu, { facilityId: dayton, kind: 'near_miss', occurredAt: at2(2, 16), location: 'VMC cell', assetId: await asset('CNC-101'),
    description: 'Chip conveyor started while I was clearing chips from the hopper; interlock on the side panel is bypassed with tape' }));
  void userOf;

  log('Ridgeline: calibration and internal audits');
  const instruments = await asActor(admin, async (tx) => ({
    mic: (await createAsset(tx, admin, { facilityId: dayton, assetTag: 'MIC-07', name: 'Mitutoyo micrometer 0–25 mm', assetClass: 'tool', category: 'Measuring instrument', manufacturer: 'Mitutoyo' })).id,
    bore: (await createAsset(tx, admin, { facilityId: dayton, assetTag: 'BG-250', name: 'Bore gauge 2.0–2.5 in', assetClass: 'tool', category: 'Measuring instrument', manufacturer: 'Sunnen' })).id,
  }));
  // The CMM is calibrated by the OEM yearly; micrometers and bore gauges in house.
  await asActor(sam, async (tx) => {
    const cmm = await savePlan(tx, sam, { assetId: await asset('CMM-01'), intervalDays: 365, tolerance: 'MPE ±(1.8 + L/300) µm', method: 'ISO 10360-2 verification with step gauge', nextDue: dayStr(-200) });
    await recordCalibration(tx, sam, cmm.id, { performedOn: dayStr(-200), performedBy: 'Zeiss field service', asFound: 'in_tolerance', asLeft: 'in_tolerance', certificateNo: 'ZI-24-8812' });
    const mic = await savePlan(tx, sam, { assetId: instruments.mic, intervalDays: 180, tolerance: '±0.002 mm', method: 'Gauge blocks 2.5, 10.1, 25 mm', nextDue: dayStr(-175) });
    await recordCalibration(tx, sam, mic.id, { performedOn: dayStr(-175), performedBy: 'Sam Okafor', asFound: 'in_tolerance', asLeft: 'in_tolerance', notes: 'All points within 0.001 mm' });
    const bore = await savePlan(tx, sam, { assetId: instruments.bore, intervalDays: 365, tolerance: '±0.0002 in', method: 'Setting ring 2.250 in', nextDue: dayStr(-368) });
    await recordCalibration(tx, sam, bore.id, { performedOn: dayStr(-368), performedBy: 'Sam Okafor', asFound: 'in_tolerance', asLeft: 'in_tolerance' });
  });
  // An internal audit reported with an unanswered finding, and one planned for next week.
  const aud1 = await asActor(sam, (tx) => createAudit(tx, sam, { facilityId: dayton, title: 'Production control, machining cell', scope: 'ISO 9001:2015 8.5.1 and 7.1.5 at Dayton machining',
    plannedOn: dayStr(-6), leadAuditorId: sam.userId, auditeeUserId: carlos.userId,
    items: ['Current revision of the routing and drawing at each operation', 'Operators hold the qualifications for the machines they run', 'Measuring equipment is calibrated and identified',
      'Nonconforming product is identified and segregated', 'First-piece inspection recorded for each setup'] }));
  await asActor(sam, async (tx) => {
    await startAudit(tx, sam, aud1.id);
    const items = (await getAudit(tx, sam, aud1.id)).items;
    await recordItem(tx, sam, items[0].id, { result: 'conforming', evidence: 'HSG-220 rev C drawing and routing rev 1 at op 10 and 20' });
    await recordItem(tx, sam, items[1].id, { result: 'conforming', evidence: 'Shop floor blocks operators without CMM-OP from CMM-01; checked 3 operators' });
    await recordItem(tx, sam, items[2].id, { result: 'minor_nc', evidence: 'Bore gauge BG-250 in use at op 10 with calibration overdue by 3 days; no label on the gauge' });
    await recordItem(tx, sam, items[3].id, { result: 'conforming', evidence: 'NCR-000002 parts tagged red in the MRB cage' });
    await recordItem(tx, sam, items[4].id, { result: 'observation', evidence: 'First pieces are measured but recorded only on the setup sheet, not in the system' });
    await reportAudit(tx, sam, aud1.id, 'Machining cell is well controlled; production records, qualification gating and NCR segregation work as intended. One minor finding on gauge calibration, one observation on first-piece records.');
  });
  log('Ridgeline: SPC');
  {
    // Deterministic noise (sum of three uniforms ≈ normal) so the seed always draws the same charts.
    let seed = 20261022;
    const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
    const noise = (sd: number) => (rnd() + rnd() + rnd() - 1.5) * 2 * sd;
    const r5 = (v: number) => Math.round(v * 100000) / 100000;
    const hsg = (await asActor(admin, (tx) => tx.query(`SELECT id FROM part WHERE part_number = 'HSG-220'`))).rows[0].id;
    const bore = await asActor(sam, async (tx) => saveSpcCharacteristic(tx, sam, { facilityId: dayton, code: 'HSG-BORE', name: 'Seal bore diameter', partId: hsg, opNo: 10,
      workCenterId: wc.lathe, assetId: await asset('CNC-104'), gaugeAssetId: instruments.bore, unit: 'in', nominal: 2.25, lsl: 2.249, usl: 2.251, subgroupSize: 5,
      frequency: '5 consecutive parts every 4 hours' }));
    // 25 subgroups over two weeks with the bore gauge (before it fell due), limits set from them, then the boring insert wears.
    const when = (k: number) => new Date(Date.now() - (18 - k * 0.45) * 86_400_000);
    const subgroup = (mean: number) => Array.from({ length: 5 }, () => r5(mean + noise(0.00025)));
    for (let k = 0; k < 25; k++) await asActor(tolu, (tx) => recordSpcSubgroup(tx, tolu, bore.id, { values: subgroup(2.25 + noise(0.00006)), measuredAt: when(k), lot: `L-${2610 + Math.floor(k / 5)}` }));
    await asActor(sam, (tx) => setSpcLimits(tx, sam, bore.id, { reason: 'Initial study after the new boring bar (FMEA action on bore oversize)' }));
    for (const [i, drift] of [0.0002, 0.0004, 0.0006, 0.0008, 0.0011].entries()) {
      await asActor(tolu, (tx) => recordSpcSubgroup(tx, tolu, bore.id, { values: subgroup(2.25 + drift), measuredAt: when(25 + i), lot: 'L-2615', note: i === 4 ? 'Chips stringy, finish getting worse' : null }));
    }
    // Sealing-face flatness from the CMM's own export (one reading per part, feature names mapped by the profile).
    const flat = await asActor(sam, async (tx) => saveSpcCharacteristic(tx, sam, { facilityId: dayton, code: 'HSG-FLAT', name: 'Sealing face flatness', partId: hsg, opNo: 40,
      workCenterId: wc.insp, gaugeAssetId: await asset('CMM-01'), unit: 'mm', usl: 0.02, subgroupSize: 1, frequency: '1 in 5 parts, full layout' }));
    const fmtD = (d: Date) => `${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}/${d.getFullYear()}`;
    const fmtT = (d: Date) => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    const cmm = ['Program,Part,Serial,Feature,Date,Time,Nominal,Actual,Upper Tol,Lower Tol,Deviation'];
    for (let k = 0; k < 30; k++) {
      const d = new Date(Date.now() - (20 - k * 0.6) * 86_400_000);
      const v = Math.max(0.002, Math.round((0.008 + noise(0.0015)) * 10000) / 10000);
      cmm.push(`HSG220_FULL_C,HSG-220,S${4100 + k * 5},FLATNESS_SEAL_FACE,${fmtD(d)},${fmtT(d)},0.0000,${v.toFixed(4)},0.0200,0.0000,${v.toFixed(4)}`);
      if (k % 3 === 0) cmm.push(`HSG220_FULL_C,HSG-220,S${4100 + k * 5},POSITION_BOLT_HOLES,${fmtD(d)},${fmtT(d)},0.0000,0.0410,0.1000,0.0000,0.0410`);
    }
    await runImportContent(admin, { fileName: 'cmm-results-hsg220.csv', content: Buffer.from(cmm.join('\n')), target: 'spc_measurements', sourceSystem: 'cmm-results-csv',
      profile: 'ridgeline/profiles/cmm-results.json', facilityId: dayton, allowPartial: true });
    await asActor(sam, (tx) => setSpcLimits(tx, sam, flat.id, { reason: 'Initial study from CMM history' }));
    // Leak test at final inspection: lots of different sizes, so a p chart (fraction defective) with limits that step.
    const leak = await asActor(sam, (tx) => saveSpcCharacteristic(tx, sam, { facilityId: dayton, code: 'HSG-LEAK', name: 'Leak test failures (3,000 psi)', partId: hsg, opNo: 40,
      workCenterId: wc.insp, subgroupSize: 1, chartType: 'p', frequency: 'every lot, 100% tested' }));
    for (let k = 0; k < 28; k++) {
      const n = 40 + Math.floor(rnd() * 50);
      const d = Math.max(0, Math.round(n * 0.02 + noise(0.9)));
      await asActor(tolu, (tx) => recordSpcSubgroup(tx, tolu, leak.id, { values: [d], sampleSize: n, measuredAt: new Date(Date.now() - (21 - k * 0.7) * 86_400_000), lot: `L-${2600 + k}` }));
      if (k === 24) await asActor(sam, (tx) => setSpcLimits(tx, sam, leak.id, { reason: 'Baseline: 25 lots after the seal kit change' }));
    }
  }
  log('Ridgeline: FMEA');
  // Equipment FMEA for the lathe that turns the housings, owned by production and reviewed by quality.
  const fmea1 = await asActor(sam, async (tx) => createFmea(tx, sam, { facilityId: dayton, kind: 'equipment', title: 'CNC-104 turning cell', scope: 'Turret, bar feeder, spindle and tooling for HSG-220 op 10',
    assetId: await asset('CNC-104'), ownerUserId: carlos.userId, team: 'Carlos Reyes (production), Marcus Kowalski (maintenance), Sam Okafor (quality), Tolu Adeyemi (operator)' }));
  await asActor(carlos, (tx) => saveRows(tx, carlos, fmea1.id, [
    { item: 'Turret', failureMode: 'Turret fails to index', effect: 'Machine stops mid-cycle; part scrapped', severity: 6, cause: 'Index proximity sensor contaminated by coolant', occurrence: 2,
      preventionControls: 'Sensor shield', detectionControls: 'Turret index alarm stops the cycle', detection: 2, failureCode: 'ELEC-SENSOR' },
    { item: 'Bar feeder', failureMode: 'Bar jams in feeder channel', effect: 'Stoppage; possible bent bar and short part', severity: 5, cause: 'Bent bar stock, worn channel liner', occurrence: 4,
      preventionControls: 'Straightness check at receiving', detectionControls: 'Feeder torque alarm', detection: 5 },
    { item: 'Boring tool (op 10)', failureMode: 'Bore oversize', effect: 'Housing leaks at the seal; customer return', severity: 7, cause: 'Insert wear not tracked; offset changed by feel', occurrence: 6,
      preventionControls: 'Operator experience', detectionControls: 'First and last piece bore check', detection: 5 },
  ]));
  const f1 = await asActor(carlos, (tx) => getFmea(tx, carlos, fmea1.id));
  const fAct = await asActor(carlos, (tx) => addQAction(tx, carlos, { subjectType: 'fmea', subjectId: fmea1.id, fmeaRowId: f1.rows[2].id, title: 'Tool-life counter on the boring insert; in-process bore check every 10 parts',
    ownerUserId: marcus.userId, dueDate: dayStr(-4) }));
  await asActor(carlos, (tx) => submitFmea(tx, carlos, fmea1.id));
  const fStep = (await asActor(sam, (tx) => myApprovalQueue(tx, sam))).find((q) => q.subject_id === fmea1.id)!;
  await asActor(sam, (tx) => decideApproval(tx, sam, fStep.step_id, { decision: 'approve', comment: 'Bore risk addressed through CA-000001 as well' }));
  await asActor(marcus, (tx) => completeQAction(tx, marcus, fAct.id, 'Counter set to 180 parts per edge (same change as CA-000001); bore check added'));
  await asActor(carlos, (tx) => evaluateRow(tx, carlos, f1.rows[2].id, { severity: 7, occurrence: 3, detection: 3 }));
  // Approved 13 months ago for the demo (D-154): its yearly review is now overdue, under Reviews.
  await db.query(`UPDATE fmea SET approved_at = now() - interval '13 months', review_due = (now() - interval '1 month')::date WHERE id = $1`, [fmea1.id]);
  // A process FMEA still in draft: its high-priority row has no action yet.
  const fmea2 = await asActor(sam, (tx) => createFmea(tx, sam, { facilityId: dayton, kind: 'process', title: 'HSG-220 machining and assembly', scope: 'Ops 10–40 of routing rev 1',
    partId: fg.p.id, ownerUserId: carlos.userId }));
  await asActor(carlos, (tx) => saveRows(tx, carlos, fmea2.id, [
    { item: 'Op 30 assemble', failureMode: 'O-ring missing', effect: 'External leak at customer test', severity: 8, cause: 'Kit not complete; manual assembly', occurrence: 4,
      preventionControls: 'Seal kit counted', detectionControls: 'Visual check', detection: 7 },
    { item: 'Op 40 inspect', failureMode: 'Port position not measured', effect: 'Mismatch with customer manifold', severity: 6, cause: '1 in 5 sampling', occurrence: 3, detection: 4 },
  ]));

  await asActor(sam, (tx) => createAudit(tx, sam, { facilityId: dayton, title: 'Maintenance and calibration control', scope: 'ISO 9001:2015 7.1.3, 7.1.5; PM program at Dayton',
    plannedOn: dayStr(7), leadAuditorId: sam.userId, auditeeUserId: marcus.userId,
    items: ['PM plans exist for critical assets', 'PM completed on time (sample 10 work orders)', 'Calibration records and labels for instruments', 'Spare parts for critical assets in stock'] }));

  log('Ridgeline: business continuity');
  // The housing line feeds Lakeshore's assembly plant; the plant manager owns its continuity plan, EHS writes it.
  const bcp1 = await asActor(jordan, (tx) => createBcp(tx, jordan, { facilityId: dayton, process: 'HSG-220 housing supply to Lakeshore Hydraulics', title: 'Housing line continuity',
    description: 'Lakeshore holds 3 days of housings at their assembly line; beyond that their line stops.', criticality: 'critical', rtoHours: 48, rpoHours: 4,
    ownerUserId: alex.userId, alternateUserId: marcus.userId }));
  await asActor(jordan, async (tx) => savePlanBody(tx, jordan, bcp1.id, {
    dependencies: [
      { kind: 'asset', assetId: await asset('CNC-104'), description: 'Bottleneck lathe for op 10', workaround: 'Run op 10 on CNC-102 with the soft-jaw fixture (about 40% slower)' },
      { kind: 'skill', qualificationId: spnQual.id, description: 'Spindle service on HMC-201 (op 20)', minHolders: 2 },
      { kind: 'supplier', supplierId: await supplierId('KOVAL'), description: 'Spindle cartridge rebuilds' },
      { kind: 'person', employeeId: await emp('E1008'), description: 'Schedules the line and releases production orders', workaround: 'Alex Romero releases orders; Thi Nguyen runs the floor queue' },
      { kind: 'other', description: 'Plant chilled-water loop (CNC-104 coolant)', workaround: 'Rental portable chiller under a temporary change (see MOC)' },
    ],
    scenarios: [
      { scenario: 'CNC-104 breakdown', impact: 'Op 10 stops; about 80 housings a shift lost', recoverySteps: '1. Maintenance triage within 1 h (work order, priority 1).\n2. If the repair is over 8 h: move op 10 to CNC-102 with the soft-jaw fixture.\n3. Add a Saturday shift on CNC-102 until CNC-104 is back.\n4. Tell Lakeshore the revised ship dates.',
        recoveryOwnerUserId: marcus.userId, estRecoveryHours: 36 },
      { scenario: 'Main chiller failure', impact: 'CNC-104 and HMC-201 lose coolant temperature control', recoverySteps: '1. Call the rental desk for a portable chiller.\n2. Raise a temporary change; connect along the cell guard.\n3. Check bore size on the first 5 parts.',
        recoveryOwnerUserId: marcus.userId, estRecoveryHours: 8 },
      { scenario: 'Bar stock supplier cannot deliver', impact: 'Raw material for HSG-220 runs out in 5 days', recoverySteps: '1. Confirm stock on hand and in transit.\n2. Qualify the alternate mill (first-article on 10 parts).\n3. Expedite through the buyer.',
        recoveryOwnerUserId: kim.userId, estRecoveryHours: 96 },
    ],
  }));
  await asActor(jordan, async (tx) => saveContacts(tx, jordan, bcp1.id, [
    { name: 'Alex Romero', role: 'Plan owner (plant manager)', phone: '+1 937 555 0110', email: 'alex.romero@ridgeline.example', userId: alex.userId },
    { name: 'Marcus Kowalski', role: 'Alternate; maintenance lead', phone: '+1 937 555 0114', userId: marcus.userId },
    { name: 'Koval service desk', role: 'Spindle rebuilds (24 h line)', phone: '+1 800 555 0177', supplierId: await supplierId('KOVAL') },
    { name: 'Lakeshore materials planner', role: 'Customer contact for ship-date changes', email: 'planning@lakeshore.example' },
  ]));
  await asActor(jordan, (tx) => submitBcp(tx, jordan, bcp1.id));
  const bStep = (await asActor(alex, (tx) => myApprovalQueue(tx, alex))).find((q) => q.subject_id === bcp1.id)!;
  await asActor(alex, (tx) => decideApproval(tx, alex, bStep.step_id, { decision: 'approve', comment: 'Agreed with Lakeshore buffer of 3 days.' }));
  const scen = (await asActor(alex, (tx) => getBcp(tx, alex, bcp1.id))).scenarios;
  const table = await asActor(jordan, (tx) => scheduleExercise(tx, jordan, bcp1.id, { kind: 'tabletop', scheduledOn: dayStr(-120), facilitatorUserId: jordan.userId }));
  await asActor(jordan, (tx) => recordExercise(tx, jordan, table.id, { conductedOn: dayStr(-120), participants: 'Alex Romero, Marcus Kowalski, Carlos Reyes, Kim Tran', outcome: 'met',
    findings: 'Walked through all three scenarios; call list confirmed.' }));
  const sim = await asActor(jordan, (tx) => scheduleExercise(tx, jordan, bcp1.id, { kind: 'simulation', scheduledOn: dayStr(-40), facilitatorUserId: marcus.userId, scenarioId: scen[0].id }));
  await asActor(marcus, (tx) => recordExercise(tx, marcus, sim.id, { conductedOn: dayStr(-40), participants: 'Marcus Kowalski, Priya Shah, Carlos Reyes, Tolu Adeyemi', outcome: 'partly_met',
    achievedRecoveryHours: 52, findings: 'Soft-jaw fixture was not at CNC-102 (found in the tool crib after 6 h). First-piece on CNC-102 took two attempts.' }));
  await asActor(alex, (tx) => addQAction(tx, alex, { subjectType: 'continuity_plan', subjectId: bcp1.id, continuityExerciseId: sim.id, title: 'Store the CNC-102 soft-jaw fixture at the cell, shadow-boarded',
    ownerUserId: marcus.userId, dueDate: dayStr(10) }));
  await asActor(jordan, (tx) => scheduleExercise(tx, jordan, bcp1.id, { kind: 'full_test', scheduledOn: dayStr(20), facilitatorUserId: marcus.userId, scenarioId: scen[0].id }));

  // Fort Wayne's press brake plan is still being written: no estimate, no call list yet.
  const bcp2 = await asActor(jordan, (tx) => createBcp(tx, jordan, { facilityId: t.facilities.FTW!, process: 'Bracket forming on PRS-01', title: 'Press brake continuity', criticality: 'high', rtoHours: 72,
    ownerUserId: sean.userId }));
  await asActor(jordan, async (tx) => savePlanBody(tx, jordan, bcp2.id, {
    dependencies: [{ kind: 'asset', assetId: await asset('PRS-01'), description: 'Only press brake at Fort Wayne' }],
    scenarios: [{ scenario: 'PRS-01 down for more than a shift', recoverySteps: 'Outsource forming to a local job shop (to be agreed).', recoveryOwnerUserId: sean.userId }],
  }));

  log('Ridgeline: machine operators and their qualifications');
  {
    // Three more operators at Dayton; turning and milling need a qualified operator, like the CMM already does.
    for (const [num, first, last, title] of [['E1020', 'Jamal', 'Brooks', 'CNC Operator'], ['E1021', 'Renee', 'Hale', 'CNC Operator'], ['E1022', 'Sofia', 'Ibarra', 'Machinist']] as const) {
      await asActor(admin, (tx) => createEmployee(tx, admin, { facilityId: dayton, employeeNumber: num, firstName: first, lastName: last, jobTitle: title }));
    }
    await asActor(admin, async (tx) => {
      const turn = await createQualification(tx, admin, { code: 'CNC-TURN', name: 'CNC turning operator (setup and run)', validityMonths: 24 });
      const mill = await createQualification(tx, admin, { code: 'CNC-MILL', name: 'CNC milling operator (setup and run)', validityMonths: 24 });
      await setAssetRequirement(tx, admin, await asset('CNC-104'), turn.id, 'operate');
      for (const m of ['CNC-101', 'CNC-102']) await setAssetRequirement(tx, admin, await asset(m), mill.id, 'operate');
      // Tolu's turning sign-off is nearly two years old: it lapses inside the planning horizon.
      await grantQualification(tx, admin, await emp('E1006'), turn.id, { effectiveOn: dayStr(-700), note: 'Setup and run sign-off, HSG-220 op 10' });
      await grantQualification(tx, admin, await emp('E1020'), turn.id, { effectiveOn: dayStr(-90), note: 'Setup and run sign-off' });
      for (const n of ['E1020', 'E1021', 'E1022']) await grantQualification(tx, admin, await emp(n), mill.id, { effectiveOn: dayStr(-120), note: 'Setup and run sign-off' });
    });
    // Six weeks of approved timesheets: their demonstrated hours (Renee works Saturdays, so 48 a week).
    for (let k = 1; k <= 6; k++) {
      const week = addDay(thisWeek, -7 * k);
      if (week === W0) continue; // already filled for the payroll example
      for (const [num, extra] of [['E1020', 0], ['E1021', 8], ['E1022', 0]] as const) await approve(marcus, await fillWeek(alex, num, week, { extra, extraNote: 'Saturday shift booked on Friday' }));
    }
  }
  log('Ridgeline: consumables and chemicals');
  {
    const rm = (await asActor(admin, (tx) => tx.query(`SELECT l.id FROM stock_location l WHERE l.facility_id = $1 AND l.code = 'DAY-MAIN'`, [dayton]))).rows[0].id;
    await asActor(admin, async (tx) => {
      for (const [pn, desc, uom, cost, onHand] of [['COOL-SYN', 'Synthetic coolant concentrate', 'GAL', 24, 40], ['INS-CNMG432', 'CNMG 432 turning insert, coated', 'EA', 11, 60],
        ['DET-ALK', 'Alkaline wash detergent', 'GAL', 9, 30]] as const) {
        const p = await createPart(tx, admin, { partNumber: pn, description: desc, uom, unitCost: cost });
        await receive(tx, admin, { locationId: rm, partId: p.id, qty: onHand, unitCost: cost, reference: 'Opening stock' });
      }
    });
    const usage = ['Area,Item #,Description,Qty,Per,Unit Basis,Comments',
      'Turning,COOL-SYN,Coolant concentrate,0.6,10,run hrs,Sump top-up at 6%',
      'Milling,COOL-SYN,Coolant concentrate,0.5,10,run hrs,Sump top-up at 6%',
      'Turning,INS-CNMG432,CNMG 432 insert,1,90,pcs,4 edges ≈ 90 housings',
      'Deburr & wash,DET-ALK,Wash detergent,8,1,monthly,Bath change every 2 weeks',
      ',COOL-SYN,Coolant concentrate,15,1,monthly,Quarterly sump clean-outs averaged'];
    await runImportContent(admin, { fileName: 'consumables-usage.csv', content: Buffer.from(usage.join('\n')), target: 'consumption_rates', sourceSystem: 'usage-sheet-xlsx',
      profile: 'ridgeline/profiles/consumables-usage.json', facilityId: dayton });
  }
  log('Ridgeline: supplier delivery history and a corrective action request');
  {
    // Six months of the old ERP's vendor delivery report (generated so the dates are recent).
    let seed = 7717;
    const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
    const us = (d: Date) => `${d.getMonth() + 1}/${d.getDate()}/${d.getFullYear()}`;
    const rows = ['Vendor ID,Vendor Name,PO Number,Ln,Part Number,Description,Qty Ord,Due Date,Date Recv,Qty Recv,Qty Rej,Unit Cost,Buyer'];
    const profile: [string, string, string, number, number, number, number][] = [
      // code, part, description, unit cost, late chance, average days late, reject rate
      ['KOVAL', 'BRG-6205-2RS', 'Bearing 6205-2RS', 6.4, 0.04, 2, 0], ['KOVAL', 'BLT-AX38', 'V-belt AX38', 14.2, 0.04, 2, 0.002],
      ['GREATLKS', 'FTG-90-08', '90° fitting -08 JIC', 3.1, 0.12, 4, 0.004], ['GREATLKS', 'FLT-HYD-10', 'Hydraulic filter 10 µm', 47.25, 0.12, 4, 0],
      ['RWPRESS', '', 'Press brake seal kit (OEM)', 128, 0.3, 9, 0.03],
    ];
    let po = 4500300;
    for (let k = 0; k < 26; k++) {
      for (const [code, part, desc, cost, lateP, lateDays, rej] of profile) {
        if (rnd() < 0.35) continue;
        const due = new Date(Date.now() - (180 - k * 6.5) * 86_400_000);
        const qty = code === 'RWPRESS' ? 2 + Math.floor(rnd() * 4) : 20 + Math.floor(rnd() * 80);
        const late = rnd() < lateP; const open = due.getTime() > Date.now() - 4 * 86_400_000 && late;
        const recv = new Date(due.getTime() + (late ? Math.ceil(lateDays * (0.5 + rnd())) : -Math.floor(rnd() * 3)) * 86_400_000);
        const rejected = Math.round(qty * rej * (rnd() < 0.5 ? 2 : 0));
        rows.push([code, '', ++po, 10, part, desc, qty, us(due), open ? '' : us(recv), open ? '' : qty, open ? '' : rejected, cost, 'KIM'].join(','));
      }
    }
    await runImportContent(admin, { fileName: 'vendor-delivery-report.csv', content: Buffer.from(rows.join('\n')), target: 'supplier_deliveries', sourceSystem: 'legacy-erp-vendor-delivery',
      profile: 'ridgeline/profiles/vendor-delivery.json', facilityId: dayton });
    // The seal kit lot held at receiving goes back to Ridgeway with a corrective action request.
    const ncr = (await db.query(`SELECT n.id, n.facility_id, n.supplier_id FROM nonconformance n JOIN supplier s ON s.id = n.supplier_id WHERE n.tenant_id = $1 AND s.code = 'RWPRESS' LIMIT 1`, [t.tenantId])).rows[0];
    if (ncr) {
      await asActor(sam, (tx) => issueScar(tx, sam, { facilityId: ncr.facility_id, supplierId: ncr.supplier_id, ownerUserId: sam.userId, ncrIds: [ncr.id], responseDays: 10,
        title: 'Seal kit hardness out of specification', problem: 'Certificate shows 68 Shore A against 75 ± 5 specified; 40 kits held at receiving. Third late or nonconforming delivery this quarter.' }));
    }
  }
  log('Ridgeline: shift logs');
  {
    // Yesterday's 2nd shift in machining, read by the supervisor; today's 1st shift handed over and waiting to be read.
    const y = await asActor(tolu, (tx) => startShift(tx, tolu, { facilityId: dayton, area: 'Machining', shiftLabel: '2nd',
      periodStart: new Date(Date.now() - 30 * 3_600_000), periodEnd: new Date(Date.now() - 22 * 3_600_000) }));
    await asActor(tolu, (tx) => saveShift(tx, tolu, y.id, { notes: 'Ran HSG-220 op 10 all shift. Insert changed twice; second one early (chipped).',
      items: [{ category: 'quality', text: 'Bore trending high on HSG-220: check with quality before running the next lot' }, { category: 'equipment', text: 'CNC-104 bar feeder alarm twice (cleared)' }] }));
    await asActor(tolu, (tx) => handOverShift(tx, tolu, y.id));
    await asActor(carlos, (tx) => acknowledgeShift(tx, carlos, y.id, 'Read; quality is reviewing the bore chart'));
    const t = await asActor(tolu, (tx) => startShift(tx, tolu, { facilityId: dayton, area: 'Machining', shiftLabel: '1st',
      periodStart: new Date(Date.now() - 8 * 3_600_000), periodEnd: new Date() }));
    const items = (await asActor(tolu, (tx) => getShift(tx, tolu, t.id))).items;
    const bar = items.find((i: any) => i.text.startsWith('CNC-104 bar feeder'));
    await asActor(tolu, (tx) => saveShift(tx, tolu, t.id, { notes: 'Lathe ran HSG-220 with the new insert. CMM program updated for rev C.', safetyNotes: 'Coolant leak under VMC cell, absorbent down and coned off.',
      items: [...(bar ? [{ id: bar.id, category: 'equipment' as const, text: bar.text, resolved: true, resolvedNote: 'Feeder channel liner replaced by Priya; no alarms since' }] : []),
        { category: 'safety', text: 'Coolant leak under VMC cell: find the source' }] }));
    await asActor(tolu, (tx) => handOverShift(tx, tolu, t.id));
  }
  log('Ridgeline: continuous improvement');
  {
    const ago = (d: number) => new Date(Date.now() - d * 86_400_000).toISOString().slice(0, 10);
    // Closed: quick changeover on the VMC fixtures, measured by hand (stopwatch), savings validated by the operations manager.
    const smed = await asActor(carlos, (tx) => submitIdea(tx, carlos, { facilityId: dayton, title: 'Quick-change fixture plates on the VMCs', category: 'delivery',
      problem: 'Fixture changeover on CNC-101/102 takes about 48 minutes; four changeovers a day', idea: 'Zero-point clamping plates and a pre-set fixture cart' }));
    await asActor(alex, (tx) => decideImp(tx, alex, smed.id, { approve: true, ownerUserId: carlos.userId, note: 'Fund the plates from the tooling budget' }));
    await asActor(carlos, (tx) => planImp(tx, carlos, smed.id, { metricKind: 'manual', metricName: 'Fixture changeover', metricUnit: 'min', lowerIsBetter: true, targetValue: 20, estAnnualSavings: 18000, oneTimeCost: 6400 }));
    await asActor(carlos, (tx) => baselineImp(tx, carlos, smed.id, { value: 48, from: ago(120), to: ago(90) }));
    await asActor(carlos, (tx) => implementedImp(tx, carlos, smed.id, { implementedOn: ago(60) }));
    await asActor(carlos, (tx) => resultImp(tx, carlos, smed.id, { value: 22 }));
    await asActor(alex, (tx) => validateImp(tx, alex, smed.id, { amount: 14500, note: '26 min × 4 changeovers × 240 days = 416 h of VMC time at $35/h contribution (not the $43/h estimated)' }));
    // Measuring: spindle vibration fix on HMC-201, downtime measured from its state history; the result is due in a few weeks.
    const hmcAsset = await asset('HMC-201');
    const hmc = await asActor(marcus, (tx) => submitIdea(tx, marcus, { facilityId: dayton, title: 'Balance-check tool holders before use on HMC-201', category: 'maintenance',
      problem: 'Spindle vibration alarms stop HMC-201 several times a month', idea: 'Balance every holder above 6k rpm on the new balancer', assetId: hmcAsset }));
    await asActor(alex, (tx) => decideImp(tx, alex, hmc.id, { approve: true, ownerUserId: priya.userId }));
    await asActor(priya, (tx) => planImp(tx, priya, hmc.id, { metricKind: 'asset_unplanned_downtime', targetValue: 0.5, estAnnualSavings: 9500 }));
    await asActor(priya, (tx) => baselineImp(tx, priya, hmc.id, { from: ago(65), to: ago(10) }));
    await asActor(priya, (tx) => implementedImp(tx, priya, hmc.id, { implementedOn: ago(9) }));
    // An idea from the floor waiting for a decision.
    await asActor(tolu, (tx) => submitIdea(tx, tolu, { facilityId: dayton, title: 'Interlock check in the VMC chip conveyor PM', category: 'safety',
      problem: 'Side panel interlock was found taped over (near miss in the VMC cell)', idea: 'Add a monthly interlock function test to the PM checklist, signed off by the operator' }));
  }
  log('Ridgeline: repair-or-replace history');
  {
    // Five years of closed jobs from the old CMMS with their costs (labor at the job rate folded into the cost column, as the export does).
    let seed = 4242;
    const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
    const rows = ['WO#,Asset,Description,Type,Opened,Closed,Parts $,Work done'];
    const plan: [string, number[], string[]][] = [
      ['CNC-101', [6200, 8900, 13100, 18800, 25900], ['Way lube pump', 'Spindle drawbar', 'Axis encoder', 'Coolant pump', 'Ball screw rebuild', 'Spindle bearings']],
      ['CMP-01', [4100, 3800, 4300, 4000, 4200], ['Separator element', 'Intake valve', 'Drain valve', 'Cooler clean']],
      ['HMC-201', [7800, 8600, 9900, 11200, 12800], ['Pallet changer', 'Tool changer arm', 'Chip conveyor', 'Hydraulic unit']],
    ];
    let n = 70000;
    const year = new Date().getUTCFullYear();
    for (const [tag, costs, jobs] of plan) {
      costs.forEach((total, i) => {
        const y = year - 5 + i;
        const k = 3 + Math.floor(rnd() * 3); let left = total;
        for (let j = 0; j < k; j++) {
          const amt = j === k - 1 ? left : Math.round(total / k * (0.6 + rnd() * 0.8)); left -= amt;
          const m = 1 + Math.floor((j * 11) / k); const d = 3 + Math.floor(rnd() * 20);
          const opened = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')} 07:30`;
          const closed = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')} 15:00`;
          rows.push([`H-${++n}`, tag, jobs[Math.floor(rnd() * jobs.length)], rnd() < 0.7 ? 'BRK' : 'PM', opened, closed, Math.max(0, amt), 'Repaired'].join(','));
        }
      });
    }
    await runImportContent(admin, { fileName: 'cmms-cost-history.csv', content: Buffer.from(rows.join('\n')), target: 'work_order_history', sourceSystem: 'legacy-cmms-costs',
      profile: 'ridgeline/profiles/cmms-cost-history.json' });
    await asActor(admin, async (tx) => {
      for (const [tag, cost, life, dt, since] of [['CNC-101', 185000, 15, 180, '2011-05-01'], ['CMP-01', 42000, 12, 120, '2016-08-15'], ['HMC-201', 420000, 20, 260, '2018-03-01']] as const) {
        await updateAsset(tx, admin, await asset(tag), { replacementCost: cost, expectedLifeYears: life, downtimeCostPerHour: dt, commissionedOn: since });
      }
    });
  }
  log('Ridgeline: customer forecasts, work-center calendars and a capacity scenario');
  // The customers' forecast spreadsheet, a column per month from this month (generated so the months are current).
  const fmon = (k: number) => { const d = new Date(); return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + k, 1)).toLocaleString('en-US', { month: 'short', year: '2-digit', timeZone: 'UTC' }).replace(' ', '-'); };
  const fcRows = [`Customer,Part #,Description,${[0, 1, 2, 3, 4, 5].map(fmon).join(',')}`,
    'Miami Valley Hydraulics,HSG-220,AH-220 manifold housing,600,700,800,950,1100,1250',
    'Miami Valley Hydraulics,KIT-AH220-SEAL,Service seal kit,40,40,50,50,60,60',
    'C-80155,HSG-220,AH-220 manifold housing,,200,300,400,500,600'];
  await runImportContent(carlos, { fileName: 'customer-forecasts.csv', content: Buffer.from(fcRows.join('\n')), target: 'customer_forecasts', sourceSystem: 'customer-forecast-xlsx',
    profile: 'ridgeline/profiles/customer-forecast.json', facilityId: dayton });
  for (const f of (await db.query(`SELECT id FROM customer_forecast WHERE tenant_id = $1 AND status = 'draft'`, [t.tenantId])).rows) await asActor(carlos, (tx) => activateForecast(tx, carlos, f.id));
  await asActor(carlos, async (tx) => {
    for (const [w, h] of [[wc.lathe, 40], [wc.vmc, 40], [wc.assy, 40], [wc.insp, 40]] as const) await saveWorkCenterCalendar(tx, carlos, w, { hoursPerWeek: h, units: null });
    await saveScenario(tx, carlos, { facilityId: dayton, name: 'Second shift on the lathe', adjustments: [{ workCenterId: wc.lathe, extraHoursPerWeek: 40 }], notes: 'One more machinist on CNC-104, Mon–Fri 15:00–23:00' });
  });

  log('Ridgeline: employee handbook and expense policy');
  // HR (Lena) starts from the templates, fills in Ridgeline's answers and publishes most sections; two stay in draft
  // with placeholders. Expense rules are set; a few people have acknowledged.
  const ANSWERS: [RegExp, string][] = [
    [/\[\[Company name\]\]/g, 'Ridgeline'], [/\[\[Two or three sentences[^\]]*\]\]/, 'Ridgeline machines precision valve housings and hydraulic components in Dayton and Fort Wayne for industrial customers, and has done so since 1994.'],
    [/\[\[name or role, e.g. HR Manager\]\]/, 'Lena Park (HR and payroll)'], [/\[\[Confirm whether employment[^\]]*\]\]/, 'Employment with Ridgeline in Ohio and Indiana is at will: either side may end it at any time, with or without notice.'],
    [/\[\[number\]\] or more hours/, '32 or more hours'], [/fewer than \[\[number\]\] hours/, 'fewer than 32 hours'],
    [/\[\[State whether there is an introductory period[^\]]*\]\]/, 'The first 90 days are an introductory period to learn the job; benefits start on the first of the month after 30 days.'],
    [/\[\[role\]\]/g, 'HR'], [/\[\[alternate role\]\]/g, 'the plant manager'], [/\[\[amount\]\]/g, '$50'], [/\[\[anonymous channel, if any\]\]/, 'the anonymous line, 1-800-555-0144'],
    [/\[\[hours and shifts\]\]/, 'first shift 6:00–14:30 and second shift 14:30–23:00, Monday to Friday'], [/\[\[weekly \/ every two weeks \/ twice a month\]\]/, 'every two weeks'], [/\[\[day\]\]/, 'Friday'],
    [/\[\[number of hours or days\]\]/, '80 hours'], [/\[\[each pay period \/ monthly\]\]/, 'each pay period'], [/\[\[Carry-over and payout rules\.\]\]/, 'Up to 40 unused hours carry over; unused time is not paid out.'],
    [/at least \[\[number\]\] days ahead, except/, 'at least 14 days ahead, except'], [/\[\[list of holidays\]\]/, "New Year's Day, Memorial Day, Independence Day, Labor Day, Thanksgiving and the day after, Christmas Eve and Christmas Day"],
    [/\[\[Describe family, medical[^\]]*\]\]/, 'Family and medical leave follows the FMLA; military leave follows USERRA. Ask HR before any leave longer than a week.'],
    [/\[\[Testing policy, if any\.\]\]/, 'Testing follows an injury requiring treatment and reasonable suspicion.'], [/\[\[State what personal use is allowed\.\]\]/, 'Brief personal use on breaks is fine.'],
    [/\[\[how and when, e\.g\. with the next payroll\]\]/, 'with the next payroll'],
    [/\[\[economy airfare \/ the lowest logical fare\]\]/, 'the lowest logical economy fare'], [/at least \[\[number\]\] days ahead where possible/, 'at least 14 days ahead where possible'],
    [/\[\[Rules for hotels[^\]]*\]\]/, 'Standard rooms at business hotels; compact or mid-size rental cars; personal days on a trip are at your own cost.'],
    [/\[\[with the next payroll \/ by direct deposit within N days\]\]/, 'with the next payroll after approval'],
  ];
  await asActor(lena, (tx) => installTemplates(tx, lena));
  const keep = new Set(['handbook.conduct-discipline', 'handbook.leaving']);
  for (const pol of (await db.query(`SELECT id, template_key FROM policy WHERE tenant_id = $1 ORDER BY handbook_order NULLS LAST`, [t.tenantId])).rows) {
    if (keep.has(pol.template_key)) continue;
    await asActor(lena, async (tx) => {
      const p = await getPolicy(tx, lena, pol.id);
      let body: string = p.draft.body;
      for (const [re, v] of ANSWERS) body = body.replace(re, v);
      await saveDraft(tx, lena, pol.id, { body });
      await publishPolicy(tx, lena, pol.id, { effectiveOn: dayStr(-30) });
    });
  }
  await asActor(lena, async (tx) => {
    await saveExpensePolicy(tx, lena, { receiptRequiredOver: 25, mileageRate: 0.7, submitWithinDays: 60 });
    const cats = (await expenseRules(tx)).categories;
    const set = async (code: string, item: number | null, day: number | null) => {
      const c = cats.find((x: any) => x.code === code);
      await saveExpenseCategory(tx, lena, { id: c.id, code, name: c.name, kind: c.kind, needsAttendees: c.needs_attendees, accountKey: c.account_key, sortOrder: c.sort_order, limitPerItem: item, limitPerDay: day });
    };
    await set('LODGING', 225, null); await set('MEALS', null, 75); await set('BIZMEAL', 150, null); await set('TOOLS', 250, null);
  });
  for (const who of [priya, marcus]) await asActor(who, (tx) => acknowledgeHandbook(tx, who));
  log(`  handbook: ${(await db.query(`SELECT count(*)::int AS n FROM policy WHERE tenant_id = $1 AND current_version_id IS NOT NULL`, [t.tenantId])).rows[0].n} policies published, 2 sections in draft`);

  log('Ridgeline: intranet news, events, quick links and directory details');
  await asActor(lena, async (tx) => {
    await postAnnouncement(tx, lena, { title: 'Open enrollment runs until November 15', pinned: true, kind: 'people', expiresOn: dayStr(24),
      body: 'Choose your medical, dental and vision plans for next year in the benefits portal (see Quick links). **Nothing changes unless you make a choice.** Questions to Lena Park.' });
    await postAnnouncement(tx, lena, { title: 'Thanksgiving: plants closed Thursday and Friday', kind: 'event', eventOn: dayStr(36), body: 'Both plants close for Thanksgiving and the day after. Second shift ends at 19:00 on Wednesday.' });
  });
  await asActor(alex, async (tx) => {
    await postAnnouncement(tx, alex, { title: 'Forklift seat-belt check this week', kind: 'safety', body: 'Every forklift operator checks the seat belt and the interlock at the start of each shift this week and reports any fault as a work request.' });
    await postAnnouncement(tx, alex, { title: 'Lakeshore Hydraulics audit at Dayton', kind: 'event', facilityId: dayton, eventOn: dayStr(9),
      body: 'Lakeshore\u2019s supplier quality team visits the housing line. Keep 5S standards up and the CMM room tidy.' });
    await postAnnouncement(tx, alex, { title: 'Welcome to our new machinists', kind: 'people', body: 'Please welcome **Tolu Adeyemi** to first shift on the lathe cell at Dayton.' });
  });
  await asActor(admin, async (tx) => {
    await saveQuickLink(tx, admin, { title: 'Benefits portal', url: 'https://benefits.example.com', description: 'Enroll and change benefits', sortOrder: 10 });
    await saveQuickLink(tx, admin, { title: 'Payroll and pay stubs', url: 'https://payroll.example.com', sortOrder: 20 });
    await saveQuickLink(tx, admin, { title: 'Report a safety concern', url: '/safety', sortOrder: 30 });
  });
  for (const [num, phone, office] of [['E1001', '937-555-0101', 'Maintenance shop'], ['E1003', '937-555-0103', 'Maintenance office'], ['E1006', '937-555-0106', 'Lathe cell'], ['E1008', '937-555-0108', 'Production office']]) {
    await db.query('UPDATE employee SET work_phone = $3, office_location = $4 WHERE tenant_id = $1 AND employee_number = $2', [t.tenantId, num, phone, office]);
  }

  log('Ridgeline: departments and expense reports');
  // Departments with heads (they sign their people's expense reports), then reports in each state.
  const deptOf: Record<string, string> = {};
  for (const [code, name, fac, head, members] of [
    ['MNT', 'Maintenance', dayton, marcus.userId, ['E1001', 'E1003', 'E1004']], ['PRD', 'Production', dayton, alex.userId, ['E1006', 'E1008']],
    ['QA', 'Quality', null, null, []], ['SLS', 'Sales', null, taylor.userId, []]] as const) {
    const d = (await db.query('INSERT INTO department (tenant_id, facility_id, code, name, head_user_id) VALUES ($1, $2, $3, $4, $5) RETURNING id', [t.tenantId, fac, code, name, head])).rows[0].id;
    deptOf[code] = d;
    if (members.length) await db.query('UPDATE employee SET department_id = $3 WHERE tenant_id = $1 AND employee_number = ANY ($2)', [t.tenantId, members, d]);
  }
  const reload = async (u: Actor) => (await loadActor(t.tenantId, u.userId))!;
  const [priyaE, thiE, carlosE] = [await reload(priya), await reload(thiUser), await reload(carlos)];
  const xcat = Object.fromEntries((await asActor(admin, (tx) => expenseRules(tx))).categories.map((c: any) => [c.code, c.id]));
  const receiptPng = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
  const claim = async (who: Actor, title: string, purpose: string, lines: { d: number; cat: string; merchant?: string; desc?: string; amount?: number; miles?: number; attendees?: string; explanation?: string; receipt?: boolean }[]) =>
    asActor(who, async (tx) => {
      const r = await createReport(tx, who, { title, purpose });
      for (const l of lines) {
        const line = await saveLine(tx, who, r.id, { spentOn: dayStr(l.d), categoryId: xcat[l.cat], merchant: l.merchant, description: l.desc, amount: l.amount, miles: l.miles, attendees: l.attendees, explanation: l.explanation });
        if (l.receipt !== false && !l.miles) await attachReceipt(tx, who, blobs, line.id, { fileName: `${l.merchant ?? 'receipt'}.png`.replace(/\s+/g, '-'), mime: 'image/png', content: receiptPng });
      }
      return r;
    });
  const decideFor = async (who: Actor, reportId: string, decision: 'approve' | 'reject' = 'approve', comment?: string) => {
    const step = (await asActor(who, (tx) => myApprovalQueue(tx, who))).find((q) => q.subject_id === reportId)!;
    await asActor(who, (tx) => decideApproval(tx, who, step.step_id, { decision, comment }));
  };
  // 1. Paid: Priya's pump course (manager, then finance over $500, then reimbursed with payroll).
  const x1 = await claim(priyaE, 'Grundfos pump course, Columbus', 'Vendor training on the new booster pumps', [
    { d: -20, cat: 'LODGING', merchant: 'Hilton Columbus Downtown', amount: 189 }, { d: -20, cat: 'MILEAGE', miles: 142, desc: 'Dayton plant to Columbus and back' },
    { d: -20, cat: 'MEALS', merchant: 'Bodega Cafe', amount: 42.5 }, { d: -19, cat: 'TRAINING', merchant: 'Grundfos Academy', amount: 395, desc: 'Booster pump service course' }]);
  await asActor(priyaE, (tx) => submitReport(tx, priyaE, x1.id));
  await decideFor(marcus, x1.id); await decideFor(morgan, x1.id);
  await asActor(ana, (tx) => markPaid(tx, ana, x1.id, { paidOn: dayStr(-5), method: 'payroll', reference: 'Payroll run ending ' + dayStr(-5) }));
  // 2. Waiting for the head of Maintenance: Thi's parts pickup.
  const x2 = await claim(thiE, 'Bearings pickup, Fastenal Springfield', 'Same-day bearings for CNC-104', [
    { d: -2, cat: 'MILEAGE', miles: 38, desc: 'Plant to Fastenal Springfield and back' }, { d: -2, cat: 'PARKING', merchant: 'City lot', amount: 6, receipt: false }]);
  await asActor(thiE, (tx) => submitReport(tx, thiE, x2.id));
  // 3. Waiting for the head of Production: a customer dinner over the limit, explained.
  const x3 = await claim(carlosE, 'Lakeshore Hydraulics visit', 'Quality review of the AH-220 housing line with the customer', [
    { d: -4, cat: 'MILEAGE', miles: 210, desc: 'Dayton to Lakeshore (Toledo) and back' },
    { d: -4, cat: 'BIZMEAL', merchant: 'Mancy\'s Steakhouse', amount: 168.4, attendees: 'J. Park and R. Ellis (Lakeshore quality), Carlos Reyes: 8D review follow-up',
      explanation: 'Customer chose the restaurant; three people, $56 each' }]);
  await asActor(carlosE, (tx) => submitReport(tx, carlosE, x3.id));
  // 4. A draft with a flag to resolve: hotel over the limit without a receipt.
  await claim(priyaE, 'Hydraulics seminar, Cincinnati', 'Parker hydraulics seminar', [
    { d: -1, cat: 'LODGING', merchant: 'Marriott Cincinnati', amount: 239, receipt: false }]);
  log(`  expenses: ${x1.number} reimbursed, ${x2.number} and ${x3.number} waiting for department heads, one draft with policy flags`);

  log('Ridgeline: spend history and budgets');
  // The previous system's profit-and-loss by month (a column per month), for the twelve complete months to date.
  const glMonths = Array.from({ length: 12 }, (_, i) => { const d = new Date(); return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 12 + i, 1)); });
  const glHead = glMonths.map((d) => d.toLocaleString('en-US', { month: 'short', year: '2-digit', timeZone: 'UTC' }).replace(' ', '-'));
  const season = (i: number, swing: number) => 1 + swing * Math.sin(((glMonths[i]!.getUTCMonth() + 1) / 12) * 2 * Math.PI);
  const glLine = (plant: string, dept: string, acct: string, name: string, base: number, swing = 0.1, growth = 0) =>
    [plant, dept, acct, name, ...glMonths.map((_, i) => Math.round(base * season(i, swing) * (1 + (growth * i) / 11)))].join(',');
  const gl = [['Plant', 'Dept', 'GL Account', 'Account Description', ...glHead].join(','),
    glLine('DAY', 'MNT', '6200', 'Repairs & maintenance', 14500, 0.15, 0.12), glLine('DAY', 'MNT', '6700', 'Contract services', 4200, 0.3),
    glLine('DAY', 'MNT', '6300', 'Shop supplies', 1100), glLine('DAY', 'MNT', '6500', 'Travel', 650, 0.4),
    glLine('DAY', 'PRD', '6300', 'Shop supplies', 2300), glLine('DAY', 'PRD', '6520', 'Training', 900, 0.5), glLine('DAY', '', '6600', 'Utilities', 18500, 0.25),
    glLine('FTW', '', '6200', 'Repairs & maintenance', 6800, 0.1), glLine('FTW', '', '6600', 'Utilities', 9200, 0.25), glLine('FTW', '', '6500', 'Travel', 400, 0.3),
    glLine('DAY', '', '7150', 'Bank charges', 85, 0)];
  await runImportContent(morgan, { fileName: 'pl-by-month.csv', content: Buffer.from(gl.join('\n')), target: 'spend_history', sourceSystem: 'legacy-gl-monthly',
    profile: 'ridgeline/profiles/gl-monthly-actuals.json', facilityId: dayton, allowPartial: true });
  const thisYear = new Date().getUTCFullYear();
  // This year's approved budget (the actual comparison), from the year before's spend, and next year's in progress.
  const cur = await asActor(morgan, async (tx) => {
    const b = await createBudget(tx, morgan, { fiscalYear: thisYear, name: `${thisYear} operating budget` });
    await proposeLines(tx, morgan, b.id, { facilityId: dayton, departmentId: deptOf.MNT!, changePct: 0 });
    await proposeLines(tx, morgan, b.id, { facilityId: dayton, departmentId: deptOf.PRD!, changePct: 0 });
    await proposeLines(tx, morgan, b.id, { facilityId: dayton, changePct: 0 });
    await proposeLines(tx, morgan, b.id, { facilityId: t.facilities.FTW!, changePct: 0 });
    await approveBudget(tx, morgan, b.id);
    return b;
  });
  const nxt = await asActor(morgan, (tx) => createBudget(tx, morgan, { fiscalYear: thisYear + 1, name: `${thisYear + 1} operating budget` }));
  await asActor(marcus, async (tx) => {
    await proposeLines(tx, marcus, nxt.id, { facilityId: dayton, departmentId: deptOf.MNT!, changePct: 4 });
    await submitBudget(tx, marcus, nxt.id, { facilityId: dayton, departmentId: deptOf.MNT!, note: 'Includes the HMC-201 spindle rebuild; contract services flat' });
  });
  await asActor(morgan, async (tx) => {
    await proposeLines(tx, morgan, nxt.id, { facilityId: dayton, changePct: 6 });
    await proposeLines(tx, morgan, nxt.id, { facilityId: t.facilities.FTW!, changePct: 3 });
    const tot = (await getBudget(tx, morgan, nxt.id)).total;
    await setTarget(tx, morgan, nxt.id, { amount: Math.round(tot * 0.97 / 1000) * 1000, note: 'Board ceiling: 3% below the bottom-up' });
  });
  log(`  budgets: ${cur.name} approved; ${nxt.name} in progress (Maintenance submitted, company target below the bottom-up)`);

  log('Ridgeline: lot and serial tracking');
  await asActor(admin, async (tx) => {
    // Coolant concentrate has a shelf life, so it is tracked by lot: an older drum lot near expiry, a newer one, and a
    // lot quarantined after a concentration check failed. Spindle cartridges are tracked by serial number (D-147).
    const coolant = await createPart(tx, admin, { partNumber: 'CLN-SYN-5', description: 'Synthetic coolant concentrate, 5 gal pail', uom: 'EA', manufacturer: 'Master Fluid Solutions', unitCost: 148 });
    await setTracking(tx, admin, coolant.id, { tracking: 'lot', shelfLifeDays: 365 });
    const ago = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);
    await receive(tx, admin, { locationId: stores.day.id, partId: coolant.id, qty: 4, unitCost: 142, reference: 'PO via Motion Industries', lots: [{ lot: 'TC-24-0917', qty: 4, supplierLot: 'MF2409-17', madeOn: ago(340) }] });
    await receive(tx, admin, { locationId: stores.day.id, partId: coolant.id, qty: 6, unitCost: 148, reference: 'PO via Motion Industries', lots: [{ lot: 'TC-25-0311', qty: 6, supplierLot: 'MF2503-11', madeOn: ago(60) }] });
    await receive(tx, admin, { locationId: stores.day.id, partId: coolant.id, qty: 3, unitCost: 148, reference: 'PO via Motion Industries', lots: [{ lot: 'TC-25-0402', qty: 3, supplierLot: 'MF2504-02', madeOn: ago(30) }] });
    const q = (await tx.query(`SELECT id FROM stock_lot WHERE part_id = $1 AND number = 'TC-25-0402'`, [coolant.id])).rows[0].id;
    // The failed incoming check is a receiving nonconformance that holds the lot.
    const ncr = await createNcr(tx, admin, { facilityId: t.facilities.DAY!, source: 'receiving', title: 'Coolant concentrate below strength', partId: coolant.id, qty: 3,
      description: 'Refractometer reading 3.1% against the 5% specification on lot TC-25-0402 (supplier lot MF2504-02).' });
    await holdLotsForNcr(tx, admin, ncr.id, [q]);
    const cart = await createPart(tx, admin, { partNumber: 'SPN-CART-VF4', description: 'Spindle cartridge, rebuilt, Haas VF-4', uom: 'EA', manufacturer: 'Haas', unitCost: 6850 });
    await setTracking(tx, admin, cart.id, { tracking: 'serial' });
    await receive(tx, admin, { locationId: stores.day.id, partId: cart.id, qty: 2, unitCost: 6850, reference: 'Rebuild RMA 44120', lots: [{ lot: 'HS-77102', qty: 1 }, { lot: 'HS-80455', qty: 1 }] });
  });
  log('  lots: coolant in 3 lots (one near expiry, one on hold), 2 serial-numbered spindle cartridges');

  log('Ridgeline: performance reviews');
  // Reporting lines (D-155): technicians to their maintenance managers, the operator to the production supervisor.
  for (const [who, mgr] of [['E1001', 'E1003'], ['E1004', 'E1003'], ['E1002', 'E1005'], ['E1006', 'E1008']]) {
    await db.query(`UPDATE employee SET manager_employee_id = (SELECT id FROM employee WHERE tenant_id = $1 AND employee_number = $3) WHERE tenant_id = $1 AND employee_number = $2`, [t.tenantId, who, mgr]);
  }
  // Yearly reviews at the end of next month, opened 70 days ahead so the demo has reviews in progress.
  const reviewMonth = ((new Date().getUTCMonth() + 1) % 12) + 1;
  await asActor(lena, (tx) => savePerformanceSettings(tx, lena, { enabled: true, intervalMonths: 12, anchor: 'calendar', calendarMonth: reviewMonth, firstReviewMonths: 3, checkinMonths: 3, selfAssessment: true, openDaysBefore: 70 }));
  log(`  yearly reviews due at the end of month ${reviewMonth}; check-ins every 3 months; managers set for 4 people`);

  log('Ridgeline: business cases (D-162)');
  {
    const y = new Date().getUTCFullYear() + 1;
    // Approved: a second machining cell at Fort Worth for a new customer program.
    const cell = await asActor(alex, (tx) => createProforma(tx, alex, { facilityId: t.facilities.FTW!, title: 'Second 5-axis cell for the Lakeshore program', kind: 'product_line',
      description: 'Two 5-axis machines and a cell lead for the Lakeshore housing program (3-year award, likely renewal).', startMonth: `${y}-01`, years: 5, discountRatePct: 11, taxRatePct: 24,
      lines: [
        { section: 'revenue', label: 'Lakeshore housings', method: 'units_price', amount: 185, qty: 900, growthPct: 4, rampMonths: 6, startMonth: 3 },
        { section: 'revenue', label: 'Spot work on spare capacity', method: 'fixed_monthly', amount: 12000, startMonth: 9 },
        { section: 'cost_of_sales', label: 'Bar stock and tooling', method: 'pct_of_revenue', amount: 38 },
        { section: 'cost_of_sales', label: 'Machinists', method: 'headcount', amount: 68000, qty: 4, growthPct: 3, startMonth: 2 },
        { section: 'operating', label: 'Cell lead', method: 'headcount', amount: 85000, qty: 1, growthPct: 3, startMonth: 1 },
        { section: 'operating', label: 'Power, coolant and maintenance', method: 'fixed_monthly', amount: 6500, startMonth: 3 },
        { section: 'capital', label: 'Two 5-axis machines with probing', method: 'one_time', amount: 980000, lifeYears: 10 },
        { section: 'capital', label: 'Foundation, power drops and chip handling', method: 'one_time', amount: 140000, lifeYears: 15, startMonth: 1 },
      ] }));
    await asActor(alex, (tx) => submitProforma(tx, alex, cell.id));
    const step = (await db.query(`SELECT s.id FROM approval_step s JOIN approval_request r ON r.id = s.request_id WHERE r.subject_type = 'proforma' AND r.subject_id = $1 AND s.status = 'pending'`, [cell.id])).rows[0];
    // The owner approves business cases unless an administrator names an approver (D-167).
    await asActor(admin, (tx) => decideApproval(tx, admin, step.id, { decision: 'approve', comment: 'Volumes match the Lakeshore award letter; capital is in next year\'s plan.' }));
    // Draft: replacing the Dayton air compressors, still on example-free drivers but not yet submitted.
    await asActor(alex, (tx) => createProforma(tx, alex, { facilityId: t.facilities.DAY!, title: 'Replace Dayton air compressors with a VSD unit', kind: 'capital_project', startMonth: `${y}-04`, years: 8,
      discountRatePct: 9, lines: [
        { section: 'revenue', label: 'Energy saved', method: 'fixed_monthly', amount: 4200, growthPct: 3, startMonth: 2 },
        { section: 'revenue', label: 'Leak and repair calls avoided', method: 'fixed_monthly', amount: 900, startMonth: 2 },
        { section: 'operating', label: 'Service contract', method: 'fixed_monthly', amount: 650, startMonth: 2 },
        { section: 'capital', label: 'VSD compressor, dryer and piping', method: 'one_time', amount: 168000, lifeYears: 12 },
      ] }));
    log('  approved: second 5-axis cell at FTW; draft: compressor replacement at DAY');
  }

  log('Ridgeline: daily reminder sweep');
  log(`  ${JSON.stringify(await runReminders(t.tenantId))}`);

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
const h = await seedHarborview();
const m = await seedNorthwindMarket();
const k = await seedKessler(blobs);
const tokens = { ...r.tokens, ...n.tokens, ...h.tokens, ...m.tokens, ...k.tokens };
// A first company archive (D-165) so the Archives screen has one to browse; the daily job takes them from here on.
await createArchive(blobs, r.tenantId, 'scheduled', null);
log('Ridgeline: first company archive taken');
await mkdir(config.storageDir, { recursive: true });
await writeFile(path.join(config.storageDir, 'dev-tokens.json'), JSON.stringify(tokens, null, 2));
const counts = (await getAdminPool().query(`SELECT (SELECT count(*) FROM asset) assets, (SELECT count(*) FROM work_order) work_orders,
  (SELECT count(*) FROM asset_state_event) state_events, (SELECT count(*) FROM audit_event) audit_events`)).rows[0];
log('\ntotals:', counts);
log(`\ndev tokens written to ${path.join(config.storageDir, 'dev-tokens.json')}:`);
for (const [k, v] of Object.entries(tokens)) log(`  ${k.padEnd(44)} ${v}`);
await closePools();
