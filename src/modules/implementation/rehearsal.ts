import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { Actor } from '../../platform/auth/actor.js';
import { asActor, loadActor, requirePermission } from '../../platform/auth/actor.js';
import { audit } from '../../platform/audit/audit.js';
import { getAdminPool } from '../../platform/db/pool.js';
import { conflict, invalid, notFound } from '../../platform/errors.js';
import { createUserWithToken, provisionTenant } from '../../platform/tenancy/provision.js';
import { commitImport, saveProfile, stageImport } from '../imports/service.js';

/**
 * The practice copy (SC-003): a separate company, built from the real one's sites (blank) or from the sample company's (sample), where
 * a customer can rehearse every load, see problem reports and agree the order, with nothing touching real data. Sign-in is by a token shown
 * once at creation. Resetting deletes the practice company completely; the real company never changes.
 */
const SAMPLES = path.resolve(process.env.SAMPLES_DIR ?? 'samples/imports');

async function purgeTenant(tenantId: string) {
  const c = await getAdminPool().connect();
  try {
    await c.query('BEGIN');
    await c.query('SET LOCAL session_replication_role = replica');
    const tables = (await c.query(`SELECT c.relname FROM pg_class c JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = 'tenant_id' AND NOT a.attisdropped
      WHERE c.relnamespace = 'public'::regnamespace AND c.relkind = 'r' AND c.relname NOT IN ('tenant', 'rehearsal_copy') ORDER BY 1`)).rows.map((r) => r.relname as string);
    for (const t of tables) await c.query(`DELETE FROM "${t}" WHERE tenant_id = $1`, [tenantId]);
    await c.query('DELETE FROM rehearsal_copy WHERE practice_tenant_id = $1 OR tenant_id = $1', [tenantId]);
    await c.query('DELETE FROM tenant WHERE id = $1', [tenantId]);
    await c.query('COMMIT');
  } catch (e) { await c.query('ROLLBACK').catch(() => undefined); throw e; } finally { c.release(); }
}

async function sampleLoad(admin: Actor) {
  const loaded: Record<string, number> = {};
  const one = async (file: string, target: string, sourceSystem: string, profile?: string, allowPartial = false) => {
    let profileId: string | undefined;
    if (profile) { const p = JSON.parse(await readFile(path.join(SAMPLES, profile), 'utf8')); profileId = (await saveProfile(admin, { name: p.name, target: p.target, sourceSystem: p.sourceSystem, mapping: p.mapping })).id; }
    const staged = await stageImport(admin, { target, sourceSystem, fileName: path.basename(file), content: await readFile(path.join(SAMPLES, file)), facilityId: null, profileId });
    const done = await commitImport(admin, staged.batchId, { allowPartial });
    loaded[target] = (done.stats.created ?? 0) + (done.stats.updated ?? 0);
  };
  await one('ridgeline/01_payroll_employee_export.csv', 'employees', 'payroll-csv');
  await one('ridgeline/02_equipment_register.xlsx', 'assets', 'ridgeline-equipment-xlsx', 'ridgeline/profiles/equipment-register.json');
  await one('ridgeline/03_storeroom_parts_export.csv', 'parts', 'storeroom-csv', undefined, true);
  await one('ridgeline/07_accounting_vendor_list.csv', 'suppliers', 'accounting-vendors', 'ridgeline/profiles/accounting-vendors.json');
  await one('ridgeline/09_crm_company_export.csv', 'customers', 'crm-companies', 'ridgeline/profiles/crm-company-export.json');
  return loaded;
}

export async function getRehearsal(actor: Actor) {
  const db = getAdminPool();
  const isPractice = (await db.query('SELECT 1 FROM rehearsal_copy WHERE practice_tenant_id = $1', [actor.tenantId])).rowCount;
  if (isPractice) return { exists: false, practiceCopy: true, answer: 'This is a practice copy. Nothing here affects the real company.' };
  const r = (await db.query(`SELECT r.mode, r.created_at, r.loaded, t.name FROM rehearsal_copy r JOIN tenant t ON t.id = r.practice_tenant_id WHERE r.tenant_id = $1`, [actor.tenantId])).rows[0];
  return r ? { exists: true, practiceCopy: false, mode: r.mode as string, name: r.name as string, createdAt: r.created_at as Date, loaded: r.loaded as Record<string, number>,
    answer: `A ${r.mode === 'sample' ? 'practice copy with sample data' : 'blank practice copy with your sites'} exists. Open it to rehearse, or delete it to start over.` }
    : { exists: false, practiceCopy: false, answer: 'No practice copy yet. Make one to rehearse the loads without touching real data.' };
}

export async function createRehearsal(actor: Actor, input: { mode: 'blank' | 'sample' }) {
  requirePermission(actor, 'tenant.admin');
  const db = getAdminPool();
  if ((await getRehearsal(actor)).practiceCopy) throw conflict('this is already a practice copy');
  if ((await db.query('SELECT 1 FROM rehearsal_copy WHERE tenant_id = $1', [actor.tenantId])).rowCount) throw conflict('this company already has a practice copy; delete it to make a new one');
  const t = (await db.query('SELECT slug, name FROM tenant WHERE id = $1', [actor.tenantId])).rows[0];
  if (!t) throw notFound('company');
  const me = (await db.query('SELECT email, display_name FROM app_user WHERE id = $1', [actor.userId])).rows[0];
  const facilities = input.mode === 'sample'
    ? [{ code: 'DAY', name: 'Dayton Plant', timezone: 'America/New_York' }, { code: 'FTW', name: 'Fort Wayne Plant', timezone: 'America/Indiana/Indianapolis' }]
    : (await db.query('SELECT code, name, timezone, kind FROM facility WHERE tenant_id = $1 AND active ORDER BY code', [actor.tenantId])).rows;
  if (!facilities.length) throw invalid('load the company\'s sites first; the practice copy starts from them');
  const client = await db.connect();
  let practice: { tenantId: string; facilities: Record<string, string> };
  let login: { userId: string; token: string };
  try {
    practice = await provisionTenant(client as any, { slug: `${t.slug}-practice`.slice(0, 60), name: `${t.name} (practice copy)`, legalEntity: `${t.name} (practice copy)`, facilities });
    login = await createUserWithToken(client as any, practice.tenantId, { email: me.email, displayName: me.display_name, roles: [{ role: 'admin', facility: null }] });
  } finally { client.release(); }
  let loaded: Record<string, number> = {};
  try {
    if (input.mode === 'sample') loaded = await sampleLoad((await loadActor(practice.tenantId, login.userId))!);
  } catch (e) { await purgeTenant(practice.tenantId); throw e; }
  await db.query(`INSERT INTO rehearsal_copy (tenant_id, practice_tenant_id, mode, created_by, loaded) VALUES ($1, $2, $3, $4, $5)`, [actor.tenantId, practice.tenantId, input.mode, actor.userId, loaded]);
  await asActor(actor, (tx) => audit(tx, actor, { action: 'implementation.rehearsal_created', entityType: 'tenant', entityId: practice.tenantId, data: { mode: input.mode, loaded } }));
  return { mode: input.mode, loaded, accessToken: login.token, note: 'The token is shown once. Use "Open the practice copy" to switch; "Back to the real company" returns you.' };
}

export async function deleteRehearsal(actor: Actor) {
  requirePermission(actor, 'tenant.admin');
  const r = (await getAdminPool().query('SELECT practice_tenant_id FROM rehearsal_copy WHERE tenant_id = $1', [actor.tenantId])).rows[0];
  if (!r) throw notFound('practice copy');
  await purgeTenant(r.practice_tenant_id);
  await asActor(actor, (tx) => audit(tx, actor, { action: 'implementation.rehearsal_deleted', entityType: 'tenant', entityId: r.practice_tenant_id, data: {} }));
}
