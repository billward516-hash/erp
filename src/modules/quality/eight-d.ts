import type { Actor } from '../../platform/auth/actor.js';
import { can } from '../../platform/auth/actor.js';
import { audit } from '../../platform/audit/audit.js';
import type { Tx } from '../../platform/db/tx.js';
import { many, one } from '../../platform/db/tx.js';
import { conflict, forbidden, invalid, notFound } from '../../platform/errors.js';
import { notify } from '../../platform/notify/notify.js';

/**
 * 8D problem solving (docs/ARCHITECTURE.md §12t, D-126) is a format of the corrective action: the same record, steps,
 * actions and effectiveness check, with the eight disciplines checked as gates. `disciplines()` is pure and is the
 * single statement of what each discipline needs; moving the corrective action forward requires the disciplines of
 * the step being left.
 */
const CAPA = 'corrective_action';
export const IS_IS_NOT = ['what', 'where', 'when', 'extent'] as const;
export const IS_IS_NOT_LABEL: Record<(typeof IS_IS_NOT)[number], string> = {
  what: 'What (part, defect)', where: 'Where (line, machine, place on the part)', when: 'When (first seen, shift, pattern)', extent: 'How many (quantity, rate, trend)',
};
type IsIsNot = Partial<Record<(typeof IS_IS_NOT)[number], { is?: string | null; isNot?: string | null }>>;

export interface DisciplineInput {
  owner_user_id: string; champion_user_id: string | null; is_is_not: IsIsNot | null; problem: string; containment: string | null; containment_verification: string | null;
  root_cause_method: string | null; root_cause: string | null; escape_point: string | null; escape_root_cause: string | null; root_cause_verification: string | null;
  prevention_note: string | null; status: string; effective: boolean | null; recognition_note: string | null;
}
export interface Discipline { key: string; title: string; done: boolean; missing: string[] }

const has = (s: string | null | undefined, min = 3) => (s?.trim().length ?? 0) >= min;

export function disciplines(c: DisciplineInput, team: { user_id: string }[], actions: { discipline: string | null; status: string }[], readAcross: { applies: boolean | null }[]): Discipline[] {
  const d = (key: string, title: string, missing: (string | false)[]): Discipline => {
    const m = missing.filter((x): x is string => !!x);
    return { key, title, done: m.length === 0, missing: m };
  };
  const members = team.filter((t) => t.user_id !== c.owner_user_id && t.user_id !== c.champion_user_id);
  const iin = c.is_is_not ?? {};
  const live = actions.filter((a) => a.status !== 'cancelled');
  const corrective = live.filter((a) => a.discipline === 'corrective');
  const preventive = live.filter((a) => a.discipline === 'preventive');
  return [
    d('D1', 'Team', [!c.champion_user_id && 'name a champion (who can give the team time and resources)', members.length === 0 && 'add at least one team member besides the leader and champion']),
    d('D2', 'Problem description', [
      !has(c.problem) && 'state the problem',
      !has(iin.what?.is) && 'say what the problem is (part, defect)',
      !has(iin.where?.is) && 'say where it is seen',
      !IS_IS_NOT.some((k) => has(iin[k]?.isNot)) && 'say at least one thing it is not (where or when it does not happen narrows the cause)',
    ]),
    d('D3', 'Interim containment', [!has(c.containment) && 'record the containment (or that none was needed)', !has(c.containment_verification) && 'say how you know the containment works (sort results, checks since)']),
    d('D4', 'Root causes', [
      (!c.root_cause_method || !has(c.root_cause)) && 'state why it happened (occurrence root cause) and how it was found',
      !has(c.escape_point) && 'name where it should have been caught (escape point)',
      !has(c.escape_root_cause) && 'state why it was not caught there (escape root cause)',
      !has(c.root_cause_verification) && 'say how the causes were confirmed (turned the problem on and off, reproduced, data)',
    ]),
    d('D5', 'Permanent corrective actions', [corrective.length === 0 && 'add a corrective action for the root causes']),
    d('D6', 'Implemented and validated', [
      (corrective.length === 0 || corrective.some((a) => a.status === 'open')) && 'complete the corrective actions',
      !['closed'].includes(c.status) && c.effective !== true && 'the effectiveness check, by quality, validates them',
    ]),
    d('D7', 'Prevent recurrence', [
      !has(c.prevention_note) && !preventive.some((a) => a.status === 'done') && 'record the systemic changes (FMEA, control plan, procedures, training) or why none are needed',
      readAcross.some((r) => r.applies == null) && 'decide every read-across',
    ]),
    d('D8', 'Team recognized', [!has(c.recognition_note) && 'recognize the team once it is closed']),
  ];
}

/** Disciplines that must be complete to leave each step. Verification adds D6 (the check itself); D8 follows closure. */
export const GATE: Record<string, string[]> = { open: ['D1', 'D2', 'D3'], root_cause: ['D4'], actions: ['D5', 'D7'] };

export function gateMessage(ds: Discipline[], from: string): string | null {
  const need = GATE[from] ?? [];
  const open = ds.filter((d) => need.includes(d.key) && !d.done);
  if (open.length === 0) return null;
  return open.map((d) => `${d.key} ${d.title}: ${d.missing.join('; ')}`).join(' · ');
}

export async function teamOf(tx: Tx, capaId: string) {
  return many(tx, `SELECT t.id, t.user_id, u.display_name, t.expertise, t.added_at FROM capa_team_member t JOIN app_user u ON u.id = t.user_id WHERE t.capa_id = $1 ORDER BY t.added_at`, [capaId]);
}
export async function readAcrossOf(tx: Tx, capaId: string) {
  return many(tx, `SELECT r.id, r.scope, r.applies, r.note, r.decided_at, u.display_name AS decided_by_name FROM capa_read_across r LEFT JOIN app_user u ON u.id = r.decided_by
    WHERE r.capa_id = $1 ORDER BY r.created_at`, [capaId]);
}

export async function eightDOf(tx: Tx, c: any, actions: { discipline: string | null; status: string }[]) {
  const team = await teamOf(tx, c.id);
  const readAcross = await readAcrossOf(tx, c.id);
  return { team, readAcross, disciplines: c.format === 'eight_d' ? disciplines(c, team, actions, readAcross) : null };
}

async function editable(tx: Tx, actor: Actor, id: string, allowClosed = false) {
  const c = await one(tx, 'SELECT * FROM corrective_action WHERE id = $1 FOR UPDATE', [id]);
  if (!c) throw notFound('corrective action');
  if (c.owner_user_id !== actor.userId && !can(actor, 'quality.manage', c.facility_id) && !(c.source === 'incident' && can(actor, 'safety.manage', c.facility_id))) throw forbidden('quality.manage (or be the owner)');
  if (c.status === 'cancelled' || (!allowClosed && c.status === 'closed')) throw conflict(`corrective action is ${c.status}`);
  if (c.format !== 'eight_d') throw conflict('this corrective action is not an 8D');
  return c;
}

async function assertActiveUser(tx: Tx, userId: string, facilityId: string) {
  const u = await one(tx, `SELECT u.id, u.display_name FROM app_user u WHERE u.id = $1 AND u.status = 'active' AND EXISTS
    (SELECT 1 FROM user_role_scope a WHERE a.user_id = u.id AND (a.facility_id IS NULL OR a.facility_id = $2))`, [userId, facilityId]);
  if (!u) throw invalid('team members must be active users with a role at this facility');
  return u;
}

export async function addTeamMember(tx: Tx, actor: Actor, capaId: string, input: { userId: string; expertise?: string | null }) {
  const c = await editable(tx, actor, capaId);
  const u = await assertActiveUser(tx, input.userId, c.facility_id);
  if (input.userId === c.owner_user_id) throw invalid(`${u.display_name} leads the 8D as its owner`);
  const t = await one(tx, `INSERT INTO capa_team_member (tenant_id, facility_id, capa_id, user_id, expertise, added_by) VALUES ($1, $2, $3, $4, $5, $6)
    ON CONFLICT (capa_id, user_id) DO UPDATE SET expertise = EXCLUDED.expertise RETURNING *`, [actor.tenantId, c.facility_id, capaId, input.userId, input.expertise?.trim() || null, actor.userId]);
  await notify(tx, actor.tenantId, [input.userId], { kind: 'quality.capa_team', title: `You are on the 8D team for ${c.number}: ${c.title}`, link: `/quality/capa/${capaId}`,
    subjectType: CAPA, subjectId: capaId, dedupeKey: `capa-team:${capaId}:${input.userId}` }, actor.userId);
  await audit(tx, actor, { action: 'capa.team_added', entityType: CAPA, entityId: capaId, facilityId: c.facility_id, data: { user: input.userId, expertise: t.expertise } });
  return t;
}

export async function removeTeamMember(tx: Tx, actor: Actor, capaId: string, userId: string) {
  const c = await editable(tx, actor, capaId);
  const r = await tx.query('DELETE FROM capa_team_member WHERE capa_id = $1 AND user_id = $2', [capaId, userId]);
  if (!r.rowCount) throw notFound('team member');
  await audit(tx, actor, { action: 'capa.team_removed', entityType: CAPA, entityId: capaId, facilityId: c.facility_id, data: { user: userId } });
}

export async function addReadAcross(tx: Tx, actor: Actor, capaId: string, scope: string) {
  const c = await editable(tx, actor, capaId);
  if (!scope?.trim()) throw invalid('say where else the same cause could act');
  const r = await one(tx, `INSERT INTO capa_read_across (tenant_id, facility_id, capa_id, scope, created_by) VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [actor.tenantId, c.facility_id, capaId, scope.trim(), actor.userId]);
  await audit(tx, actor, { action: 'capa.read_across_added', entityType: CAPA, entityId: capaId, facilityId: c.facility_id, data: { scope: r.scope } });
  return r;
}

/** Decides a read-across: whether the cause can act there, and what was found or done (an action where it applies). */
export async function decideReadAcross(tx: Tx, actor: Actor, id: string, input: { applies: boolean; note: string }) {
  const r = await one(tx, 'SELECT * FROM capa_read_across WHERE id = $1 FOR UPDATE', [id]);
  if (!r) throw notFound('read-across');
  const c = await editable(tx, actor, r.capa_id);
  if (!has(input.note, 5)) throw invalid(input.applies ? 'say what was done there (or the action that covers it)' : 'say why it does not apply there');
  await tx.query('UPDATE capa_read_across SET applies = $2, note = $3, decided_by = $4, decided_at = now() WHERE id = $1', [id, input.applies, input.note.trim(), actor.userId]);
  await audit(tx, actor, { action: 'capa.read_across_decided', entityType: CAPA, entityId: c.id, facilityId: c.facility_id, data: { scope: r.scope, applies: input.applies, note: input.note } });
}

/** D8: recognizes the team once the 8D is closed as effective; the team is told. */
export async function recognizeTeam(tx: Tx, actor: Actor, capaId: string, note: string) {
  const c = await editable(tx, actor, capaId, true);
  if (c.status !== 'closed') throw conflict('the team is recognized once the effectiveness check has closed the 8D');
  if (!has(note, 10)) throw invalid('say what the team achieved');
  await tx.query('UPDATE corrective_action SET recognition_note = $2, recognized_at = now() WHERE id = $1', [capaId, note.trim()]);
  const team = await teamOf(tx, capaId);
  const to = [...new Set([...team.map((t) => t.user_id), c.champion_user_id, c.owner_user_id].filter((u): u is string => !!u && u !== actor.userId))];
  await notify(tx, actor.tenantId, to, { kind: 'quality.capa_team', title: `${c.number} is closed: thank you`, body: note.trim().slice(0, 300), link: `/quality/capa/${capaId}`,
    subjectType: CAPA, subjectId: capaId, dedupeKey: `capa-recognized:${capaId}` }, actor.userId);
  await audit(tx, actor, { action: 'capa.team_recognized', entityType: CAPA, entityId: capaId, facilityId: c.facility_id, data: { note } });
}

/** True when the user is on the corrective action's team (as member or champion): they may read it. */
export async function onTeam(tx: Tx, c: { id: string; champion_user_id?: string | null }, userId: string) {
  if (c.champion_user_id === userId) return true;
  return !!(await one(tx, 'SELECT 1 FROM capa_team_member WHERE capa_id = $1 AND user_id = $2', [c.id, userId]));
}
