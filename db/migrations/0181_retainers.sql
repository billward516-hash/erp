-- SC-009 P2: retainers and subscriptions. A plan bills a fixed amount per calendar month, quarter or year. The daily job makes
-- one charge (and one invoice) per plan per period: retainer_charge is unique on (plan, period start).
CREATE TABLE retainer_plan (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             uuid NOT NULL REFERENCES tenant(id),
  facility_id           uuid NOT NULL REFERENCES facility(id),
  number                text NOT NULL,
  customer_id           uuid NOT NULL REFERENCES customer(id),
  project_id            uuid REFERENCES project(id),
  description           text NOT NULL,
  amount                numeric(14, 2) NOT NULL CHECK (amount > 0),   -- the opening amount; later changes are in retainer_plan_amount
  billing_interval      text NOT NULL CHECK (billing_interval IN ('month', 'quarter', 'year')),
  start_date            date NOT NULL,
  end_date              date,                                          -- end of the current term; null = open-ended
  auto_renew            boolean NOT NULL DEFAULT false,
  renewal_term_months   integer NOT NULL DEFAULT 12 CHECK (renewal_term_months BETWEEN 1 AND 60),
  notice_days           integer NOT NULL DEFAULT 30 CHECK (notice_days BETWEEN 0 AND 365),
  prorate               boolean NOT NULL DEFAULT true,
  status                text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'cancelled')),
  cancel_on             date,                                          -- last day covered; set when a cancellation is scheduled or done
  cancel_reason         text,
  last_error            text,
  last_error_at         timestamptz,
  created_by            uuid NOT NULL REFERENCES app_user(id),
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, number),
  CHECK (end_date IS NULL OR end_date >= start_date),
  CHECK (cancel_on IS NULL OR cancel_on >= start_date)
);
CREATE INDEX retainer_plan_facility ON retainer_plan (facility_id);
CREATE INDEX retainer_plan_customer ON retainer_plan (customer_id);
CREATE INDEX retainer_plan_project ON retainer_plan (project_id) WHERE project_id IS NOT NULL;
CREATE INDEX retainer_plan_created_by ON retainer_plan (created_by);
ALTER TABLE retainer_plan ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_facility ON retainer_plan USING (tenant_id = app_tenant_id() AND app_can_see_facility(facility_id)) WITH CHECK (tenant_id = app_tenant_id() AND app_can_see_facility(facility_id));
GRANT SELECT, INSERT, UPDATE ON retainer_plan TO erp_app;

-- The amount from a date on (the first row is the opening amount). A period uses the amount in force on its first day.
CREATE TABLE retainer_plan_amount (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenant(id),
  plan_id         uuid NOT NULL REFERENCES retainer_plan(id),
  effective_from  date NOT NULL,
  amount          numeric(14, 2) NOT NULL CHECK (amount > 0),
  created_by      uuid NOT NULL REFERENCES app_user(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (plan_id, effective_from)
);
CREATE INDEX retainer_plan_amount_created_by ON retainer_plan_amount (created_by);
ALTER TABLE retainer_plan_amount ENABLE ROW LEVEL SECURITY;
CREATE POLICY via_parent ON retainer_plan_amount USING (tenant_id = app_tenant_id() AND EXISTS (SELECT 1 FROM retainer_plan p WHERE p.id = plan_id)) WITH CHECK (tenant_id = app_tenant_id() AND EXISTS (SELECT 1 FROM retainer_plan p WHERE p.id = plan_id));
GRANT SELECT, INSERT ON retainer_plan_amount TO erp_app;

-- Periods that start inside a pause are skipped, not billed later.
CREATE TABLE retainer_pause (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenant(id),
  plan_id     uuid NOT NULL REFERENCES retainer_plan(id),
  from_date   date NOT NULL,
  to_date     date,                                  -- null while still paused; the day billing resumes (periods starting on or after it bill)
  reason      text,
  created_by  uuid NOT NULL REFERENCES app_user(id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  CHECK (to_date IS NULL OR to_date >= from_date)
);
CREATE INDEX retainer_pause_plan ON retainer_pause (plan_id);
CREATE INDEX retainer_pause_created_by ON retainer_pause (created_by);
ALTER TABLE retainer_pause ENABLE ROW LEVEL SECURITY;
CREATE POLICY via_parent ON retainer_pause USING (tenant_id = app_tenant_id() AND EXISTS (SELECT 1 FROM retainer_plan p WHERE p.id = plan_id)) WITH CHECK (tenant_id = app_tenant_id() AND EXISTS (SELECT 1 FROM retainer_plan p WHERE p.id = plan_id));
GRANT SELECT, INSERT, UPDATE ON retainer_pause TO erp_app;

CREATE TABLE retainer_charge (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenant(id),
  plan_id       uuid NOT NULL REFERENCES retainer_plan(id),
  period_start  date NOT NULL,
  period_end    date NOT NULL,
  covered_from  date NOT NULL,                       -- the days actually charged (a partial first or last period)
  covered_to    date NOT NULL,
  amount        numeric(14, 2) NOT NULL CHECK (amount >= 0),
  prorated      boolean NOT NULL DEFAULT false,
  status        text NOT NULL DEFAULT 'generated' CHECK (status IN ('generated', 'released')),
  invoice_id    uuid REFERENCES customer_invoice(id),
  run_id        uuid REFERENCES billing_run(id),     -- set when a billing run folded this period into its invoice
  automatic     boolean NOT NULL DEFAULT true,
  generated_by  uuid REFERENCES app_user(id),
  generated_at  timestamptz NOT NULL DEFAULT now(),
  released_at   timestamptz,
  UNIQUE (plan_id, period_start),
  CHECK (period_end >= period_start)
);
CREATE INDEX retainer_charge_invoice ON retainer_charge (invoice_id) WHERE invoice_id IS NOT NULL;
CREATE INDEX retainer_charge_run ON retainer_charge (run_id) WHERE run_id IS NOT NULL;
CREATE INDEX retainer_charge_generated_by ON retainer_charge (generated_by) WHERE generated_by IS NOT NULL;
ALTER TABLE retainer_charge ENABLE ROW LEVEL SECURITY;
CREATE POLICY via_parent ON retainer_charge USING (tenant_id = app_tenant_id() AND EXISTS (SELECT 1 FROM retainer_plan p WHERE p.id = plan_id)) WITH CHECK (tenant_id = app_tenant_id() AND EXISTS (SELECT 1 FROM retainer_plan p WHERE p.id = plan_id));
GRANT SELECT, INSERT, UPDATE ON retainer_charge TO erp_app;

ALTER TABLE customer_invoice_line ADD COLUMN retainer_charge_id uuid REFERENCES retainer_charge(id) ON DELETE SET NULL;
CREATE INDEX customer_invoice_line_retainer_charge ON customer_invoice_line (retainer_charge_id) WHERE retainer_charge_id IS NOT NULL;

-- A retainer line is changed through the plan, not on the invoice (the line lock now covers it too).
CREATE OR REPLACE FUNCTION billing_line_lock() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (OLD.billing_run_id IS NOT NULL OR OLD.retainer_charge_id IS NOT NULL) AND (NEW.qty IS DISTINCT FROM OLD.qty OR NEW.unit_price IS DISTINCT FROM OLD.unit_price OR NEW.description IS DISTINCT FROM OLD.description) THEN
    RAISE EXCEPTION 'this line came from billing; void the draft and bill again to change it, or remove the line to release its work';
  END IF;
  RETURN NEW;
END $$;

-- Voiding the invoice, or removing the line from a draft, releases the retainer period: it can be billed in a run or regenerated
-- from the plan (the daily job does not regenerate a released period by itself).
CREATE OR REPLACE FUNCTION billing_release_on_void() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status = 'void' AND OLD.status <> 'void' THEN
    UPDATE billing_claim SET released_at = now(), release_reason = 'invoice voided' WHERE invoice_id = NEW.id AND released_at IS NULL;
    UPDATE retainer_charge SET status = 'released', released_at = now() WHERE invoice_id = NEW.id AND status = 'generated';
    UPDATE billing_run SET status = 'open', invoice_id = NULL, invoiced_by = NULL, invoiced_at = NULL WHERE invoice_id = NEW.id AND status = 'invoiced';
  END IF;
  RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION billing_release_on_line_delete() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE billing_claim SET released_at = now(), release_reason = 'line removed from the draft invoice' WHERE invoice_line_id = OLD.id AND released_at IS NULL;
  IF OLD.retainer_charge_id IS NOT NULL THEN
    UPDATE retainer_charge SET status = 'released', released_at = now() WHERE id = OLD.retainer_charge_id AND status = 'generated';
  END IF;
  RETURN OLD;
END $$;
