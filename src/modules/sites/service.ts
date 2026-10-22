import type { Actor } from '../../platform/auth/actor.js';
import { generateToken, hashToken, requirePermission } from '../../platform/auth/actor.js';
import { audit } from '../../platform/audit/audit.js';
import type { Tx } from '../../platform/db/tx.js';
import { getPool } from '../../platform/db/pool.js';
import { many, one, withTx } from '../../platform/db/tx.js';
import { conflict, invalid, notFound } from '../../platform/errors.js';
import { notify, usersWithPermission } from '../../platform/notify/notify.js';
import { DEFAULT_MODULES } from '../../platform/tenancy/provision.js';

export const SITE_KINDS = ['plant', 'property', 'store', 'warehouse', 'office', 'other'] as const;
export type SiteKind = (typeof SITE_KINDS)[number];
export interface Address { line1?: string | null; line2?: string | null; city?: string | null; region?: string | null; postal?: string | null; country?: string | null }

/**
 * Sites (facilities) with their kind, address, groups and a few counts. Row-level security limits the list to the
 * sites the reader holds a grant on (all of them for tenant-wide roles).
 */
export async function listSites(tx: Tx, actor: Actor, q: { kind?: SiteKind; groupId?: string; search?: string } = {}) {
  requirePermission(actor, 'org.view');
  const rows = await many(tx, `SELECT f.id, f.code, f.name, f.kind, f.timezone, f.address, f.active,
      coalesce((SELECT array_agg(g.code ORDER BY g.code) FROM facility_group_member m JOIN facility_group g ON g.id = m.group_id WHERE m.facility_id = f.id), '{}') AS groups,
      (SELECT count(*)::int FROM asset a WHERE a.facility_id = f.id AND a.lifecycle_status = 'active' AND a.asset_class <> 'space') AS assets,
      (SELECT count(*)::int FROM asset a WHERE a.facility_id = f.id AND a.lifecycle_status = 'active' AND a.asset_class = 'space') AS spaces,
      (SELECT count(*)::int FROM work_order w WHERE w.facility_id = f.id AND w.status IN ('planned', 'scheduled', 'in_progress', 'on_hold')) AS open_work,
      (SELECT count(*)::int FROM maintenance_request r WHERE r.facility_id = f.id AND r.status = 'open') AS open_requests
    FROM facility f
    WHERE ($1::text IS NULL OR f.kind = $1) AND ($2::uuid IS NULL OR EXISTS (SELECT 1 FROM facility_group_member m WHERE m.facility_id = f.id AND m.group_id = $2))
      AND ($3::text IS NULL OR f.code ILIKE '%' || $3 || '%' OR f.name ILIKE '%' || $3 || '%' OR f.address->>'city' ILIKE '%' || $3 || '%')
    ORDER BY f.active DESC, f.code`, [q.kind ?? null, q.groupId ?? null, q.search?.trim() || null]);
  return rows;
}

export async function saveSite(tx: Tx, actor: Actor, input: { id?: string; code: string; name: string; kind: SiteKind; timezone?: string; address?: Address; active?: boolean }) {
  requirePermission(actor, 'tenant.admin');
  if (!input.code?.trim() || !input.name?.trim()) throw invalid('a site needs a code and a name');
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,29}$/.test(input.code.trim())) throw invalid('site codes are up to 30 letters, digits, dots, dashes or underscores');
  const tz = input.timezone ?? 'America/New_York';
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); } catch { throw invalid(`unknown time zone ${tz}`); }
  const address = Object.fromEntries(Object.entries(input.address ?? {}).filter(([, v]) => v != null && String(v).trim()).map(([k, v]) => [k, String(v).trim()]));
  if (input.id) {
    const cur = await one(tx, 'SELECT * FROM facility WHERE id = $1 FOR UPDATE', [input.id]);
    if (!cur) throw notFound('site');
    if (await one(tx, 'SELECT 1 FROM facility WHERE lower(code) = lower($1) AND id <> $2', [input.code.trim(), input.id])) throw conflict(`site ${input.code} already exists`);
    const f = await one(tx, 'UPDATE facility SET code = $2, name = $3, kind = $4, timezone = $5, address = $6, active = $7 WHERE id = $1 RETURNING *',
      [input.id, input.code.trim(), input.name.trim(), input.kind, tz, address, input.active ?? cur.active]);
    await audit(tx, actor, { action: 'site.updated', entityType: 'facility', entityId: f.id, facilityId: f.id, data: { code: f.code, kind: f.kind, active: f.active } });
    return f;
  }
  if (await one(tx, 'SELECT 1 FROM facility WHERE lower(code) = lower($1)', [input.code.trim()])) throw conflict(`site ${input.code} already exists`);
  const le = await one(tx, 'SELECT id FROM legal_entity ORDER BY created_at LIMIT 1');
  const f = await one(tx, `INSERT INTO facility (tenant_id, legal_entity_id, code, name, kind, timezone, address) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
    [actor.tenantId, le.id, input.code.trim(), input.name.trim(), input.kind, tz, address]);
  for (const m of DEFAULT_MODULES) await tx.query('INSERT INTO facility_entitlement (tenant_id, facility_id, module_key) VALUES ($1, $2, $3)', [actor.tenantId, f.id, m]);
  await audit(tx, actor, { action: 'site.created', entityType: 'facility', entityId: f.id, facilityId: f.id, data: { code: f.code, kind: f.kind } });
  return f;
}

// ---------------------------------------------------------------------------
// Groups (portfolio, region, district) and grants on them
// ---------------------------------------------------------------------------

export async function listGroups(tx: Tx, actor: Actor) {
  requirePermission(actor, 'org.view');
  return many(tx, `SELECT g.id, g.code, g.name, g.kind, coalesce(array_agg(f.code ORDER BY f.code) FILTER (WHERE f.id IS NOT NULL), '{}') AS sites,
      coalesce(array_agg(f.id) FILTER (WHERE f.id IS NOT NULL), '{}') AS facility_ids
    FROM facility_group g LEFT JOIN facility_group_member m ON m.group_id = g.id LEFT JOIN facility f ON f.id = m.facility_id GROUP BY g.id ORDER BY g.kind, g.code`);
}

/** Creates or replaces a group and its members. Members take effect for group grants at the holders' next sign-in. */
export async function saveGroup(tx: Tx, actor: Actor, input: { id?: string; code: string; name: string; kind: 'portfolio' | 'region' | 'district' | 'other'; facilityIds: string[] }) {
  requirePermission(actor, 'tenant.admin');
  if (!input.code?.trim() || !input.name?.trim()) throw invalid('a group needs a code and a name');
  const ids = [...new Set(input.facilityIds)];
  const known = await many(tx, 'SELECT id FROM facility WHERE id = ANY ($1)', [ids]);
  if (known.length !== ids.length) throw invalid('unknown site in the group');
  let g;
  if (input.id) {
    g = await one(tx, 'UPDATE facility_group SET code = $2, name = $3, kind = $4 WHERE id = $1 RETURNING *', [input.id, input.code.trim(), input.name.trim(), input.kind]);
    if (!g) throw notFound('group');
    await tx.query('DELETE FROM facility_group_member WHERE group_id = $1', [g.id]);
  } else {
    if (await one(tx, 'SELECT 1 FROM facility_group WHERE lower(code) = lower($1)', [input.code.trim()])) throw conflict(`group ${input.code} already exists`);
    g = await one(tx, 'INSERT INTO facility_group (tenant_id, code, name, kind) VALUES ($1, $2, $3, $4) RETURNING *', [actor.tenantId, input.code.trim(), input.name.trim(), input.kind]);
  }
  for (const f of ids) await tx.query('INSERT INTO facility_group_member (tenant_id, group_id, facility_id) VALUES ($1, $2, $3)', [actor.tenantId, g.id, f]);
  await audit(tx, actor, { action: 'site_group.saved', entityType: 'facility_group', entityId: g.id, data: { code: g.code, kind: g.kind, sites: ids.length } });
  return g;
}

/** Users and their grants (tenant-wide, one site, or a group), for administrators. */
export async function listUserGrants(tx: Tx, actor: Actor) {
  requirePermission(actor, 'tenant.admin');
  return many(tx, `SELECT u.id, u.display_name, u.email, u.status,
      coalesce(json_agg(json_build_object('id', a.id, 'role', r.key, 'roleName', r.name, 'facility', f.code, 'group', g.code) ORDER BY r.key) FILTER (WHERE a.id IS NOT NULL), '[]') AS grants
    FROM app_user u LEFT JOIN user_role_assignment a ON a.user_id = u.id LEFT JOIN role r ON r.id = a.role_id
    LEFT JOIN facility f ON f.id = a.facility_id LEFT JOIN facility_group g ON g.id = a.facility_group_id
    GROUP BY u.id ORDER BY u.display_name`);
}

export async function grantRole(tx: Tx, actor: Actor, input: { userId: string; roleKey: string; facilityId?: string | null; groupId?: string | null }) {
  requirePermission(actor, 'tenant.admin');
  if (input.facilityId && input.groupId) throw invalid('grant on one site or on a group, not both');
  const role = await one(tx, 'SELECT id FROM role WHERE key = $1', [input.roleKey]);
  if (!role) throw invalid(`unknown role ${input.roleKey}`);
  if (!(await one(tx, 'SELECT 1 FROM app_user WHERE id = $1', [input.userId]))) throw notFound('user');
  const r = await one(tx, `INSERT INTO user_role_assignment (tenant_id, user_id, role_id, facility_id, facility_group_id) VALUES ($1, $2, $3, $4, $5)
    ON CONFLICT ON CONSTRAINT user_role_assignment_scope_key DO NOTHING RETURNING id`, [actor.tenantId, input.userId, role.id, input.facilityId ?? null, input.groupId ?? null]);
  if (!r) throw conflict('the user already has this role there');
  await audit(tx, actor, { action: 'role.granted', entityType: 'app_user', entityId: input.userId, facilityId: input.facilityId ?? null, data: { role: input.roleKey, groupId: input.groupId ?? null } });
  return r;
}

export async function revokeGrant(tx: Tx, actor: Actor, grantId: string) {
  requirePermission(actor, 'tenant.admin');
  const a = await one(tx, 'DELETE FROM user_role_assignment WHERE id = $1 RETURNING user_id, role_id, facility_id, facility_group_id', [grantId]);
  if (!a) throw notFound('grant');
  if (a.user_id === actor.userId) throw invalid('you cannot remove your own grants');
  await audit(tx, actor, { action: 'role.revoked', entityType: 'app_user', entityId: a.user_id, facilityId: a.facility_id, data: { roleId: a.role_id, groupId: a.facility_group_id } });
}

// ---------------------------------------------------------------------------
// Requests from people without a login (renters, store staff), through a per-site link
// ---------------------------------------------------------------------------

/** Creates a request link for a site; the token is shown once (only its hash is stored). */
export async function createRequestLink(tx: Tx, actor: Actor, facilityId: string, label: string) {
  requirePermission(actor, 'work_orders.manage', facilityId);
  if (!label?.trim()) throw invalid('label the link (e.g. "Residents, Maple Court")');
  const token = `req_${generateToken().slice(4)}`;
  const l = await one(tx, 'INSERT INTO public_request_link (tenant_id, facility_id, token_hash, label, created_by) VALUES ($1, $2, $3, $4, $5) RETURNING id, label, created_at',
    [actor.tenantId, facilityId, hashToken(token), label.trim(), actor.userId]);
  await audit(tx, actor, { action: 'request_link.created', entityType: 'facility', entityId: facilityId, facilityId, data: { linkId: l.id, label: l.label } });
  return { ...l, token };
}

export async function listRequestLinks(tx: Tx, actor: Actor, facilityId: string) {
  requirePermission(actor, 'work_orders.manage', facilityId);
  return many(tx, `SELECT l.id, l.label, l.active, l.created_at, u.display_name AS created_by,
      (SELECT count(*)::int FROM audit_event e WHERE e.action = 'maintenance_request.public' AND e.data->>'linkId' = l.id::text) AS requests
    FROM public_request_link l JOIN app_user u ON u.id = l.created_by WHERE l.facility_id = $1 ORDER BY l.created_at DESC`, [facilityId]);
}

export async function revokeRequestLink(tx: Tx, actor: Actor, linkId: string) {
  const l = await one(tx, 'SELECT * FROM public_request_link WHERE id = $1 FOR UPDATE', [linkId]);
  if (!l) throw notFound('link');
  requirePermission(actor, 'work_orders.manage', l.facility_id);
  await tx.query('UPDATE public_request_link SET active = false WHERE id = $1', [linkId]);
  await audit(tx, actor, { action: 'request_link.revoked', entityType: 'facility', entityId: l.facility_id, facilityId: l.facility_id, data: { linkId } });
}

async function resolveLink(token: string) {
  if (!/^req_[A-Za-z0-9_-]{20,64}$/.test(token)) return undefined;
  const r = await getPool().query('SELECT tenant_id, facility_id, link_id FROM public_request_resolve($1)', [hashToken(token)]);
  return r.rows[0] as { tenant_id: string; facility_id: string; link_id: string } | undefined;
}
const scopeOf = (l: { tenant_id: string; facility_id: string }) => ({ tenantId: l.tenant_id, userId: null, facilityIds: [l.facility_id], allFacilities: false });

/**
 * What the public form shows: the site's name and its spaces (and equipment people can point at). Nothing else
 * of the tenant is reachable from a link, and an unknown or revoked link looks the same as a malformed one.
 */
export async function publicRequestForm(token: string) {
  const l = await resolveLink(token);
  if (!l) throw notFound('request link');
  return withTx(scopeOf(l), async (tx) => {
    const f = await one(tx, 'SELECT name, kind FROM facility WHERE id = $1', [l.facility_id]);
    // Labelled by building (location) and parent space, e.g. "Building B › Unit 302".
    const places = await many(tx, `SELECT a.id, a.name, coalesce(p.name, loc.name) AS within FROM asset a LEFT JOIN asset p ON p.id = a.parent_asset_id
      LEFT JOIN functional_location loc ON loc.id = a.location_id
      WHERE a.facility_id = $1 AND a.lifecycle_status = 'active' AND a.asset_class = 'space' ORDER BY coalesce(p.name, loc.name, ''), a.name`, [l.facility_id]);
    return { site: f.name, kind: f.kind, places: places.map((p) => ({ id: p.id, label: p.within ? `${p.within} › ${p.name}` : p.name })) };
  });
}

export async function submitPublicRequest(token: string, input: { placeId: string; description: string; name: string; contact: string; entryPermission?: boolean; urgent?: boolean }) {
  const l = await resolveLink(token);
  if (!l) throw notFound('request link');
  if (!input.name?.trim() || !input.contact?.trim()) throw invalid('leave your name and a phone number or email so we can reach you');
  if (!input.description?.trim() || input.description.trim().length < 5) throw invalid('describe the problem');
  return withTx(scopeOf(l), async (tx) => {
    const place = await one(tx, `SELECT id, name FROM asset WHERE id = $1 AND facility_id = $2 AND asset_class = 'space' AND lifecycle_status = 'active'`, [input.placeId, l.facility_id]);
    if (!place) throw invalid('choose where the problem is');
    // Throttle: at most 20 requests an hour per link, so a leaked link cannot flood the queue.
    const recent = await one(tx, `SELECT count(*)::int AS n FROM audit_event WHERE action = 'maintenance_request.public' AND data->>'linkId' = $1 AND occurred_at > now() - interval '1 hour'`, [l.link_id]);
    if (recent.n >= 20) throw conflict('too many requests from this link right now; please call the office');
    const severity = input.urgent ? 'high' : 'medium';
    const r = await one(tx, `INSERT INTO maintenance_request (tenant_id, facility_id, asset_id, requested_by, symptom, severity, source, requester_name, requester_contact, entry_permission)
      VALUES ($1, $2, $3, NULL, $4, $5, 'public', $6, $7, $8) RETURNING id, created_at`,
    [l.tenant_id, l.facility_id, place.id, input.description.trim().slice(0, 4000), severity, input.name.trim().slice(0, 200), input.contact.trim().slice(0, 200), input.entryPermission ?? null]);
    const system = { tenantId: l.tenant_id, userId: null as unknown as string };
    await audit(tx, system, { action: 'maintenance_request.public', entityType: 'maintenance_request', entityId: r.id, facilityId: l.facility_id, data: { linkId: l.link_id, placeId: place.id, urgent: !!input.urgent } });
    await notify(tx, l.tenant_id, await usersWithPermission(tx, 'work_orders.manage', l.facility_id), { kind: 'maintenance.request_received',
      title: `${input.urgent ? 'Urgent request' : 'Request'} from ${input.name.trim()}: ${place.name}`, body: input.description.trim().slice(0, 300), link: '/work-orders',
      subjectType: 'maintenance_request', subjectId: r.id, dedupeKey: `public-request:${r.id}` });
    // Only a reference goes back; the person sees nothing else of the tenant.
    return { reference: `R-${String(r.id).slice(0, 8).toUpperCase()}` };
  });
}
