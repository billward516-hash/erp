import type { Tx } from '../../platform/db/tx.js';
import { one } from '../../platform/db/tx.js';

/**
 * A customer's credit exposure: unpaid issued invoices plus order value not yet invoiced. Used to put new
 * orders on credit hold when they would take the customer over their limit (no limit = no check).
 */
export async function creditExposure(tx: Tx, customerId: string) {
  const r = await one(tx, `SELECT c.credit_limit::float AS credit_limit,
      coalesce((SELECT sum(t.total - t.paid) FROM (
         SELECT i.id, (SELECT coalesce(sum(l.qty * l.unit_price), 0) FROM customer_invoice_line l WHERE l.invoice_id = i.id) + i.freight_amount + i.tax_amount AS total,
                (SELECT coalesce(sum(a.amount), 0) FROM payment_allocation a WHERE a.invoice_id = i.id) AS paid
         FROM customer_invoice i WHERE i.customer_id = c.id AND i.status IN ('issued', 'partially_paid')) t), 0)::float AS open_ar,
      coalesce((SELECT sum((l.qty - l.qty_invoiced) * l.unit_price) FROM sales_order_line l JOIN sales_order o ON o.id = l.order_id
         WHERE o.customer_id = c.id AND o.status <> 'cancelled'), 0)::float AS uninvoiced_orders
    FROM customer c WHERE c.id = $1`, [customerId]);
  const exposure = Math.round(((r?.open_ar ?? 0) + (r?.uninvoiced_orders ?? 0)) * 100) / 100;
  const limit = r?.credit_limit ?? null;
  return { limit, openAr: r?.open_ar ?? 0, uninvoicedOrders: r?.uninvoiced_orders ?? 0, exposure, over: limit != null && exposure > limit };
}
