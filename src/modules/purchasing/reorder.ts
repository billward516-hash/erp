import type { Actor } from '../../platform/auth/actor.js';
import { requirePermission } from '../../platform/auth/actor.js';
import type { Tx } from '../../platform/db/tx.js';
import { one } from '../../platform/db/tx.js';
import { invalid } from '../../platform/errors.js';
import { inventoryReorderReport } from '../reporting/pm-reports.js';
import { createPurchaseRequest } from './service.js';

/**
 * Drafts one purchase request for a facility from the parts-to-reorder report: the suggested quantities,
 * received into the storeroom that holds the reorder point. The requester reviews it before submitting.
 */
export async function requestFromReorder(tx: Tx, actor: Actor, input: { facilityId: string; days?: number; partIds?: string[] }) {
  requirePermission(actor, 'purchasing.request', input.facilityId);
  const report = await inventoryReorderReport.run(tx, actor, { facilityId: input.facilityId, days: input.days ?? 30 });
  const rows = report.rows.filter((r) => !input.partIds || input.partIds.includes(r.part_id as string));
  if (!rows.length) throw invalid('nothing to reorder at this facility');
  const lines = [];
  for (const r of rows) {
    const loc = await one(tx, `SELECT b.location_id FROM inventory_balance b JOIN stock_location l ON l.id = b.location_id
      WHERE b.facility_id = $1 AND b.part_id = $2 AND l.active ORDER BY b.reorder_point DESC NULLS LAST, l.code LIMIT 1`, [input.facilityId, r.part_id]);
    lines.push({ partId: r.part_id as string, qty: r.suggested_qty as number, locationId: loc?.location_id ?? null });
  }
  return createPurchaseRequest(tx, actor, {
    facilityId: input.facilityId, title: `Stock replenishment (${rows.length} part${rows.length === 1 ? '' : 's'})`, lines,
    justification: `From the parts-to-reorder report on ${report.generatedAt.slice(0, 10)}: ${rows.map((r) => `${r.part_number} (${r.reason})`).join('; ')}.`,
  });
}
