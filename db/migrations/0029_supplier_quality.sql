-- S13a Supplier performance and corrective action requests (brief Category 2 "advanced supplier quality").
-- A supplier corrective action request (SCAR) is a corrective action owned internally, addressed to a supplier, with
-- the date its response is due and the response as received (staff record it: no supplier portal).
ALTER TABLE corrective_action ADD COLUMN supplier_id uuid REFERENCES supplier(id);
ALTER TABLE corrective_action ADD COLUMN supplier_response_due date;
ALTER TABLE corrective_action ADD COLUMN supplier_response text;
ALTER TABLE corrective_action ADD COLUMN supplier_responded_at timestamptz;
ALTER TABLE corrective_action DROP CONSTRAINT corrective_action_source_check;
ALTER TABLE corrective_action ADD CONSTRAINT corrective_action_source_check CHECK (source IN ('nonconformance', 'incident', 'customer_complaint', 'audit', 'internal', 'fmea', 'supplier'));
ALTER TABLE corrective_action ADD CONSTRAINT corrective_action_supplier_shape CHECK (source <> 'supplier' OR (supplier_id IS NOT NULL AND supplier_response_due IS NOT NULL));
CREATE INDEX corrective_action_supplier ON corrective_action (supplier_id) WHERE supplier_id IS NOT NULL;

-- Delivery history from the customer's previous system (purchase order receipt reports), so scorecards are meaningful
-- from the first day. Kept apart from native orders: these are records of what happened, not orders to receive against.
CREATE TABLE supplier_delivery_history (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenant(id),
  facility_id    uuid NOT NULL REFERENCES facility(id),
  supplier_id    uuid NOT NULL REFERENCES supplier(id),
  reference      text NOT NULL,                  -- their PO and line, e.g. "4500123-10"
  part_id        uuid REFERENCES part(id),
  description    text,
  qty_ordered    numeric(14, 3) NOT NULL CHECK (qty_ordered > 0),
  due_on         date NOT NULL,
  received_on    date,
  qty_received   numeric(14, 3) NOT NULL DEFAULT 0 CHECK (qty_received >= 0),
  qty_rejected   numeric(14, 3) NOT NULL DEFAULT 0 CHECK (qty_rejected >= 0),
  unit_price     numeric(14, 4),
  source_system  text NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, supplier_id, reference)
);
ALTER TABLE supplier_delivery_history ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_facility ON supplier_delivery_history USING (tenant_id = app_tenant_id() AND app_can_see_facility(facility_id)) WITH CHECK (tenant_id = app_tenant_id() AND app_can_see_facility(facility_id));
GRANT SELECT, INSERT, UPDATE ON supplier_delivery_history TO erp_app;
