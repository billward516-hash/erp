-- SC-009 P2: bill rates, billing runs and fixed-price terms. Money sources (approved billable time, approved billable expenses,
-- reached milestones, percent complete) are stamped in billing_claim so nothing bills twice; voiding the invoice, or removing
-- the line from a draft, releases the claim (triggers below). Retainers are in 0181.

-- Company billing settings: hours rounding (off by default; nearest 0.25 hour) and how scheduled retainer invoices are made.
CREATE TABLE billing_settings (
  tenant_id           uuid PRIMARY KEY REFERENCES tenant(id),
  round_hours_to      numeric(4, 2) CHECK (round_hours_to IS NULL OR round_hours_to = 0.25),
  retainer_issue_mode text NOT NULL DEFAULT 'draft' CHECK (retainer_issue_mode IN ('draft', 'issue')),
  updated_by          uuid NOT NULL REFERENCES app_user(id),
  updated_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX billing_settings_updated_by ON billing_settings (updated_by);
ALTER TABLE billing_settings ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_only ON billing_settings USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());
GRANT SELECT, INSERT, UPDATE ON billing_settings TO erp_app;

-- Bill rates. Resolution order (code, billing/rates.ts): project > customer > person > role > default; inside project and
-- customer a rate that names a person beats one that names a role beats one for everybody; the latest start inside the date window wins.
CREATE TABLE bill_rate (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenant(id),
  scope           text NOT NULL CHECK (scope IN ('project', 'customer', 'person', 'role', 'default')),
  project_id      uuid REFERENCES project(id),
  customer_id     uuid REFERENCES customer(id),
  employee_id     uuid REFERENCES employee(id),
  role_key        text,                          -- lower-cased, trimmed job title
  role_label      text,
  amount          numeric(12, 2) NOT NULL CHECK (amount >= 0),
  effective_from  date NOT NULL,
  effective_to    date,
  note            text,
  created_by      uuid NOT NULL REFERENCES app_user(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  CHECK (effective_to IS NULL OR effective_to >= effective_from),
  CHECK ((role_key IS NULL) = (role_label IS NULL)),
  CHECK (NOT (employee_id IS NOT NULL AND role_key IS NOT NULL)),
  CHECK (
       (scope = 'project'  AND project_id IS NOT NULL AND customer_id IS NULL)
    OR (scope = 'customer' AND customer_id IS NOT NULL AND project_id IS NULL)
    OR (scope = 'person'   AND employee_id IS NOT NULL AND project_id IS NULL AND customer_id IS NULL AND role_key IS NULL)
    OR (scope = 'role'     AND role_key IS NOT NULL AND project_id IS NULL AND customer_id IS NULL AND employee_id IS NULL)
    OR (scope = 'default'  AND project_id IS NULL AND customer_id IS NULL AND employee_id IS NULL AND role_key IS NULL))
);
CREATE INDEX bill_rate_project ON bill_rate (project_id) WHERE project_id IS NOT NULL;
CREATE INDEX bill_rate_customer ON bill_rate (customer_id) WHERE customer_id IS NOT NULL;
CREATE INDEX bill_rate_employee ON bill_rate (employee_id) WHERE employee_id IS NOT NULL;
CREATE INDEX bill_rate_tenant_scope ON bill_rate (tenant_id, scope, effective_from);
CREATE INDEX bill_rate_created_by ON bill_rate (created_by);
ALTER TABLE bill_rate ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_only ON bill_rate USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());
GRANT SELECT, INSERT, UPDATE ON bill_rate TO erp_app;

-- Fixed-price terms for a project: contract value and how it is billed (by milestone, or by percent complete).
CREATE TABLE billing_contract (
  project_id        uuid PRIMARY KEY REFERENCES project(id),
  tenant_id         uuid NOT NULL REFERENCES tenant(id),
  contract_value    numeric(14, 2) NOT NULL CHECK (contract_value >= 0),
  method            text NOT NULL CHECK (method IN ('milestone', 'percent_complete')),
  percent_complete  numeric(5, 2) NOT NULL DEFAULT 0 CHECK (percent_complete BETWEEN 0 AND 100),
  updated_by        uuid NOT NULL REFERENCES app_user(id),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX billing_contract_tenant ON billing_contract (tenant_id);
CREATE INDEX billing_contract_updated_by ON billing_contract (updated_by);
ALTER TABLE billing_contract ENABLE ROW LEVEL SECURITY;
CREATE POLICY via_parent ON billing_contract USING (tenant_id = app_tenant_id() AND EXISTS (SELECT 1 FROM project p WHERE p.id = project_id)) WITH CHECK (tenant_id = app_tenant_id() AND EXISTS (SELECT 1 FROM project p WHERE p.id = project_id));
GRANT SELECT, INSERT, UPDATE ON billing_contract TO erp_app;

CREATE TABLE billing_milestone (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenant(id),
  project_id  uuid NOT NULL REFERENCES project(id),
  sort_no     integer NOT NULL DEFAULT 0,
  name        text NOT NULL,
  amount      numeric(14, 2) NOT NULL CHECK (amount > 0),
  due_date    date,
  status      text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'reached')),
  reached_on  date,
  reached_by  uuid REFERENCES app_user(id),
  created_by  uuid NOT NULL REFERENCES app_user(id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, name),
  CHECK ((status = 'reached') = (reached_on IS NOT NULL))
);
CREATE INDEX billing_milestone_project ON billing_milestone (project_id);
CREATE INDEX billing_milestone_reached_by ON billing_milestone (reached_by) WHERE reached_by IS NOT NULL;
CREATE INDEX billing_milestone_created_by ON billing_milestone (created_by);
ALTER TABLE billing_milestone ENABLE ROW LEVEL SECURITY;
CREATE POLICY via_parent ON billing_milestone USING (tenant_id = app_tenant_id() AND EXISTS (SELECT 1 FROM project p WHERE p.id = project_id)) WITH CHECK (tenant_id = app_tenant_id() AND EXISTS (SELECT 1 FROM project p WHERE p.id = project_id));
GRANT SELECT, INSERT, UPDATE ON billing_milestone TO erp_app;

-- A billing run: one customer (optionally one project) and a period at one site. Items are computed live from the sources;
-- only the person's edits (adjustments) and the outcome are stored.
CREATE TABLE billing_run (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES tenant(id),
  facility_id       uuid NOT NULL REFERENCES facility(id),
  number            text NOT NULL,
  customer_id       uuid NOT NULL REFERENCES customer(id),
  project_id        uuid REFERENCES project(id),
  period_from       date NOT NULL,
  period_to         date NOT NULL,
  status            text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'invoiced', 'closed', 'cancelled')),   -- closed: everything in it was written off, so there is no invoice
  invoice_id        uuid REFERENCES customer_invoice(id),
  notes             text,
  cancel_reason     text,
  created_by        uuid NOT NULL REFERENCES app_user(id),
  created_at        timestamptz NOT NULL DEFAULT now(),
  invoiced_by       uuid REFERENCES app_user(id),
  invoiced_at       timestamptz,
  UNIQUE (tenant_id, number),
  CHECK (period_to >= period_from),
  CHECK (status <> 'invoiced' OR invoice_id IS NOT NULL)
);
CREATE INDEX billing_run_facility ON billing_run (facility_id);
CREATE INDEX billing_run_customer ON billing_run (customer_id);
CREATE INDEX billing_run_project ON billing_run (project_id) WHERE project_id IS NOT NULL;
CREATE INDEX billing_run_invoice ON billing_run (invoice_id) WHERE invoice_id IS NOT NULL;
CREATE INDEX billing_run_created_by ON billing_run (created_by);
CREATE INDEX billing_run_invoiced_by ON billing_run (invoiced_by) WHERE invoiced_by IS NOT NULL;
ALTER TABLE billing_run ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_facility ON billing_run USING (tenant_id = app_tenant_id() AND app_can_see_facility(facility_id)) WITH CHECK (tenant_id = app_tenant_id() AND app_can_see_facility(facility_id));
GRANT SELECT, INSERT, UPDATE ON billing_run TO erp_app;

-- Edits to a run's items: a new description, a write-down, or a write-off (the last two need a reason and a permission).
CREATE TABLE billing_adjustment (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenant(id),
  run_id       uuid NOT NULL REFERENCES billing_run(id),
  source_key   text NOT NULL,                      -- 'time:<id>', 'expense:<id>', 'milestone:<id>', 'percent:<project id>', 'retainer:<plan id>:<period start>'
  description  text,
  writedown    numeric(12, 2) NOT NULL DEFAULT 0 CHECK (writedown >= 0),
  write_off    boolean NOT NULL DEFAULT false,
  reason       text,
  updated_by   uuid NOT NULL REFERENCES app_user(id),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (run_id, source_key),
  CHECK ((writedown = 0 AND NOT write_off) OR (reason IS NOT NULL AND length(btrim(reason)) >= 3))
);
CREATE INDEX billing_adjustment_updated_by ON billing_adjustment (updated_by);
ALTER TABLE billing_adjustment ENABLE ROW LEVEL SECURITY;
CREATE POLICY via_parent ON billing_adjustment USING (tenant_id = app_tenant_id() AND EXISTS (SELECT 1 FROM billing_run r WHERE r.id = run_id)) WITH CHECK (tenant_id = app_tenant_id() AND EXISTS (SELECT 1 FROM billing_run r WHERE r.id = run_id));
GRANT SELECT, INSERT, UPDATE, DELETE ON billing_adjustment TO erp_app;

-- A hold keeps one entry out of every run until someone releases it.
CREATE TABLE billing_hold (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenant(id),
  source_kind  text NOT NULL CHECK (source_kind IN ('time', 'expense', 'milestone')),
  source_id    uuid NOT NULL,
  reason       text NOT NULL CHECK (length(btrim(reason)) >= 3),
  held_by      uuid NOT NULL REFERENCES app_user(id),
  held_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source_kind, source_id)
);
CREATE INDEX billing_hold_tenant ON billing_hold (tenant_id);
CREATE INDEX billing_hold_held_by ON billing_hold (held_by);
ALTER TABLE billing_hold ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_only ON billing_hold USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());
GRANT SELECT, INSERT, DELETE ON billing_hold TO erp_app;

-- The stamp: each source row is billed (or written off) at most once while the claim is live. Unique per live source.
CREATE TABLE billing_claim (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenant(id),
  run_id           uuid REFERENCES billing_run(id),
  project_id       uuid REFERENCES project(id),
  source_kind      text NOT NULL CHECK (source_kind IN ('time', 'expense', 'milestone', 'percent')),
  source_id        uuid NOT NULL,
  invoice_id       uuid REFERENCES customer_invoice(id),
  invoice_line_id  uuid REFERENCES customer_invoice_line(id) ON DELETE SET NULL,
  status           text NOT NULL DEFAULT 'billed' CHECK (status IN ('billed', 'written_off')),
  list_amount      numeric(14, 2) NOT NULL,
  writedown        numeric(14, 2) NOT NULL DEFAULT 0,
  amount           numeric(14, 2) NOT NULL,       -- billed (net of write-down); zero when written off
  writedown_reason text,
  claimed_by       uuid NOT NULL REFERENCES app_user(id),
  claimed_at       timestamptz NOT NULL DEFAULT now(),
  released_at      timestamptz,
  release_reason   text,
  CHECK (status = 'written_off' OR invoice_id IS NOT NULL)
);
CREATE UNIQUE INDEX billing_claim_live_source ON billing_claim (source_kind, source_id) WHERE released_at IS NULL;
CREATE INDEX billing_claim_run ON billing_claim (run_id) WHERE run_id IS NOT NULL;
CREATE INDEX billing_claim_project ON billing_claim (project_id) WHERE project_id IS NOT NULL;
CREATE INDEX billing_claim_invoice ON billing_claim (invoice_id) WHERE invoice_id IS NOT NULL;
CREATE INDEX billing_claim_invoice_line ON billing_claim (invoice_line_id) WHERE invoice_line_id IS NOT NULL;
CREATE INDEX billing_claim_claimed_by ON billing_claim (claimed_by);
ALTER TABLE billing_claim ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_only ON billing_claim USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());
GRANT SELECT, INSERT, UPDATE ON billing_claim TO erp_app;

-- Where an invoice line came from.
ALTER TABLE customer_invoice_line ADD COLUMN project_id uuid REFERENCES project(id);
ALTER TABLE customer_invoice_line ADD COLUMN time_entry_id uuid REFERENCES time_entry(id);
ALTER TABLE customer_invoice_line ADD COLUMN expense_line_id uuid REFERENCES expense_line(id);
ALTER TABLE customer_invoice_line ADD COLUMN milestone_id uuid REFERENCES billing_milestone(id);
ALTER TABLE customer_invoice_line ADD COLUMN billing_run_id uuid REFERENCES billing_run(id);
CREATE INDEX customer_invoice_line_project ON customer_invoice_line (project_id) WHERE project_id IS NOT NULL;
CREATE INDEX customer_invoice_line_time_entry ON customer_invoice_line (time_entry_id) WHERE time_entry_id IS NOT NULL;
CREATE INDEX customer_invoice_line_expense_line ON customer_invoice_line (expense_line_id) WHERE expense_line_id IS NOT NULL;
CREATE INDEX customer_invoice_line_milestone ON customer_invoice_line (milestone_id) WHERE milestone_id IS NOT NULL;
CREATE INDEX customer_invoice_line_billing_run ON customer_invoice_line (billing_run_id) WHERE billing_run_id IS NOT NULL;

-- Voiding an invoice releases everything it billed, so the work can be billed again; the run that made it opens again.
CREATE FUNCTION billing_release_on_void() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status = 'void' AND OLD.status <> 'void' THEN
    UPDATE billing_claim SET released_at = now(), release_reason = 'invoice voided' WHERE invoice_id = NEW.id AND released_at IS NULL;
    UPDATE billing_run SET status = 'open', invoice_id = NULL, invoiced_by = NULL, invoiced_at = NULL WHERE invoice_id = NEW.id AND status = 'invoiced';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER billing_release_on_void AFTER UPDATE OF status ON customer_invoice FOR EACH ROW EXECUTE FUNCTION billing_release_on_void();

-- Removing a billed line from a draft releases that line's work.
CREATE FUNCTION billing_release_on_line_delete() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE billing_claim SET released_at = now(), release_reason = 'line removed from the draft invoice' WHERE invoice_line_id = OLD.id AND released_at IS NULL;
  RETURN OLD;
END $$;
CREATE TRIGGER billing_release_on_line_delete BEFORE DELETE ON customer_invoice_line FOR EACH ROW EXECUTE FUNCTION billing_release_on_line_delete();

-- A line made by a billing run is changed in the run (or removed), not on the invoice, so the claim and the invoice agree.
CREATE FUNCTION billing_line_lock() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.billing_run_id IS NOT NULL AND (NEW.qty IS DISTINCT FROM OLD.qty OR NEW.unit_price IS DISTINCT FROM OLD.unit_price OR NEW.description IS DISTINCT FROM OLD.description) THEN
    RAISE EXCEPTION 'this line came from a billing run; void the draft and run billing again to change it, or remove the line to release its work';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER billing_line_lock BEFORE UPDATE ON customer_invoice_line FOR EACH ROW EXECUTE FUNCTION billing_line_lock();
