import type pg from 'pg';
import { generateToken, hashToken } from '../auth/actor.js';
import { DEFAULT_EARNING_CODES, DEFAULT_EXPENSE_CATEGORIES, DEFAULT_EXPENSE_RULES, DEFAULT_SPEND_CATEGORIES, LITE_EXPENSE_RULES, LITE_LIMITS, DEFAULT_PURCHASE_RULES, DEFAULT_SCRAP_REASONS, ROLE_TEMPLATES } from '../auth/permissions.js';

/**
 * Tenant provisioning and user administration run with the owner connection (outside RLS) and are
 * reserved for the control plane: signup, support tooling, seeding and tests. Request handlers never
 * use this path.
 */
export interface ProvisionInput {
  slug: string;
  name: string;
  legalEntity: string;
  facilities: { code: string; name: string; timezone: string; modules?: string[]; kind?: 'plant' | 'property' | 'store' | 'warehouse' | 'office' | 'other' }[];
  downtimeReasons?: { code: string; label: string; category: 'planned' | 'unplanned' }[];
  /** Property cap (D-127): active properties allowed, at most 100 (the default). */
  propertyCap?: number;
  /** Edition (D-135): 'lite' limits the tenant to one site and five users, routes expenses to the owner, allows single-person approval. */
  edition?: 'lite' | 'standard';
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

/** Response and completion targets in hours by work order priority (1 = emergency); tenants change them. */
export const DEFAULT_SERVICE_LEVELS = [
  { priority: 1, respond: 4, complete: 24 }, { priority: 2, respond: 24, complete: 72 }, { priority: 3, respond: 72, complete: 240 }, { priority: 4, respond: null, complete: null },
];

export async function provisionTenant(db: pg.Pool | pg.Client, input: ProvisionInput) {
  await db.query('BEGIN');
  try {
    const t = (await db.query('INSERT INTO tenant (slug, name) VALUES ($1, $2) RETURNING id', [input.slug, input.name])).rows[0];
    const lite = input.edition === 'lite';
    await db.query('INSERT INTO tenant_license (tenant_id, property_cap, edition, user_cap, site_cap, single_person_approval) VALUES ($1, $2, $3, $4, $5, $6)',
      [t.id, input.propertyCap ?? 100, input.edition ?? 'standard', lite ? LITE_LIMITS.userCap : null, lite ? LITE_LIMITS.siteCap : null, lite]);
    const le = (await db.query('INSERT INTO legal_entity (tenant_id, name) VALUES ($1, $2) RETURNING id', [t.id, input.legalEntity])).rows[0];
    const facilities: Record<string, string> = {};
    for (const f of input.facilities) {
      const row = (await db.query('INSERT INTO facility (tenant_id, legal_entity_id, code, name, timezone, kind) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id',
        [t.id, le.id, f.code, f.name, f.timezone, f.kind ?? 'plant'])).rows[0];
      facilities[f.code] = row.id;
      for (const m of f.modules ?? DEFAULT_MODULES) {
        await db.query('INSERT INTO facility_entitlement (tenant_id, facility_id, module_key) VALUES ($1, $2, $3)', [t.id, row.id, m]);
      }
    }
    const roles: Record<string, string> = {};
    for (const [key, r] of Object.entries(ROLE_TEMPLATES)) {
      roles[key] = (await db.query('INSERT INTO role (tenant_id, key, name, permissions) VALUES ($1, $2, $3, $4) RETURNING id', [t.id, key, r.name, r.permissions])).rows[0].id;
    }
    for (const r of DEFAULT_SCRAP_REASONS) await db.query('INSERT INTO scrap_reason (tenant_id, code, label) VALUES ($1, $2, $3)', [t.id, r.code, r.label]);
    for (const c of DEFAULT_EARNING_CODES) {
      await db.query('INSERT INTO earning_code (tenant_id, code, label, kind) VALUES ($1, $2, $3, $4)', [t.id, c.code, c.label, c.kind]);
    }
    for (const r of DEFAULT_PURCHASE_RULES) {
      await db.query('INSERT INTO purchase_approval_rule (tenant_id, spend_type, min_amount, stage, role_key, label) VALUES ($1, $2, $3, $4, $5, $6)',
        [t.id, r.spendType, r.minAmount, r.stage, r.roleKey, r.label]);
    }
    await db.query('INSERT INTO expense_policy (tenant_id) VALUES ($1)', [t.id]);
    for (const c of DEFAULT_EXPENSE_CATEGORIES) {
      await db.query('INSERT INTO expense_category (tenant_id, code, name, kind, needs_attendees, account_key, sort_order) VALUES ($1, $2, $3, $4, $5, $6, $7)',
        [t.id, c.code, c.name, c.kind, c.needsAttendees ?? false, c.accountKey, c.order]);
    }
    for (const c of DEFAULT_SPEND_CATEGORIES) {
      await db.query('INSERT INTO spend_category (tenant_id, code, name, account_keys, sort_order) VALUES ($1, $2, $3, $4, $5)', [t.id, c.code, c.name, c.keys, c.order]);
    }
    for (const x of lite ? LITE_EXPENSE_RULES : DEFAULT_EXPENSE_RULES) {
      await db.query('INSERT INTO expense_approval_rule (tenant_id, min_amount, stage, approver, role_key, label) VALUES ($1, $2, $3, $4, $5, $6)',
        [t.id, x.minAmount, x.stage, x.approver, x.roleKey, x.label]);
    }
    for (const l of DEFAULT_SERVICE_LEVELS) {
      await db.query('INSERT INTO service_level (tenant_id, priority, respond_hours, complete_hours) VALUES ($1, $2, $3, $4)', [t.id, l.priority, l.respond, l.complete]);
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
  /** facility: facility id, or null for all facilities (corporate); group: a facility group id instead of one facility. */
  roles: { role: string; facility: string | null; group?: string }[];
  /** Label shown on the Tokens screen for the first token (default "dev token"). */
  tokenLabel?: string;
}

/** Creates a user with role assignments and returns a new API token (shown once; only its hash is stored). */
export async function createUserWithToken(db: pg.Pool | pg.Client, tenantId: string, input: UserInput) {
  const u = (await db.query('INSERT INTO app_user (tenant_id, email, display_name, employee_id) VALUES ($1, $2, $3, $4) RETURNING id',
    [tenantId, input.email, input.displayName, input.employeeId ?? null])).rows[0];
  for (const r of input.roles) {
    const role = (await db.query('SELECT id FROM role WHERE tenant_id = $1 AND key = $2', [tenantId, r.role])).rows[0];
    if (!role) throw new Error(`unknown role ${r.role}`);
    await db.query('INSERT INTO user_role_assignment (tenant_id, user_id, role_id, facility_id, facility_group_id) VALUES ($1, $2, $3, $4, $5)',
      [tenantId, u.id, role.id, r.group ? null : r.facility, r.group ?? null]);
  }
  const token = generateToken();
  await db.query('INSERT INTO api_token (tenant_id, user_id, token_hash, label) VALUES ($1, $2, $3, $4)', [tenantId, u.id, hashToken(token), input.tokenLabel ?? 'dev token']);
  return { userId: u.id as string, token };
}
