import type { Actor } from '../../platform/auth/actor.js';
import { can } from '../../platform/auth/actor.js';
import type { Tx } from '../../platform/db/tx.js';
import { many } from '../../platform/db/tx.js';
import { notify, usersWithPermission } from '../../platform/notify/notify.js';
import { reportScope } from '../reporting/definitions.js';
import type { sweepSettings } from '../reminders/settings.js';
import { olderThanYears } from './rules.js';

/**
 * Chemical alerts (SC-007 C). Two reminders go through the catalogue and the daily sweep (one summary per site per period, so a
 * second run the same day adds nothing): containers and preparations reaching their use-by date, and parts with no safety data
 * sheet or one older than the company's limit. Expired containers still in storage also show on What is late.
 */
type Sweep = Awaited<ReturnType<typeof sweepSettings>>;

export async function chemicalReminders(tx: Tx, tenantId: string, today: string, R: Sweep, facilities: { id: string; code: string }[], add: (key: string, n: number) => void) {
  if (R.on('chemical_expiring')) {
    const lead = R.lead('chemical_expiring');
    for (const f of facilities) {
      const items = await many(tx, `SELECT 'Container ' || c.number || ' ' || p.part_number AS label, c.use_by AS due FROM chemical_container c JOIN part p ON p.id = c.part_id
          WHERE c.facility_id = $1 AND c.status IN ('in_storage', 'in_use') AND c.use_by <= $2::date + $3::int
        UNION ALL SELECT 'Preparation ' || x.number || ' ' || x.name, x.expires_on FROM chemical_preparation x
          WHERE x.facility_id = $1 AND x.status = 'active' AND x.expires_on <= $2::date + $3::int ORDER BY 2, 1`, [f.id, today, lead]);
      if (!items.length) continue;
      const expired = items.filter((i) => i.due < today).length;
      add('chemical_expiring', await notify(tx, tenantId, await usersWithPermission(tx, 'chemicals.manage', f.id), { kind: 'reminder.chemical_expiring',
        title: `${f.code}: ${expired ? `${expired} chemical item${expired === 1 ? '' : 's'} past use-by, ` : ''}${items.length - expired} reaching use-by within ${lead} days`,
        body: items.slice(0, 6).map((i) => `${i.label} ${i.due}`).join('; '), link: '/chemicals', dedupeKey: `chem-expiring:${f.id}:${R.period('chemical_expiring')}` }));
    }
  }
  if (R.on('chemical_exceptions')) {
    const years = (await many(tx, 'SELECT sds_max_age_years FROM chemical_setting'))[0]?.sds_max_age_years ?? 3;
    for (const f of facilities) {
      const parts = await many(tx, `SELECT DISTINCT p.part_number, cp.sds_document_id, cp.sds_revision_on FROM chemical_part cp JOIN part p ON p.id = cp.part_id JOIN chemical_container c ON c.part_id = cp.part_id
        WHERE cp.is_chemical AND c.facility_id = $1 AND c.status IN ('in_storage', 'in_use') ORDER BY p.part_number`, [f.id]);
      const none = parts.filter((p) => !p.sds_document_id);
      const old = parts.filter((p) => p.sds_document_id && p.sds_revision_on && olderThanYears(p.sds_revision_on, years, today));
      if (!none.length && !old.length) continue;
      add('chemical_exceptions', await notify(tx, tenantId, await usersWithPermission(tx, 'chemicals.manage', f.id), { kind: 'reminder.chemical_exceptions',
        title: `${f.code}: ${[none.length ? `${none.length} stored chemical${none.length === 1 ? '' : 's'} with no safety data sheet` : '', old.length ? `${old.length} with a sheet older than ${years} years` : ''].filter(Boolean).join(', ')}`,
        body: [...none, ...old].slice(0, 8).map((p) => p.part_number).join(', '), link: '/reports/chemical-exceptions', dedupeKey: `chem-exceptions:${f.id}:${R.period('chemical_exceptions')}` }));
    }
  }
}

/** The What is late section: containers past their use-by date that are still in storage, and expired preparations still on the shelf. */
export async function chemicalsLate(tx: Tx, actor: Actor) {
  if (!can(actor, 'chemicals.view')) return null;
  const ids = (await reportScope(tx, actor, 'chemicals.view')).ids;
  if (!ids.length) return null;
  const containers = (await many(tx, `SELECT c.id, c.number, p.part_number, c.lot_number, l.code AS location, (current_date - c.use_by) AS late, c.status,
      (c.beyond_use_on IS NOT NULL AND c.beyond_use_on = c.use_by AND c.beyond_use_on IS DISTINCT FROM c.expires_on) AS beyond
    FROM chemical_container c JOIN part p ON p.id = c.part_id JOIN stock_location l ON l.id = c.location_id
    WHERE c.facility_id = ANY ($1) AND c.status IN ('in_storage', 'in_use') AND c.use_by < current_date ORDER BY c.use_by`, [ids]))
    .map((r) => ({ label: `${r.number} · ${r.part_number}`, detail: `Lot ${r.lot_number} at ${r.location}: ${r.beyond ? 'beyond its use-by date after opening' : 'expired'}, still in ${r.status.replace('_', ' ')}`, owner: null, daysLate: r.late, amount: null, href: '/chemicals' }));
  const preps = (await many(tx, `SELECT x.id, x.number, x.name, (current_date - x.expires_on) AS late FROM chemical_preparation x WHERE x.facility_id = ANY ($1) AND x.status = 'active' AND x.expires_on < current_date ORDER BY x.expires_on`, [ids]))
    .map((r) => ({ label: `${r.number} · ${r.name}`, detail: 'Preparation past its expiry, not yet discarded', owner: null, daysLate: r.late, amount: null, href: '/chemicals' }));
  const rows = [...containers, ...preps].sort((a, b) => b.daysLate - a.daysLate);
  return rows.length ? { key: 'chemicals', title: 'Expired chemicals still in storage', rows } : null;
}
