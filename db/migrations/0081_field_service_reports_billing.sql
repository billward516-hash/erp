-- SC-002 F3 Service reports from the tablet, billing and recommended repairs.
ALTER TABLE field_service_settings
  ADD COLUMN labor_rate_per_hour numeric(10, 2) NOT NULL DEFAULT 95 CHECK (labor_rate_per_hour >= 0),
  ADD COLUMN parts_markup_percent numeric(6, 2) NOT NULL DEFAULT 25 CHECK (parts_markup_percent >= 0);
ALTER TABLE service_agreement ADD COLUMN parts_included boolean NOT NULL DEFAULT false;

CREATE TABLE service_report (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            uuid NOT NULL REFERENCES tenant(id),
  facility_id          uuid NOT NULL REFERENCES facility(id),
  visit_id             uuid NOT NULL UNIQUE REFERENCES service_visit(id),
  technician_id        uuid NOT NULL REFERENCES employee(id),
  status               text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'submitted')),
  arrived_at           timestamptz,
  departed_at          timestamptz,
  labor_hours          numeric(6, 2) CHECK (labor_hours > 0),
  checklist_results    jsonb NOT NULL DEFAULT '[]',
  readings             jsonb NOT NULL DEFAULT '[]',
  work_performed       text,
  findings             text,
  parts_used           jsonb NOT NULL DEFAULT '[]',
  recommended_repairs  jsonb NOT NULL DEFAULT '[]',
  customer_present     boolean NOT NULL DEFAULT true,
  customer_signed_name text,
  customer_signed_at   timestamptz,
  signature_png        text,
  no_signature_reason  text,
  first_time_fix       boolean,
  billing_status       text NOT NULL DEFAULT 'pending' CHECK (billing_status IN ('pending', 'ready', 'covered', 'billed')),
  invoice_id           uuid REFERENCES customer_invoice(id),
  quote_id             uuid REFERENCES quote(id),
  submitted_at         timestamptz,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  CHECK (status = 'draft' OR (work_performed IS NOT NULL AND labor_hours IS NOT NULL))
);
CREATE INDEX ix_sreport_facility ON service_report (facility_id);
CREATE INDEX ix_sreport_tech ON service_report (technician_id);
CREATE INDEX ix_sreport_invoice ON service_report (invoice_id) WHERE invoice_id IS NOT NULL;
CREATE INDEX ix_sreport_quote ON service_report (quote_id) WHERE quote_id IS NOT NULL;
CREATE INDEX ix_sreport_ready ON service_report (tenant_id) WHERE billing_status = 'ready';
ALTER TABLE service_report ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_facility ON service_report USING (tenant_id = app_tenant_id() AND app_can_see_facility(facility_id)) WITH CHECK (tenant_id = app_tenant_id() AND app_can_see_facility(facility_id));
GRANT SELECT, INSERT, UPDATE ON service_report TO erp_app;

-- Flat monthly fees: one invoice per agreement per month.
CREATE TABLE service_billing (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenant(id),
  agreement_id  uuid NOT NULL REFERENCES service_agreement(id),
  period        date NOT NULL,
  amount        numeric(14, 2) NOT NULL,
  invoice_id    uuid NOT NULL REFERENCES customer_invoice(id),
  billed_by     uuid NOT NULL REFERENCES app_user(id),
  billed_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (agreement_id, period),
  CHECK (period = date_trunc('month', period)::date)
);
CREATE INDEX ix_sbilling_tenant ON service_billing (tenant_id);
CREATE INDEX ix_sbilling_invoice ON service_billing (invoice_id);
CREATE INDEX ix_sbilling_by ON service_billing (billed_by);
ALTER TABLE service_billing ENABLE ROW LEVEL SECURITY;
CREATE POLICY via_parent ON service_billing USING (tenant_id = app_tenant_id() AND EXISTS (SELECT 1 FROM service_agreement a WHERE a.id = agreement_id)) WITH CHECK (tenant_id = app_tenant_id());
GRANT SELECT, INSERT ON service_billing TO erp_app;
