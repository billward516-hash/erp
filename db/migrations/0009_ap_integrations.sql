-- 0009 Accounts-payable essentials and the integration framework.
--
-- Supplier invoices are captured here (basic capture, a comparison with the purchase order and receipts,
-- approval for payment, due dates and aging). Bills, payments and the general ledger belong to the external
-- accounting system: approved invoices leave through the outbox, and payment status comes back from it.
--
-- Integration framework: domain changes write outbox_event rows in the same transaction; a sync run
-- delivers them to each active connection with an idempotency key, retries with backoff, and parks
-- repeated failures as 'dead' for a person to resolve (reconciliation queue).

CREATE TABLE supplier_invoice (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES tenant(id),
  facility_id       uuid NOT NULL REFERENCES facility(id),
  supplier_id       uuid NOT NULL REFERENCES supplier(id),
  purchase_order_id uuid REFERENCES purchase_order(id),
  invoice_number    text NOT NULL,
  invoice_date      date NOT NULL,
  due_date          date,
  currency          text NOT NULL DEFAULT 'USD',
  tax_amount        numeric(14, 2) NOT NULL DEFAULT 0 CHECK (tax_amount >= 0),
  freight_amount    numeric(14, 2) NOT NULL DEFAULT 0 CHECK (freight_amount >= 0),
  status            text NOT NULL DEFAULT 'captured' CHECK (status IN ('captured', 'approved', 'exported', 'paid', 'disputed', 'void')),
  variance_note     text,                        -- required to approve an invoice that differs from order/receipts
  dispute_reason    text,
  file_blob_key     text,                        -- scanned or emailed invoice
  file_name         text,
  file_mime         text,
  file_sha256       text,
  captured_by       uuid NOT NULL REFERENCES app_user(id),
  captured_at       timestamptz NOT NULL DEFAULT now(),
  approved_by       uuid REFERENCES app_user(id),
  approved_at       timestamptz,
  exported_at       timestamptz,
  paid_at           date,
  paid_amount       numeric(14, 2),
  payment_reference text
);
-- Duplicate invoice prevention: one invoice number per supplier (case-insensitive), unless voided.
CREATE UNIQUE INDEX supplier_invoice_no_duplicates ON supplier_invoice (tenant_id, supplier_id, lower(invoice_number)) WHERE status <> 'void';

CREATE TABLE supplier_invoice_line (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenant(id),
  invoice_id   uuid NOT NULL REFERENCES supplier_invoice(id),
  line_no      integer NOT NULL,
  po_line_id   uuid REFERENCES purchase_order_line(id),
  description  text NOT NULL,
  qty          numeric(14, 3) NOT NULL CHECK (qty > 0),
  unit_price   numeric(14, 4) NOT NULL CHECK (unit_price >= 0),
  account_key  text NOT NULL,                    -- platform account key, mapped to the external chart of accounts
  UNIQUE (invoice_id, line_no)
);

-- Platform account keys → the customer's chart of accounts in their accounting system.
CREATE TABLE account_mapping (
  tenant_id      uuid NOT NULL REFERENCES tenant(id),
  account_key    text NOT NULL,                  -- inventory, maintenance_expense, capital_projects, freight, tax, ...
  external_code  text NOT NULL,
  external_name  text,
  PRIMARY KEY (tenant_id, account_key)
);

CREATE TABLE integration_connection (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenant(id),
  provider    text NOT NULL CHECK (provider IN ('file_export', 'mock_accounting')),
  label       text NOT NULL,
  is_mock     boolean NOT NULL,                  -- mock adapters are for development and demos only
  active      boolean NOT NULL DEFAULT true,
  settings    jsonb NOT NULL DEFAULT '{}',
  created_by  uuid NOT NULL REFERENCES app_user(id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  -- Events before this moment are not sent to the connection (no surprise back-fill of history).
  starts_after_event bigint NOT NULL DEFAULT 0,
  CHECK (is_mock = (provider = 'mock_accounting'))
);
CREATE UNIQUE INDEX integration_connection_one_active ON integration_connection (tenant_id) WHERE active;

CREATE TABLE outbox_event (
  id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id        uuid NOT NULL REFERENCES tenant(id),
  topic            text NOT NULL,                -- e.g. 'ap.bill.approved', 'ap.bill.voided'
  aggregate_type   text NOT NULL,
  aggregate_id     uuid NOT NULL,
  payload          jsonb NOT NULL,
  idempotency_key  text NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, idempotency_key)
);
CREATE FUNCTION outbox_event_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'outbox events are append-only';
END $$;
CREATE TRIGGER outbox_event_immutable BEFORE UPDATE OR DELETE ON outbox_event FOR EACH ROW EXECUTE FUNCTION outbox_event_immutable();

CREATE TABLE sync_delivery (
  id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id        uuid NOT NULL REFERENCES tenant(id),
  outbox_id        bigint NOT NULL REFERENCES outbox_event(id),
  connection_id    uuid NOT NULL REFERENCES integration_connection(id),
  status           text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'delivered', 'dead', 'skipped')),
  attempts         integer NOT NULL DEFAULT 0,
  next_attempt_at  timestamptz NOT NULL DEFAULT now(),
  last_error       text,
  external_id      text,
  delivered_at     timestamptz,
  resolved_by      uuid REFERENCES app_user(id),
  resolution_note  text,
  UNIQUE (outbox_id, connection_id)
);
CREATE INDEX sync_delivery_due ON sync_delivery (connection_id, status, next_attempt_at);

-- File-export connection: each sync run writes one file that a person downloads and imports.
CREATE TABLE export_file (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenant(id),
  connection_id  uuid NOT NULL REFERENCES integration_connection(id),
  kind           text NOT NULL,
  file_name      text NOT NULL,
  row_count      integer NOT NULL,
  content        text NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  downloaded_at  timestamptz
);

-- MOCK external accounting system (development and demos only). Stands in for a provider's API so the
-- sync framework can be exercised end to end, including idempotent retries and payments made "there".
CREATE TABLE mock_accounting_record (
  tenant_id        uuid NOT NULL REFERENCES tenant(id),
  connection_id    uuid NOT NULL REFERENCES integration_connection(id),
  kind             text NOT NULL CHECK (kind IN ('vendor', 'bill')),
  external_id      text NOT NULL,
  idempotency_key  text,
  payload          jsonb NOT NULL,
  status           text NOT NULL DEFAULT 'open',
  paid_on          date,
  paid_amount      numeric(14, 2),
  created_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (connection_id, kind, external_id),
  UNIQUE (connection_id, idempotency_key)
);

-- ---------------------------------------------------------------------------
-- RLS and grants
-- ---------------------------------------------------------------------------
ALTER TABLE supplier_invoice ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_facility ON supplier_invoice USING (tenant_id = app_tenant_id() AND app_can_see_facility(facility_id))
  WITH CHECK (tenant_id = app_tenant_id() AND app_can_see_facility(facility_id));
ALTER TABLE supplier_invoice_line ENABLE ROW LEVEL SECURITY;
CREATE POLICY via_parent ON supplier_invoice_line
  USING (tenant_id = app_tenant_id() AND EXISTS (SELECT 1 FROM supplier_invoice i WHERE i.id = invoice_id))
  WITH CHECK (tenant_id = app_tenant_id() AND EXISTS (SELECT 1 FROM supplier_invoice i WHERE i.id = invoice_id));
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['account_mapping', 'integration_connection', 'outbox_event', 'sync_delivery', 'export_file', 'mock_accounting_record']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id())', t);
  END LOOP;
END $$;

GRANT SELECT, INSERT, UPDATE ON supplier_invoice, integration_connection, sync_delivery, export_file, mock_accounting_record TO erp_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON supplier_invoice_line, account_mapping TO erp_app;
GRANT SELECT, INSERT ON outbox_event TO erp_app;

-- ---------------------------------------------------------------------------
-- Roles and permissions
-- ---------------------------------------------------------------------------
INSERT INTO role (tenant_id, key, name, permissions)
SELECT t.id, 'ap_clerk', 'Accounts Payable Clerk', ARRAY['org.view', 'parts.view', 'reports.view', 'reports.export', 'purchasing.view', 'ap.view', 'ap.manage']
FROM tenant t WHERE NOT EXISTS (SELECT 1 FROM role x WHERE x.tenant_id = t.id AND x.key = 'ap_clerk');

UPDATE role SET permissions = (SELECT array_agg(DISTINCT p) FROM unnest(permissions || ARRAY['ap.view', 'ap.manage', 'integrations.manage']) p) WHERE key = 'admin';
UPDATE role SET permissions = (SELECT array_agg(DISTINCT p) FROM unnest(permissions || ARRAY['ap.view', 'ap.manage']) p) WHERE key = 'finance_approver';
UPDATE role SET permissions = (SELECT array_agg(DISTINCT p) FROM unnest(permissions || ARRAY['ap.view']) p) WHERE key IN ('buyer', 'executive');
