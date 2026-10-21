-- 0008 Purchasing essentials: suppliers and supplier prices, purchase requests approved through the shared
-- approval engine (rules by amount, spend type and facility), approval delegation, purchase orders limited
-- to what was approved, and receiving into storerooms through the stock ledger.
-- Invoices, payments and three-way match stay in the accounting system (system of record).

CREATE TABLE supplier (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenant(id),
  code           text NOT NULL,
  name           text NOT NULL,
  contact_name   text,
  email          text,
  phone          text,
  payment_terms  text,
  currency       text NOT NULL DEFAULT 'USD',
  active         boolean NOT NULL DEFAULT true,
  custom_fields  jsonb NOT NULL DEFAULT '{}',
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, code)
);

CREATE TABLE supplier_part (
  tenant_id             uuid NOT NULL REFERENCES tenant(id),
  supplier_id           uuid NOT NULL REFERENCES supplier(id),
  part_id               uuid NOT NULL REFERENCES part(id),
  supplier_part_number  text,
  unit_price            numeric(14, 4) CHECK (unit_price >= 0),
  lead_time_days        integer CHECK (lead_time_days >= 0),
  preferred             boolean NOT NULL DEFAULT false,
  updated_at            timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (supplier_id, part_id)
);
-- At most one preferred supplier per part.
CREATE UNIQUE INDEX supplier_part_one_preferred ON supplier_part (part_id) WHERE preferred;

-- Approval routing for purchase requests. Every rule whose threshold the request total reaches (and whose
-- spend type and facility match) adds a step; rules sharing a stage are signed in parallel.
CREATE TABLE purchase_approval_rule (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenant(id),
  facility_id  uuid REFERENCES facility(id),              -- null = every facility
  spend_type   text CHECK (spend_type IN ('opex', 'capex')), -- null = either
  min_amount   numeric(14, 2) NOT NULL DEFAULT 0 CHECK (min_amount >= 0),
  stage        integer NOT NULL CHECK (stage BETWEEN 1 AND 9),
  role_key     text NOT NULL,
  label        text NOT NULL,
  active       boolean NOT NULL DEFAULT true
);

CREATE TABLE purchase_request (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenant(id),
  facility_id     uuid NOT NULL REFERENCES facility(id),
  number          text NOT NULL,
  title           text NOT NULL,
  justification   text,
  spend_type      text NOT NULL DEFAULT 'opex' CHECK (spend_type IN ('opex', 'capex')),
  needed_by       date,
  work_order_id   uuid REFERENCES work_order(id),
  status          text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'pending_approval', 'approved', 'rejected', 'cancelled', 'closed')),
  revision        integer NOT NULL DEFAULT 1,
  approved_total  numeric(14, 2),                          -- total at the moment of approval
  requested_by    uuid NOT NULL REFERENCES app_user(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  submitted_at    timestamptz,
  approved_at     timestamptz,
  UNIQUE (tenant_id, number)
);

CREATE TABLE purchase_request_line (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenant(id),
  request_id      uuid NOT NULL REFERENCES purchase_request(id),
  line_no         integer NOT NULL,
  part_id         uuid REFERENCES part(id),
  description     text NOT NULL,
  qty             numeric(14, 3) NOT NULL CHECK (qty > 0),
  uom             text NOT NULL DEFAULT 'EA',
  est_unit_price  numeric(14, 4) CHECK (est_unit_price >= 0),
  supplier_id     uuid REFERENCES supplier(id),
  location_id     uuid REFERENCES stock_location(id),      -- storeroom to receive into (stocked parts)
  work_order_id   uuid REFERENCES work_order(id),
  UNIQUE (request_id, line_no)
);

CREATE TABLE purchase_order (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenant(id),
  facility_id  uuid NOT NULL REFERENCES facility(id),
  number       text NOT NULL,
  supplier_id  uuid NOT NULL REFERENCES supplier(id),
  status       text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'partially_received', 'received', 'cancelled')),
  expected_on  date,
  notes        text,
  created_by   uuid NOT NULL REFERENCES app_user(id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, number)
);

CREATE TABLE purchase_order_line (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenant(id),
  order_id        uuid NOT NULL REFERENCES purchase_order(id),
  line_no         integer NOT NULL,
  request_line_id uuid NOT NULL REFERENCES purchase_request_line(id),
  part_id         uuid REFERENCES part(id),
  description     text NOT NULL,
  qty_ordered     numeric(14, 3) NOT NULL CHECK (qty_ordered > 0),
  qty_received    numeric(14, 3) NOT NULL DEFAULT 0 CHECK (qty_received >= 0),
  unit_price      numeric(14, 4) NOT NULL CHECK (unit_price >= 0),
  location_id     uuid REFERENCES stock_location(id),
  UNIQUE (order_id, line_no),
  CHECK (qty_received <= qty_ordered)
);
-- A request line is ordered once (cancelling the PO frees it again).
CREATE INDEX purchase_order_line_request ON purchase_order_line (request_line_id);

CREATE TABLE po_receipt (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id       uuid NOT NULL REFERENCES tenant(id),
  order_line_id   uuid NOT NULL REFERENCES purchase_order_line(id),
  qty             numeric(14, 3) NOT NULL CHECK (qty > 0),
  location_id     uuid REFERENCES stock_location(id),
  inventory_txn_id bigint REFERENCES inventory_txn(id),
  packing_slip    text,
  received_by     uuid NOT NULL REFERENCES app_user(id),
  received_at     timestamptz NOT NULL DEFAULT now()
);
CREATE FUNCTION po_receipt_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'receipts are append-only; correct with a stock adjustment or return';
END $$;
CREATE TRIGGER po_receipt_immutable BEFORE UPDATE OR DELETE ON po_receipt FOR EACH ROW EXECUTE FUNCTION po_receipt_immutable();

-- Approval delegation: while active, the delegate may sign steps addressed to roles the delegator holds.
CREATE TABLE approval_delegation (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid NOT NULL REFERENCES tenant(id),
  delegator_user_id  uuid NOT NULL REFERENCES app_user(id),
  delegate_user_id   uuid NOT NULL REFERENCES app_user(id),
  starts_on          date NOT NULL,
  ends_on            date NOT NULL,
  reason             text NOT NULL,
  created_by         uuid NOT NULL REFERENCES app_user(id),
  created_at         timestamptz NOT NULL DEFAULT now(),
  revoked_at         timestamptz,
  CHECK (ends_on >= starts_on),
  CHECK (delegator_user_id <> delegate_user_id)
);
ALTER TABLE approval_step ADD COLUMN on_behalf_of uuid REFERENCES app_user(id);

-- ---------------------------------------------------------------------------
-- RLS and grants
-- ---------------------------------------------------------------------------
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['supplier', 'supplier_part', 'purchase_approval_rule', 'approval_delegation']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id())', t);
  END LOOP;
  FOREACH t IN ARRAY ARRAY['purchase_request', 'purchase_order']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_facility ON %I USING (tenant_id = app_tenant_id() AND app_can_see_facility(facility_id)) WITH CHECK (tenant_id = app_tenant_id() AND app_can_see_facility(facility_id))', t);
  END LOOP;
END $$;
ALTER TABLE purchase_request_line ENABLE ROW LEVEL SECURITY;
CREATE POLICY via_parent ON purchase_request_line
  USING (tenant_id = app_tenant_id() AND EXISTS (SELECT 1 FROM purchase_request r WHERE r.id = request_id))
  WITH CHECK (tenant_id = app_tenant_id() AND EXISTS (SELECT 1 FROM purchase_request r WHERE r.id = request_id));
ALTER TABLE purchase_order_line ENABLE ROW LEVEL SECURITY;
CREATE POLICY via_parent ON purchase_order_line
  USING (tenant_id = app_tenant_id() AND EXISTS (SELECT 1 FROM purchase_order o WHERE o.id = order_id))
  WITH CHECK (tenant_id = app_tenant_id() AND EXISTS (SELECT 1 FROM purchase_order o WHERE o.id = order_id));
ALTER TABLE po_receipt ENABLE ROW LEVEL SECURITY;
CREATE POLICY via_parent ON po_receipt
  USING (tenant_id = app_tenant_id() AND EXISTS (SELECT 1 FROM purchase_order_line l WHERE l.id = order_line_id))
  WITH CHECK (tenant_id = app_tenant_id() AND EXISTS (SELECT 1 FROM purchase_order_line l WHERE l.id = order_line_id));

GRANT SELECT, INSERT, UPDATE ON supplier, supplier_part, purchase_approval_rule, purchase_request, purchase_order, purchase_order_line, approval_delegation TO erp_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON purchase_request_line TO erp_app;
GRANT SELECT, INSERT ON po_receipt TO erp_app;

-- ---------------------------------------------------------------------------
-- Roles and default rules for existing tenants (new tenants get the same from code at provisioning)
-- ---------------------------------------------------------------------------
INSERT INTO role (tenant_id, key, name, permissions)
SELECT t.id, r.key, r.name, r.permissions FROM tenant t CROSS JOIN (VALUES
  ('buyer', 'Buyer / Purchasing', ARRAY['org.view', 'assets.view', 'parts.view', 'parts.manage', 'work_orders.view', 'inventory.view',
     'reports.view', 'reports.export', 'imports.run', 'imports.commit', 'purchasing.view', 'purchasing.request', 'purchasing.manage', 'purchasing.receive']),
  ('finance_approver', 'Finance Approver', ARRAY['org.view', 'parts.view', 'reports.view', 'reports.export', 'purchasing.view'])
) AS r(key, name, permissions)
WHERE NOT EXISTS (SELECT 1 FROM role x WHERE x.tenant_id = t.id AND x.key = r.key);

UPDATE role SET permissions = (SELECT array_agg(DISTINCT p) FROM unnest(permissions || ARRAY['purchasing.view', 'purchasing.request', 'purchasing.manage', 'purchasing.receive']) p)
  WHERE key = 'admin';
UPDATE role SET permissions = (SELECT array_agg(DISTINCT p) FROM unnest(permissions || ARRAY['purchasing.view', 'purchasing.request', 'purchasing.receive']) p)
  WHERE key = 'maintenance_manager';
UPDATE role SET permissions = (SELECT array_agg(DISTINCT p) FROM unnest(permissions || ARRAY['purchasing.view', 'purchasing.request']) p)
  WHERE key IN ('technician', 'operations_manager');
UPDATE role SET permissions = (SELECT array_agg(DISTINCT p) FROM unnest(permissions || ARRAY['purchasing.view']) p)
  WHERE key = 'executive';

INSERT INTO purchase_approval_rule (tenant_id, spend_type, min_amount, stage, role_key, label)
SELECT t.id, r.spend_type, r.min_amount, r.stage, r.role_key, r.label FROM tenant t CROSS JOIN (VALUES
  (NULL, 0, 1, 'maintenance_manager', 'Budget owner approval'),
  (NULL, 2500, 2, 'operations_manager', 'Plant manager approval'),
  (NULL, 10000, 3, 'finance_approver', 'Finance approval'),
  ('capex', 0, 3, 'finance_approver', 'Finance approval (capital)')
) AS r(spend_type, min_amount, stage, role_key, label)
WHERE NOT EXISTS (SELECT 1 FROM purchase_approval_rule x WHERE x.tenant_id = t.id);
