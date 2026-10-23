-- 0013 Order-to-cash essentials: customer invoices from shipments, payments and their allocation,
-- credit hold on orders over a customer's credit limit, collections notes and payment reminders.
-- The accounting system stays the general ledger; issued invoices leave through the outbox and
-- payments come back from it when an API connection is active.

ALTER TABLE sales_order_line ADD COLUMN qty_invoiced numeric(14, 3) NOT NULL DEFAULT 0 CHECK (qty_invoiced >= 0);
ALTER TABLE sales_order_line ADD CONSTRAINT sales_order_line_invoiced_le_shipped CHECK (qty_invoiced <= qty_shipped);
ALTER TABLE sales_order ADD COLUMN credit_hold boolean NOT NULL DEFAULT false;
ALTER TABLE sales_order ADD COLUMN credit_hold_note text;

CREATE TABLE customer_invoice (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenant(id),
  facility_id    uuid NOT NULL REFERENCES facility(id),
  number         text,                          -- assigned when issued (no gaps from abandoned drafts)
  customer_id    uuid NOT NULL REFERENCES customer(id),
  order_id       uuid REFERENCES sales_order(id),
  status         text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'issued', 'partially_paid', 'paid', 'void')),
  invoice_date   date,
  due_date       date,
  payment_terms  text,
  customer_po    text,
  freight_amount numeric(14, 2) NOT NULL DEFAULT 0 CHECK (freight_amount >= 0),
  tax_amount     numeric(14, 2) NOT NULL DEFAULT 0 CHECK (tax_amount >= 0),
  notes          text,
  blob_key       text,                          -- the PDF as issued
  sha256         text,
  created_by     uuid NOT NULL REFERENCES app_user(id),
  created_at     timestamptz NOT NULL DEFAULT now(),
  issued_by      uuid REFERENCES app_user(id),
  issued_at      timestamptz,
  void_reason    text,
  UNIQUE (tenant_id, number)
);

CREATE TABLE customer_invoice_line (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenant(id),
  invoice_id     uuid NOT NULL REFERENCES customer_invoice(id),
  line_no        integer NOT NULL,
  order_line_id  uuid REFERENCES sales_order_line(id),
  description    text NOT NULL,
  qty            numeric(14, 3) NOT NULL CHECK (qty > 0),
  uom            text NOT NULL DEFAULT 'EA',
  unit_price     numeric(14, 4) NOT NULL CHECK (unit_price >= 0),
  UNIQUE (invoice_id, line_no)
);

CREATE TABLE customer_payment (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenant(id),
  customer_id   uuid NOT NULL REFERENCES customer(id),
  received_on   date NOT NULL,
  amount        numeric(14, 2) NOT NULL CHECK (amount > 0),
  method        text NOT NULL CHECK (method IN ('check', 'ach', 'wire', 'card', 'other')),
  reference     text,
  source        text NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'accounting')),
  external_id   text,
  recorded_by   uuid REFERENCES app_user(id),
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE payment_allocation (
  tenant_id   uuid NOT NULL REFERENCES tenant(id),
  payment_id  uuid NOT NULL REFERENCES customer_payment(id),
  invoice_id  uuid NOT NULL REFERENCES customer_invoice(id),
  amount      numeric(14, 2) NOT NULL CHECK (amount > 0),
  PRIMARY KEY (payment_id, invoice_id)
);
CREATE FUNCTION payment_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'payments are append-only; record a reversal in accounting and re-sync';
END $$;
CREATE TRIGGER customer_payment_immutable BEFORE UPDATE OR DELETE ON customer_payment FOR EACH ROW EXECUTE FUNCTION payment_immutable();
CREATE TRIGGER payment_allocation_immutable BEFORE UPDATE OR DELETE ON payment_allocation FOR EACH ROW EXECUTE FUNCTION payment_immutable();

-- Collections notes and promises to pay hang off the customer's activity log, linked to the invoice.
ALTER TABLE activity ADD COLUMN invoice_id uuid REFERENCES customer_invoice(id);
ALTER TABLE activity DROP CONSTRAINT activity_kind_check;
ALTER TABLE activity ADD CONSTRAINT activity_kind_check CHECK (kind IN ('call', 'email', 'meeting', 'note', 'task', 'collection'));

-- Payment reminders go to customer contacts, not platform users.
ALTER TABLE email_message ALTER COLUMN user_id DROP NOT NULL;
ALTER TABLE email_message ADD COLUMN customer_id uuid REFERENCES customer(id);

-- The MOCK accounting system also holds customers, invoices and their payments.
ALTER TABLE mock_accounting_record DROP CONSTRAINT mock_accounting_record_kind_check;
ALTER TABLE mock_accounting_record ADD CONSTRAINT mock_accounting_record_kind_check CHECK (kind IN ('vendor', 'bill', 'customer', 'invoice'));

ALTER TABLE customer_invoice ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_facility ON customer_invoice USING (tenant_id = app_tenant_id() AND app_can_see_facility(facility_id))
  WITH CHECK (tenant_id = app_tenant_id() AND app_can_see_facility(facility_id));
ALTER TABLE customer_invoice_line ENABLE ROW LEVEL SECURITY;
CREATE POLICY via_parent ON customer_invoice_line USING (tenant_id = app_tenant_id() AND EXISTS (SELECT 1 FROM customer_invoice i WHERE i.id = invoice_id))
  WITH CHECK (tenant_id = app_tenant_id() AND EXISTS (SELECT 1 FROM customer_invoice i WHERE i.id = invoice_id));
ALTER TABLE customer_payment ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON customer_payment USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());
ALTER TABLE payment_allocation ENABLE ROW LEVEL SECURITY;
CREATE POLICY via_parent ON payment_allocation USING (tenant_id = app_tenant_id() AND EXISTS (SELECT 1 FROM customer_invoice i WHERE i.id = invoice_id))
  WITH CHECK (tenant_id = app_tenant_id() AND EXISTS (SELECT 1 FROM customer_invoice i WHERE i.id = invoice_id));

GRANT SELECT, INSERT, UPDATE ON customer_invoice TO erp_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON customer_invoice_line TO erp_app;
GRANT SELECT, INSERT ON customer_payment, payment_allocation TO erp_app;

INSERT INTO role (tenant_id, key, name, permissions)
SELECT t.id, 'ar_clerk', 'Billing / Accounts Receivable', ARRAY['org.view', 'reports.view', 'reports.export', 'crm.view', 'sales.view', 'ar.view', 'ar.manage']
FROM tenant t WHERE NOT EXISTS (SELECT 1 FROM role x WHERE x.tenant_id = t.id AND x.key = 'ar_clerk');
UPDATE role SET permissions = (SELECT array_agg(DISTINCT p) FROM unnest(permissions || ARRAY['ar.view', 'ar.manage', 'ar.credit']) p) WHERE key IN ('admin', 'finance_approver');
UPDATE role SET permissions = (SELECT array_agg(DISTINCT p) FROM unnest(permissions || ARRAY['ar.view']) p) WHERE key IN ('sales_manager', 'executive');
