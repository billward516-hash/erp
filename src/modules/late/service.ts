import type { Actor } from '../../platform/auth/actor.js';
import { can } from '../../platform/auth/actor.js';
import type { Tx } from '../../platform/db/tx.js';
import { many } from '../../platform/db/tx.js';
import type { Permission } from '../../platform/auth/permissions.js';
import { reportScope } from '../reporting/definitions.js';

/**
 * What is late (SC-005 C): everything with a date that has passed, in one place, from invoices and bills to quotes, orders, work,
 * preventive maintenance, calibration and document reviews. Each section appears only for a person who may see that kind of
 * record, at the sites they may see. Each row has an owner where one is known and a link to the record.
 */
export interface LateRow { label: string; detail: string; owner: string | null; daysLate: number; amount: number | null; href: string }
export interface LateSection { key: string; title: string; count: number; amount: number | null; rows: LateRow[] }
const LIMIT = 40;

export async function whatIsLate(tx: Tx, actor: Actor) {
  const sections: LateSection[] = [];
  const add = (key: string, title: string, rows: (LateRow & { amt?: number })[], total?: number) => {
    if (!rows.length) return;
    const amount = rows.some((r) => r.amount != null) ? rows.reduce((s, r) => s + (r.amount ?? 0), 0) : null;
    sections.push({ key, title, count: total ?? rows.length, amount, rows: rows.slice(0, LIMIT) });
  };
  const sc = async (p: Permission) => (can(actor, p) ? (await reportScope(tx, actor, p)).ids : []);

  const ar = await sc('ar.view');
  if (ar.length) add('invoices', 'Customer invoices past due', (await many(tx, `SELECT i.id, i.number, c.name AS customer, (current_date - i.due_date) AS late, u.display_name AS owner,
      ((SELECT coalesce(sum(l.qty * l.unit_price), 0) FROM customer_invoice_line l WHERE l.invoice_id = i.id) + i.tax_amount + i.freight_amount - (SELECT coalesce(sum(a.amount), 0) FROM payment_allocation a WHERE a.invoice_id = i.id))::float AS open
    FROM customer_invoice i JOIN customer c ON c.id = i.customer_id LEFT JOIN app_user u ON u.id = c.owner_user_id
    WHERE i.facility_id = ANY ($1) AND i.status IN ('issued', 'partially_paid') AND i.due_date < current_date ORDER BY i.due_date`, [ar]))
    .map((r) => ({ label: `${r.number} · ${r.customer}`, detail: 'Unpaid after its due date', owner: r.owner, daysLate: r.late, amount: r.open, href: `/receivables` })));

  const ap = await sc('ap.view');
  if (ap.length) add('bills', 'Supplier bills past due', (await many(tx, `SELECT i.id, i.invoice_number, s.name AS supplier, (current_date - i.due_date) AS late, u.display_name AS owner, i.status,
      ((SELECT coalesce(sum(l.qty * l.unit_price), 0) FROM supplier_invoice_line l WHERE l.invoice_id = i.id) + i.tax_amount + i.freight_amount)::float AS amount
    FROM supplier_invoice i JOIN supplier s ON s.id = i.supplier_id LEFT JOIN app_user u ON u.id = i.captured_by
    WHERE i.facility_id = ANY ($1) AND i.status IN ('captured', 'approved', 'exported', 'disputed') AND i.due_date < current_date ORDER BY i.due_date`, [ap]))
    .map((r) => ({ label: `${r.invoice_number} · ${r.supplier}`, detail: r.status === 'captured' ? 'Not yet approved' : r.status === 'disputed' ? 'Disputed' : 'Approved, unpaid', owner: r.owner, daysLate: r.late, amount: r.amount, href: `/ap` })));

  const pu = await sc('purchasing.view');
  if (pu.length) add('orders', 'Purchase orders past the promised date', (await many(tx, `SELECT o.id, o.number, s.name AS supplier, (current_date - o.expected_on) AS late, u.display_name AS owner,
      sum((l.qty_ordered - l.qty_received) * l.unit_price)::float AS open
    FROM purchase_order o JOIN purchase_order_line l ON l.order_id = o.id JOIN supplier s ON s.id = o.supplier_id LEFT JOIN app_user u ON u.id = o.created_by
    WHERE o.facility_id = ANY ($1) AND o.status IN ('open', 'partially_received') AND l.qty_received < l.qty_ordered AND o.expected_on < current_date GROUP BY o.id, s.name, u.display_name ORDER BY o.expected_on`, [pu]))
    .map((r) => ({ label: `${r.number} · ${r.supplier}`, detail: 'Delivery not complete', owner: r.owner, daysLate: r.late, amount: r.open, href: `/purchasing` })));

  const sa = await sc('sales.view');
  if (sa.length) add('quotes', 'Quotes expired without a decision', (await many(tx, `SELECT q.id, q.number, c.name AS customer, (current_date - q.valid_until) AS late, u.display_name AS owner,
      (SELECT coalesce(sum(l.qty * l.unit_price), 0) FROM quote_line l WHERE l.quote_id = q.id)::float AS amount
    FROM quote q JOIN customer c ON c.id = q.customer_id LEFT JOIN app_user u ON u.id = q.created_by
    WHERE q.facility_id = ANY ($1) AND q.status = 'sent' AND q.valid_until < current_date ORDER BY q.valid_until`, [sa]))
    .map((r) => ({ label: `${r.number} · ${r.customer}`, detail: 'Sent, never decided, now expired', owner: r.owner, daysLate: r.late, amount: r.amount, href: `/sales` })));
  if (sa.length) add('orders-ship', 'Sales orders late to ship', (await many(tx, `SELECT o.id, o.number, c.name AS customer, (current_date - o.promised_date) AS late, u.display_name AS owner
    FROM sales_order o JOIN customer c ON c.id = o.customer_id LEFT JOIN app_user u ON u.id = o.created_by
    WHERE o.facility_id = ANY ($1) AND o.status IN ('open', 'partially_shipped') AND o.promised_date < current_date ORDER BY o.promised_date`, [sa]).catch(() => []))
    .map((r) => ({ label: `${r.number} · ${r.customer}`, detail: 'Promised date has passed', owner: r.owner, daysLate: r.late, amount: null, href: `/sales` })));

  const wo = await sc('work_orders.view');
  if (wo.length) {
    add('work', 'Work orders past their due date', (await many(tx, `SELECT w.id, w.number, w.title, a.asset_tag, (current_date - w.due_at::date) AS late,
        (SELECT string_agg(e.first_name || ' ' || e.last_name, ', ') FROM work_order_assignment x JOIN employee e ON e.id = x.employee_id WHERE x.work_order_id = w.id) AS owner
      FROM work_order w JOIN asset a ON a.id = w.asset_id WHERE w.facility_id = ANY ($1) AND w.status NOT IN ('completed', 'verified', 'closed', 'cancelled') AND w.due_at < now() ORDER BY w.due_at`, [wo]))
      .map((r) => ({ label: `${r.number} · ${r.asset_tag}`, detail: r.title, owner: r.owner, daysLate: r.late, amount: null, href: `/work-orders/${r.id}` })));
    add('pm', 'Preventive maintenance overdue', (await many(tx, `SELECT p.id, p.code, p.title, a.asset_tag, (current_date - p.next_due_on) AS late FROM pm_plan p JOIN asset a ON a.id = p.asset_id
      WHERE p.facility_id = ANY ($1) AND p.active AND p.next_due_on < current_date ORDER BY p.next_due_on`, [wo]))
      .map((r) => ({ label: `${r.asset_tag} · ${r.title}`, detail: `Plan ${r.code}`, owner: null, daysLate: r.late, amount: null, href: `/pm` })));
  }
  const pr = await sc('production.view');
  if (pr.length) add('production', 'Production orders past their due date', (await many(tx, `SELECT o.id, o.number, p.part_number, (current_date - o.due_date) AS late, u.display_name AS owner FROM production_order o JOIN part p ON p.id = o.part_id LEFT JOIN app_user u ON u.id = o.created_by
    WHERE o.facility_id = ANY ($1) AND o.status IN ('planned', 'released', 'in_progress') AND o.due_date < current_date ORDER BY o.due_date`, [pr]))
    .map((r) => ({ label: `${r.number} · ${r.part_number}`, detail: 'Not complete by its due date', owner: r.owner, daysLate: r.late, amount: null, href: `/production/${r.id}` })));
  const qa = await sc('quality.view');
  if (qa.length) add('calibration', 'Calibrations overdue', (await many(tx, `SELECT p.id, a.asset_tag, a.name, (current_date - p.next_due) AS late FROM calibration_plan p JOIN asset a ON a.id = p.asset_id
    WHERE p.facility_id = ANY ($1) AND p.active AND p.next_due < current_date ORDER BY p.next_due`, [qa]))
    .map((r) => ({ label: `${r.asset_tag} · ${r.name}`, detail: 'Instrument past its calibration date', owner: null, daysLate: r.late, amount: null, href: `/quality?tab=calibration` })));
  if (can(actor, 'documents.view')) {
    add('spec-reviews', 'Specification reviews overdue', (await many(tx, `SELECT r.id, d.doc_number, d.title, (current_date - r.due_on) AS late, u.display_name AS owner FROM spec_review r JOIN document d ON d.id = r.document_id LEFT JOIN app_user u ON u.id = r.assigned_to
      WHERE r.status = 'open' AND r.due_on < current_date ORDER BY r.due_on`))
      .map((r) => ({ label: `${r.doc_number} · ${r.title}`, detail: 'Customer revision awaiting its impact review', owner: r.owner, daysLate: r.late, amount: null, href: `/documents` })));
    add('reads', 'Readings not acknowledged', (await many(tx, `SELECT d.id, d.doc_number, d.title, count(*)::int AS people, max(current_date - o.due_on) AS late FROM document_read_obligation o JOIN document d ON d.id = o.document_id
      WHERE o.acknowledged_at IS NULL AND o.superseded_at IS NULL AND o.due_on < current_date GROUP BY d.id ORDER BY max(current_date - o.due_on) DESC`))
      .map((r) => ({ label: `${r.doc_number} · ${r.title}`, detail: `${r.people} ${r.people === 1 ? 'person has' : 'people have'} not read it`, owner: null, daysLate: r.late, amount: null, href: `/documents/${r.id}` })));
  }
  const total = sections.reduce((s, x) => s + x.count, 0);
  const answer = !sections.length ? 'Nothing you can see is past its date.'
    : `${total} item${total === 1 ? ' is' : 's are'} past ${total === 1 ? 'its' : 'their'} date: ${sections.slice().sort((a, b) => b.count - a.count).slice(0, 4).map((s) => `${s.count} ${s.title.toLowerCase()}`).join('; ')}.`;
  return { answer, total, sections };
}
