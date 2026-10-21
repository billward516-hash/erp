import type pg from 'pg';
import { generateToken, hashToken } from '../auth/actor.js';
import { DEFAULT_EARNING_CODES, DEFAULT_PURCHASE_RULES, ROLE_TEMPLATES } from '../auth/permissions.js';

/**
 * Tenant provisioning and user administration run with the owner connection (outside RLS) and are
 * reserved for the control plane: signup, support tooling, seeding and tests. Request handlers never
 * use this path.
 */
export interface ProvisionInput {
  slug: string;
  name: string;
  legalEntity: string;
  facilities: { code: string; name: string; timezone: string; modules?: string[] }[];
  downtimeReasons?: { code: string; label: string; category: 'planned' | 'unplanned' }[];
}

export const DEFAULT_MODULES = ['core', 'assets', 'maintenance', 'documents', 'imports', 'reporting'];

export const DEFAULT_DOWNTIME_REASONS: NonNullable<ProvisionInput['downtimeReasons']> = [
  { code: 'PM', label: 'Preventive maintenance', category: 'planned' },
  { code: 'SETUP', label: 'Setup / changeover', category: 'planned' },
  { code: 'NO-DEMAND', label: 'No scheduled demand', category: 'planned' },
  { code: 'MECH', label: 'Mechanical failure', category: 'unplanned' },
  { code: 'ELEC', label: 'Electrical / controls failure', category: 'unplanned' },
  { code: 'HYD', label: 'Hydraulic / pneumatic failure', category: 'unplanned' },
  { code: 'TOOL', label: 'Tooling failure', category: 'unplanned' },
  { code: 'MATL', label: 'Waiting for material', category: 'unplanned' },
  { code: 'OPER', label: 'No operator available', category: 'unplanned' },
];

export async function provisionTenant(db: pg.Pool | pg.Client, input: ProvisionInput) {
  await db.query('BEGIN');
  try {
    const t = (await db.query('INSERT INTO tenant (slug, name) VALUES ($1, $2) RETURNING id', [input.slug, input.name])).rows[0];
    const le = (await db.query('INSERT INTO legal_entity (tenant_id, name) VALUES ($1, $2) RETURNING id', [t.id, input.legalEntity])).rows[0];
    const facilities: Record<string, string> = {};
    for (const f of input.facilities) {
      const row = (await db.query('INSERT INTO facility (tenant_id, legal_entity_id, code, name, timezone) VALUES ($1, $2, $3, $4, $5) RETURNING id',
        [t.id, le.id, f.code, f.name, f.timezone])).rows[0];
      facilities[f.code] = row.id;
      for (const m of f.modules ?? DEFAULT_MODULES) {
        await db.query('INSERT INTO facility_entitlement (tenant_id, facility_id, module_key) VALUES ($1, $2, $3)', [t.id, row.id, m]);
      }
    }
    const roles: Record<string, string> = {};
    for (const [key, r] of Object.entries(ROLE_TEMPLATES)) {
      roles[key] = (await db.query('INSERT INTO role (tenant_id, key, name, permissions) VALUES ($1, $2, $3, $4) RETURNING id', [t.id, key, r.name, r.permissions])).rows[0].id;
    }
    for (const c of DEFAULT_EARNING_CODES) {
      await db.query('INSERT INTO earning_code (tenant_id, code, label, kind) VALUES ($1, $2, $3, $4)', [t.id, c.code, c.label, c.kind]);
    }
    for (const r of DEFAULT_PURCHASE_RULES) {
      await db.query('INSERT INTO purchase_approval_rule (tenant_id, spend_type, min_amount, stage, role_key, label) VALUES ($1, $2, $3, $4, $5, $6)',
        [t.id, r.spendType, r.minAmount, r.stage, r.roleKey, r.label]);
    }
    for (const r of input.downtimeReasons ?? DEFAULT_DOWNTIME_REASONS) {
      await db.query('INSERT INTO downtime_reason (tenant_id, code, label, category) VALUES ($1, $2, $3, $4)', [t.id, r.code, r.label, r.category]);
    }
    await db.query('COMMIT');
    return { tenantId: t.id as string, legalEntityId: le.id as string, facilities, roles };
  } catch (e) {
    await db.query('ROLLBACK');
    throw e;
  }
}

export interface UserInput {
  email: string;
  displayName: string;
  employeeId?: string | null;
  /** facility: facility id, or null for all facilities (corporate). */
  roles: { role: string; facility: string | null }[];
}

/** Creates a user with role assignments and returns a new API token (shown once; only its hash is stored). */
export async function createUserWithToken(db: pg.Pool | pg.Client, tenantId: string, input: UserInput) {
  const u = (await db.query('INSERT INTO app_user (tenant_id, email, display_name, employee_id) VALUES ($1, $2, $3, $4) RETURNING id',
    [tenantId, input.email, input.displayName, input.employeeId ?? null])).rows[0];
  for (const r of input.roles) {
    const role = (await db.query('SELECT id FROM role WHERE tenant_id = $1 AND key = $2', [tenantId, r.role])).rows[0];
    if (!role) throw new Error(`unknown role ${r.role}`);
    await db.query('INSERT INTO user_role_assignment (tenant_id, user_id, role_id, facility_id) VALUES ($1, $2, $3, $4)', [tenantId, u.id, role.id, r.facility]);
  }
  const token = generateToken();
  await db.query('INSERT INTO api_token (tenant_id, user_id, token_hash, label) VALUES ($1, $2, $3, $4)', [tenantId, u.id, hashToken(token), 'dev token']);
  return { userId: u.id as string, token };
}
