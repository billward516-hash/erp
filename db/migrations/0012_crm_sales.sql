-- 0012 CRM and sales essentials (Category 1, Phase 2): customers and contacts, opportunities, activities,
-- a sales catalog, quotes with revisions and approval of unusual discounts or margins, sales orders and
-- shipments. Customers are tenant-wide; quotes, orders and shipments belong to the selling facility.

CREATE TABLE customer (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenant(id),
  code            text NOT NULL,
  name            text NOT NULL,
  kind            text NOT NULL DEFAULT 'prospect' CHECK (kind IN ('prospect', 'customer')),
  industry        text,
  website         text,
  phone           text,
  billing_address text,
  shipping_address text,
  payment_terms   text,
  credit_limit    numeric(14, 2),
  tax_exempt      boolean NOT NULL DEFAULT false,
  owner_user_id   uuid REFERENCES app_user(id),
  active          boolean NOT NULL DEFAULT true,
  custom_fields   jsonb NOT NULL DEFAULT '{}',
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, code)
);

CREATE TABLE contact (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenant(id),
  customer_id  uuid NOT NULL REFERENCES customer(id),
  name         text NOT NULL,
  title        text,
  email        text,
  phone        text,
  is_primary   boolean NOT NULL DEFAULT false,
  active       boolean NOT NULL DEFAULT true,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX contact_one_primary ON contact (customer_id) WHERE is_primary AND active;

CREATE TABLE opportunity (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES tenant(id),
  customer_id       uuid NOT NULL REFERENCES customer(id),
  title             text NOT NULL,
  stage             text NOT NULL DEFAULT 'lead' CHECK (stage IN ('lead', 'qualified', 'proposal', 'negotiation', 'won', 'lost')),
  amount            numeric(14, 2),
  probability       integer CHECK (probability BETWEEN 0 AND 100),
  expected_close    date,
  source            text,
  owner_user_id     uuid REFERENCES app_user(id),
  lost_reason       text,
  closed_at         timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now()
);

-- Calls, emails, meetings, notes and follow-up tasks on a customer, opportunity or quote.
CREATE TABLE activity (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenant(id),
  customer_id    uuid NOT NULL REFERENCES customer(id),
  opportunity_id uuid REFERENCES opportunity(id),
  quote_id       uuid,
  kind           text NOT NULL CHECK (kind IN ('call', 'email', 'meeting', 'note', 'task')),
  summary        text NOT NULL,
  due_on         date,                           -- tasks
  done_at        timestamptz,
  owner_user_id  uuid REFERENCES app_user(id),
  created_by     uuid NOT NULL REFERENCES app_user(id),
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX activity_customer ON activity (customer_id, created_at DESC);
CREATE INDEX activity_open_tasks ON activity (owner_user_id, due_on) WHERE kind = 'task' AND done_at IS NULL;

CREATE TABLE sales_item (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenant(id),
  code         text NOT NULL,
  description  text NOT NULL,
  kind         text NOT NULL DEFAULT 'product' CHECK (kind IN ('product', 'service')),
  uom          text NOT NULL DEFAULT 'EA',
  list_price   numeric(14, 4) CHECK (list_price >= 0),
  unit_cost    numeric(14, 4) CHECK (unit_cost >= 0),   -- standard cost for margin checks
  part_id      uuid REFERENCES part(id),               -- stocked goods ship from storerooms
  active       boolean NOT NULL DEFAULT true,
  UNIQUE (tenant_id, code)
);

CREATE TABLE quote (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenant(id),
  facility_id      uuid NOT NULL REFERENCES facility(id),
  number           text NOT NULL,
  revision         integer NOT NULL DEFAULT 1,
  customer_id      uuid NOT NULL REFERENCES customer(id),
  contact_id       uuid REFERENCES contact(id),
  opportunity_id   uuid REFERENCES opportunity(id),
  title            text NOT NULL,
  status           text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'pending_approval', 'approved', 'sent', 'accepted', 'declined', 'cancelled')),
  valid_until      date,
  payment_terms    text,
  notes            text,                         -- shown on the quote
  approval_reasons text[] NOT NULL DEFAULT '{}', -- why approval was needed
  created_by       uuid NOT NULL REFERENCES app_user(id),
  created_at       timestamptz NOT NULL DEFAULT now(),
  sent_at          timestamptz,
  decided_at       timestamptz,
  customer_po      text,
  decline_reason   text,
  UNIQUE (tenant_id, number)
);
ALTER TABLE activity ADD CONSTRAINT activity_quote_fk FOREIGN KEY (quote_id) REFERENCES quote(id);

CREATE TABLE quote_line (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenant(id),
  quote_id       uuid NOT NULL REFERENCES quote(id),
  line_no        integer NOT NULL,
  item_id        uuid REFERENCES sales_item(id),
  description    text NOT NULL,
  qty            numeric(14, 3) NOT NULL CHECK (qty > 0),
  uom            text NOT NULL DEFAULT 'EA',
  list_price     numeric(14, 4),
  unit_price     numeric(14, 4) NOT NULL CHECK (unit_price >= 0),
  unit_cost      numeric(14, 4),
  UNIQUE (quote_id, line_no)
);

-- What exactly was sent, per revision (the PDF the customer saw).
CREATE TABLE quote_sent (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenant(id),
  quote_id    uuid NOT NULL REFERENCES quote(id),
  revision    integer NOT NULL,
  sent_to     text,
  total       numeric(14, 2) NOT NULL,
  blob_key    text NOT NULL,
  sha256      text NOT NULL,
  sent_by     uuid NOT NULL REFERENCES app_user(id),
  sent_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (quote_id, revision)
);

CREATE TABLE sales_order (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenant(id),
  facility_id     uuid NOT NULL REFERENCES facility(id),
  number          text NOT NULL,
  customer_id     uuid NOT NULL REFERENCES customer(id),
  quote_id        uuid REFERENCES quote(id),
  customer_po     text,
  status          text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'partially_shipped', 'shipped', 'cancelled')),
  requested_date  date,
  promised_date   date,
  ship_to         text,
  payment_terms   text,
  created_by      uuid NOT NULL REFERENCES app_user(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, number)
);

CREATE TABLE sales_order_line (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenant(id),
  order_id      uuid NOT NULL REFERENCES sales_order(id),
  line_no       integer NOT NULL,
  item_id       uuid REFERENCES sales_item(id),
  description   text NOT NULL,
  qty           numeric(14, 3) NOT NULL CHECK (qty > 0),
  uom           text NOT NULL DEFAULT 'EA',
  unit_price    numeric(14, 4) NOT NULL CHECK (unit_price >= 0),
  qty_shipped   numeric(14, 3) NOT NULL DEFAULT 0 CHECK (qty_shipped >= 0),
  UNIQUE (order_id, line_no),
  CHECK (qty_shipped <= qty)
);

CREATE TABLE shipment (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenant(id),
  order_id     uuid NOT NULL REFERENCES sales_order(id),
  number       text NOT NULL,
  shipped_on   date NOT NULL,
  carrier      text,
  tracking     text,
  created_by   uuid NOT NULL REFERENCES app_user(id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, number)
);

CREATE TABLE shipment_line (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES tenant(id),
  shipment_id       uuid NOT NULL REFERENCES shipment(id),
  order_line_id     uuid NOT NULL REFERENCES sales_order_line(id),
  qty               numeric(14, 3) NOT NULL CHECK (qty > 0),
  location_id       uuid REFERENCES stock_location(id),
  inventory_txn_id  bigint REFERENCES inventory_txn(id)
);
CREATE FUNCTION shipment_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'shipments are append-only; record a return or correction instead';
END $$;
CREATE TRIGGER shipment_line_immutable BEFORE UPDATE OR DELETE ON shipment_line FOR EACH ROW EXECUTE FUNCTION shipment_immutable();

-- Customer returns put stock back with a 'return' ledger movement; record which shipment they relate to.
ALTER TABLE inventory_txn DROP CONSTRAINT inventory_txn_txn_type_check;
ALTER TABLE inventory_txn ADD CONSTRAINT inventory_txn_txn_type_check
  CHECK (txn_type IN ('receipt', 'issue', 'return', 'adjustment', 'count', 'transfer_out', 'transfer_in', 'opening', 'shipment'));

-- ---------------------------------------------------------------------------
-- RLS and grants
-- ---------------------------------------------------------------------------
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['customer', 'contact', 'opportunity', 'activity', 'sales_item']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id())', t);
  END LOOP;
  FOREACH t IN ARRAY ARRAY['quote', 'sales_order']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_facility ON %I USING (tenant_id = app_tenant_id() AND app_can_see_facility(facility_id)) WITH CHECK (tenant_id = app_tenant_id() AND app_can_see_facility(facility_id))', t);
  END LOOP;
END $$;
ALTER TABLE quote_line ENABLE ROW LEVEL SECURITY;
CREATE POLICY via_parent ON quote_line USING (tenant_id = app_tenant_id() AND EXISTS (SELECT 1 FROM quote q WHERE q.id = quote_id))
  WITH CHECK (tenant_id = app_tenant_id() AND EXISTS (SELECT 1 FROM quote q WHERE q.id = quote_id));
ALTER TABLE quote_sent ENABLE ROW LEVEL SECURITY;
CREATE POLICY via_parent ON quote_sent USING (tenant_id = app_tenant_id() AND EXISTS (SELECT 1 FROM quote q WHERE q.id = quote_id))
  WITH CHECK (tenant_id = app_tenant_id() AND EXISTS (SELECT 1 FROM quote q WHERE q.id = quote_id));
ALTER TABLE sales_order_line ENABLE ROW LEVEL SECURITY;
CREATE POLICY via_parent ON sales_order_line USING (tenant_id = app_tenant_id() AND EXISTS (SELECT 1 FROM sales_order o WHERE o.id = order_id))
  WITH CHECK (tenant_id = app_tenant_id() AND EXISTS (SELECT 1 FROM sales_order o WHERE o.id = order_id));
ALTER TABLE shipment ENABLE ROW LEVEL SECURITY;
CREATE POLICY via_parent ON shipment USING (tenant_id = app_tenant_id() AND EXISTS (SELECT 1 FROM sales_order o WHERE o.id = order_id))
  WITH CHECK (tenant_id = app_tenant_id() AND EXISTS (SELECT 1 FROM sales_order o WHERE o.id = order_id));
ALTER TABLE shipment_line ENABLE ROW LEVEL SECURITY;
CREATE POLICY via_parent ON shipment_line USING (tenant_id = app_tenant_id() AND EXISTS (SELECT 1 FROM shipment s WHERE s.id = shipment_id))
  WITH CHECK (tenant_id = app_tenant_id() AND EXISTS (SELECT 1 FROM shipment s WHERE s.id = shipment_id));

GRANT SELECT, INSERT, UPDATE ON customer, contact, opportunity, activity, sales_item, quote, sales_order, sales_order_line, shipment TO erp_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON quote_line TO erp_app;
GRANT SELECT, INSERT ON quote_sent, shipment_line TO erp_app;

-- Roles and permissions
INSERT INTO role (tenant_id, key, name, permissions)
SELECT t.id, r.key, r.name, r.permissions FROM tenant t CROSS JOIN (VALUES
  ('sales_rep', 'Sales Representative', ARRAY['org.view', 'reports.view', 'reports.export', 'imports.run', 'imports.commit', 'crm.view', 'crm.manage', 'sales.quote', 'sales.view']),
  ('sales_manager', 'Sales Manager', ARRAY['org.view', 'reports.view', 'reports.export', 'imports.run', 'imports.commit', 'crm.view', 'crm.manage', 'sales.quote', 'sales.view', 'sales.orders'])
) AS r(key, name, permissions)
WHERE NOT EXISTS (SELECT 1 FROM role x WHERE x.tenant_id = t.id AND x.key = r.key);
UPDATE role SET permissions = (SELECT array_agg(DISTINCT p) FROM unnest(permissions || ARRAY['crm.view', 'crm.manage', 'sales.quote', 'sales.view', 'sales.orders']) p) WHERE key = 'admin';
UPDATE role SET permissions = (SELECT array_agg(DISTINCT p) FROM unnest(permissions || ARRAY['crm.view', 'sales.view', 'sales.orders']) p) WHERE key = 'operations_manager';
UPDATE role SET permissions = (SELECT array_agg(DISTINCT p) FROM unnest(permissions || ARRAY['crm.view', 'sales.view']) p) WHERE key IN ('executive', 'finance_approver');
