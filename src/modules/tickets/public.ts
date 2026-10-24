import { hashToken } from '../../platform/auth/actor.js';
import { getPool } from '../../platform/db/pool.js';
import { many, one, withTx } from '../../platform/db/tx.js';
import { conflict, invalid, notFound } from '../../platform/errors.js';
import { featureSettings } from '../../platform/features.js';
import { notify, usersWithPermission } from '../../platform/notify/notify.js';
import { ONE_HOUR_CAP, createTicketAs } from './service.js';

/*
 * The no-sign-in form behind a per-customer ticket link. The token is the only credential: it names one customer at one site, and the form
 * can do nothing but raise a new ticket for that customer. An unknown, malformed or revoked link all look the same (not found).
 */
async function resolveLink(token: string) {
  if (!/^tkt_[A-Za-z0-9_-]{20,64}$/.test(token)) return undefined;
  const r = await getPool().query('SELECT tenant_id, facility_id, customer_id, link_id FROM ticket_intake_resolve($1)', [hashToken(token)]);
  return r.rows[0] as { tenant_id: string; facility_id: string; customer_id: string; link_id: string } | undefined;
}
const scopeOf = (l: { tenant_id: string; facility_id: string }) => ({ tenantId: l.tenant_id, userId: null, facilityIds: [l.facility_id], allFacilities: false });

/** The feature can be switched off for the whole company (Admin, Features); the link then stops working. */
async function assertOn(tx: Parameters<typeof featureSettings>[0], tenantId: string) {
  if ((await featureSettings(tx, tenantId)).get('tickets')?.mode === 'off') throw notFound('ticket link');
}

export async function publicTicketForm(token: string) {
  const l = await resolveLink(token);
  if (!l) throw notFound('ticket link');
  return withTx(scopeOf(l), async (tx) => {
    await assertOn(tx, l.tenant_id);
    const f = await one(tx, 'SELECT name FROM facility WHERE id = $1', [l.facility_id]);
    const c = await one(tx, 'SELECT name FROM customer WHERE id = $1', [l.customer_id]);
    return { site: f.name as string, customer: c.name as string, categories: await many(tx, 'SELECT id, name FROM ticket_category WHERE active ORDER BY sort_no, name') };
  });
}

export async function submitPublicTicket(token: string, input: { name: string; contact: string; subject: string; description: string; categoryId?: string | null; urgent?: boolean }) {
  const l = await resolveLink(token);
  if (!l) throw notFound('ticket link');
  if (!input.name?.trim() || !input.contact?.trim()) throw invalid('leave your name and a phone number or email so we can reach you');
  if (!input.subject?.trim()) throw invalid('give the request a short title');
  if (!input.description?.trim() || input.description.trim().length < 5) throw invalid('describe what you need');
  return withTx(scopeOf(l), async (tx) => {
    await assertOn(tx, l.tenant_id);
    // Throttle: at most 20 tickets an hour through one link, so a leaked link cannot flood the queue.
    const recent = await one(tx, `SELECT count(*)::int AS n FROM ticket WHERE intake_link_id = $1 AND created_at > now() - interval '1 hour'`, [l.link_id]);
    if (recent.n >= ONE_HOUR_CAP) throw conflict('too many requests from this link right now; please call the support line');
    const name = input.name.trim().slice(0, 200);
    const t = await createTicketAs(tx, { tenantId: l.tenant_id, userId: null, displayName: name }, {
      facilityId: l.facility_id, customerId: l.customer_id, subject: input.subject.trim(), description: input.description.trim().slice(0, 4000), channel: 'public_form',
      // A link can ask for attention (high), never for the top priority; the team sets that.
      priority: input.urgent ? 'high' : 'normal', categoryId: input.categoryId ?? null, requesterName: name, requesterContact: input.contact.trim().slice(0, 200),
    }, { intakeLinkId: l.link_id });
    await notify(tx, l.tenant_id, await usersWithPermission(tx, 'tickets.manage', l.facility_id), { kind: 'ticket.received', title: `New ticket from ${name}: ${t.subject}`, body: t.description?.slice(0, 300) ?? null,
      link: `/tickets/${t.id}`, subjectType: 'ticket', subjectId: t.id, dedupeKey: `ticket-received:${t.id}` });
    return { reference: t.number as string };
  });
}
