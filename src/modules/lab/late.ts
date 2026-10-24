import type { Actor } from '../../platform/auth/actor.js';
import { can } from '../../platform/auth/actor.js';
import type { Tx } from '../../platform/db/tx.js';
import { many } from '../../platform/db/tx.js';
import type { LateRow, LateSection } from '../late/service.js';
import { reportScope } from '../reporting/definitions.js';

const LIMIT = 40;

/** What is late (SC-007 D): samples past their turnaround target and tests whose sample is past it. Shown only to people who may see lab records, at their sites. */
export async function labLateSections(tx: Tx, actor: Actor): Promise<LateSection[]> {
  if (!can(actor, 'lab.view')) return [];
  const ids = (await reportScope(tx, actor, 'lab.view')).ids;
  if (!ids.length) return [];
  const out: LateSection[] = [];
  const section = (key: string, title: string, rows: LateRow[]) => { if (rows.length) out.push({ key, title, count: rows.length, amount: null, rows: rows.slice(0, LIMIT) }); };
  const samples = await many(tx, `SELECT s.id, s.number, s.description, s.status, (current_date - s.due_on) AS late, c.name AS customer,
      (SELECT string_agg(DISTINCT u.display_name, ', ') FROM lab_test t JOIN app_user u ON u.id = t.assigned_user_id WHERE t.sample_id = s.id AND t.status <> 'cancelled') AS owner
    FROM lab_sample s LEFT JOIN customer c ON c.id = s.customer_id WHERE s.facility_id = ANY ($1) AND s.status NOT IN ('released', 'disposed') AND s.due_on < current_date ORDER BY s.due_on, s.number`, [ids]);
  section('lab-samples', 'Lab samples past their turnaround target', samples.map((r) => ({ label: `${r.number} · ${r.customer ?? 'internal'}`, detail: `${r.description} (${String(r.status).replace(/_/g, ' ')})`,
    owner: r.owner, daysLate: r.late, amount: null, href: `/lab/samples/${r.id}` })));
  const tests = await many(tx, `SELECT t.id, t.status, s.id AS sample_id, s.number, m.code, m.version, (current_date - s.due_on) AS late, u.display_name AS owner
    FROM lab_test t JOIN lab_sample s ON s.id = t.sample_id JOIN lab_method m ON m.id = t.method_id LEFT JOIN app_user u ON u.id = t.assigned_user_id
    WHERE t.facility_id = ANY ($1) AND t.status IN ('assigned', 'entered') AND s.status NOT IN ('released', 'disposed') AND s.due_on < current_date ORDER BY s.due_on, s.number`, [ids]);
  section('lab-tests', 'Lab tests not finished by the sample’s target date', tests.map((r) => ({ label: `${r.number} · ${r.code} v${r.version}`, detail: r.status === 'assigned' ? 'Waiting for results' : 'Waiting for review',
    owner: r.owner, daysLate: r.late, amount: null, href: `/lab/samples/${r.sample_id}` })));
  return out;
}
