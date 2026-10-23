-- S19d Credit memos, customer returns and refunds (D-146). A credit memo reduces what a customer owes: it is applied
-- to open invoices (as an allocation, like a payment), refunded, or left as credit for later. Lines may return goods
-- to a storeroom. Recorded here with the built-in books, a file export or no accounting connection; with an API
-- accounting connection credit memos come from that system, as payments do (D-053).
CREATE TABLE customer_credit_memo (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenant(id),
  facility_id   uuid NOT NULL REFERENCES facility(id),
  customer_id   uuid NOT NULL REFERENCES customer(id),
  invoice_id    uuid REFERENCES customer_invoice(id),        -- the invoice it corrects, when there is one
  number        text,                                         -- assigned when issued
  status        text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'issued', 'void')),
  memo_date     date,
  reason        text NOT NULL CHECK (length(reason) >= 3),
  tax_amount    numeric(14, 2) NOT NULL DEFAULT 0 CHECK (tax_amount >= 0),
  blob_key      text,
  sha256        text,
  void_reason   text,
  created_by    uuid NOT NULL REFERENCES app_user(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  issued_by     uuid REFERENCES app_user(id),
  issued_at     timestamptz,
  UNIQUE (tenant_id, number)
);
CREATE INDEX customer_credit_memo_customer ON customer_credit_memo (customer_id, status);

CREATE TABLE customer_credit_memo_line (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenant(id),
  memo_id       uuid NOT NULL REFERENCES customer_credit_memo(id),
  line_no       integer NOT NULL,
  description   text NOT NULL,
  qty           numeric(14, 3) NOT NULL CHECK (qty > 0),
  unit_price    numeric(14, 4) NOT NULL CHECK (unit_price >= 0),
  account_key   text NOT NULL DEFAULT 'sales_revenue',
  part_id       uuid REFERENCES part(id),                     -- returned goods
  location_id   uuid REFERENCES stock_location(id),           -- the storeroom they go back into
  inventory_txn_id bigint REFERENCES inventory_txn(id),
  UNIQUE (memo_id, line_no),
  CHECK (location_id IS NULL OR part_id IS NOT NULL)
);

-- Applications of a credit memo to invoices share the payment allocation table, so every "paid" balance counts them.
ALTER TABLE payment_allocation DROP CONSTRAINT payment_allocation_pkey;
ALTER TABLE payment_allocation ADD COLUMN id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY;
ALTER TABLE payment_allocation ALTER COLUMN payment_id DROP NOT NULL;
ALTER TABLE payment_allocation ADD COLUMN credit_memo_id uuid REFERENCES customer_credit_memo(id);
ALTER TABLE payment_allocation ADD COLUMN applied_on date NOT NULL DEFAULT current_date;
ALTER TABLE payment_allocation ADD CONSTRAINT payment_allocation_source CHECK (num_nonnulls(payment_id, credit_memo_id) = 1);
CREATE UNIQUE INDEX payment_allocation_payment_invoice ON payment_allocation (payment_id, invoice_id) WHERE payment_id IS NOT NULL;
CREATE INDEX payment_allocation_credit ON payment_allocation (credit_memo_id) WHERE credit_memo_id IS NOT NULL;

-- Money paid back to the customer out of unapplied credit. Append-only, like payments.
CREATE TABLE customer_refund (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenant(id),
  credit_memo_id  uuid NOT NULL REFERENCES customer_credit_memo(id),
  amount          numeric(14, 2) NOT NULL CHECK (amount > 0),
  paid_on         date NOT NULL,
  method          text NOT NULL CHECK (method IN ('check', 'ach', 'wire', 'card', 'other')),
  reference       text,
  recorded_by     uuid NOT NULL REFERENCES app_user(id),
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER customer_refund_immutable BEFORE UPDATE OR DELETE ON customer_refund FOR EACH ROW EXECUTE FUNCTION payment_immutable();

-- Site-scoped like invoices: a site's receivables clerk sees that site's credit memos.
ALTER TABLE customer_credit_memo ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_facility ON customer_credit_memo USING (tenant_id = app_tenant_id() AND app_can_see_facility(facility_id))
  WITH CHECK (tenant_id = app_tenant_id() AND app_can_see_facility(facility_id));
ALTER TABLE customer_credit_memo_line ENABLE ROW LEVEL SECURITY;
CREATE POLICY via_parent ON customer_credit_memo_line USING (tenant_id = app_tenant_id() AND EXISTS (SELECT 1 FROM customer_credit_memo m WHERE m.id = memo_id))
  WITH CHECK (tenant_id = app_tenant_id());
ALTER TABLE customer_refund ENABLE ROW LEVEL SECURITY;
CREATE POLICY via_parent ON customer_refund USING (tenant_id = app_tenant_id() AND EXISTS (SELECT 1 FROM customer_credit_memo m WHERE m.id = credit_memo_id))
  WITH CHECK (tenant_id = app_tenant_id());
GRANT SELECT, INSERT, UPDATE ON customer_credit_memo, customer_credit_memo_line TO erp_app;
GRANT DELETE ON customer_credit_memo_line TO erp_app;
GRANT SELECT, INSERT ON customer_refund TO erp_app;

ALTER TABLE journal_entry DROP CONSTRAINT journal_entry_source_check;
ALTER TABLE journal_entry ADD CONSTRAINT journal_entry_source_check CHECK (source IN ('manual', 'opening', 'ar_invoice', 'ar_payment', 'ap_bill', 'ap_payment', 'expense_report',
  'expense_payment', 'bank', 'reversal', 'ar_credit_memo', 'ar_refund'));
