-- SC-009 slice P1: projects and costing. Builds on 0160 (project, project_task, time_entry project columns).

-- Budgets, contract value and who may book time to a project.
ALTER TABLE project ADD COLUMN open_to_all   boolean NOT NULL DEFAULT false;                      -- any employee may book time, not only team members
ALTER TABLE project ADD COLUMN hours_budget  numeric(10, 2) CHECK (hours_budget IS NULL OR hours_budget >= 0);   -- null: the sum of the task budgets
ALTER TABLE project ADD COLUMN amount_budget numeric(14, 2) CHECK (amount_budget IS NULL OR amount_budget >= 0); -- cost budget (labor + expenses); null: the sum of the task budgets
ALTER TABLE project ADD COLUMN contract_amount numeric(14, 2) CHECK (contract_amount IS NULL OR contract_amount >= 0); -- original contract value (fixed price)
ALTER TABLE project ADD COLUMN status_reason text;                                                 -- why it was put on hold, cancelled or reopened

ALTER TABLE project_task ADD COLUMN hours_budget  numeric(10, 2) CHECK (hours_budget IS NULL OR hours_budget >= 0);
ALTER TABLE project_task ADD COLUMN amount_budget numeric(14, 2) CHECK (amount_budget IS NULL OR amount_budget >= 0);

-- The team: people who may book time to the project.
CREATE TABLE project_member (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenant(id),
  project_id   uuid NOT NULL REFERENCES project(id),
  employee_id  uuid NOT NULL REFERENCES employee(id),
  role         text,                                   -- e.g. "Senior consultant"
  active       boolean NOT NULL DEFAULT true,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, employee_id)
);
CREATE INDEX project_member_employee ON project_member (employee_id);

-- Milestones: a fixed-price amount or a percent of the contract. Reached by the owner or a manager; billed by the billing run (slice P2).
CREATE TABLE project_milestone (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenant(id),
  project_id   uuid NOT NULL REFERENCES project(id),
  sort_no      integer NOT NULL DEFAULT 0,
  name         text NOT NULL,
  due_date     date,
  amount       numeric(14, 2) CHECK (amount IS NULL OR amount >= 0),
  percent      numeric(6, 3) CHECK (percent IS NULL OR (percent >= 0 AND percent <= 100)),
  status       text NOT NULL DEFAULT 'planned' CHECK (status IN ('planned', 'reached', 'billed')),
  reached_on   date,
  reached_by   uuid REFERENCES app_user(id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, name),
  CHECK (amount IS NULL OR percent IS NULL),           -- one or the other
  CHECK (status = 'planned' OR reached_on IS NOT NULL)
);
CREATE INDEX project_milestone_project ON project_milestone (project_id);
CREATE INDEX project_milestone_reached_by ON project_milestone (reached_by);
CREATE INDEX project_milestone_due ON project_milestone (due_date) WHERE status = 'planned';

-- Change orders: signed adjustments to the contract value, each approved through the shared approval engine. Never deleted.
CREATE TABLE project_change_order (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenant(id),
  project_id    uuid NOT NULL REFERENCES project(id),
  seq           integer NOT NULL,
  amount        numeric(14, 2) NOT NULL CHECK (amount <> 0),   -- positive adds to the contract, negative reduces it
  reason        text NOT NULL,
  reference     text,                                          -- e.g. the customer's signed amendment number
  status        text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'withdrawn')),
  requested_by  uuid NOT NULL REFERENCES app_user(id),
  requested_at  timestamptz NOT NULL DEFAULT now(),
  decided_at    timestamptz,
  UNIQUE (project_id, seq)
);
CREATE INDEX project_change_order_requested_by ON project_change_order (requested_by);

-- What a person's hour costs the company, by effective date. Visible and editable only with projects.see_cost (checked in the service).
CREATE TABLE employee_cost_rate (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenant(id),
  employee_id     uuid NOT NULL REFERENCES employee(id),
  effective_from  date NOT NULL,
  hourly_cost     numeric(10, 2) NOT NULL CHECK (hourly_cost >= 0),
  created_by      uuid NOT NULL REFERENCES app_user(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (employee_id, effective_from)
);
CREATE INDEX employee_cost_rate_created_by ON employee_cost_rate (created_by);

-- Company settings for projects: the share of the hours budget at which the owner is warned (default 90).
CREATE TABLE project_settings (
  tenant_id        uuid PRIMARY KEY REFERENCES tenant(id),
  budget_alert_pct integer NOT NULL DEFAULT 90 CHECK (budget_alert_pct BETWEEN 50 AND 100),
  updated_by       uuid REFERENCES app_user(id),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX project_settings_updated_by ON project_settings (updated_by);

-- Expenses can name the project they were spent on, and whether they can be charged to the customer.
ALTER TABLE expense_line ADD COLUMN project_id uuid REFERENCES project(id);
ALTER TABLE expense_line ADD COLUMN billable boolean NOT NULL DEFAULT false;
CREATE INDEX expense_line_project ON expense_line (project_id);

DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['project_member', 'project_milestone', 'project_change_order'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY via_parent ON %I USING (tenant_id = app_tenant_id() AND EXISTS (SELECT 1 FROM project p WHERE p.id = project_id)) WITH CHECK (tenant_id = app_tenant_id() AND EXISTS (SELECT 1 FROM project p WHERE p.id = project_id))', t);
  END LOOP;
  FOREACH t IN ARRAY ARRAY['employee_cost_rate', 'project_settings'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id())', t);
  END LOOP;
END $$;
GRANT SELECT, INSERT, UPDATE ON project_member, project_milestone, project_change_order, employee_cost_rate, project_settings TO erp_app;
GRANT DELETE ON project_milestone TO erp_app;

-- A change order is a record of what was agreed: only its status and decision time may change.
CREATE FUNCTION project_change_order_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.amount <> OLD.amount OR NEW.reason <> OLD.reason OR NEW.project_id <> OLD.project_id OR NEW.seq <> OLD.seq OR NEW.requested_by <> OLD.requested_by THEN
    RAISE EXCEPTION 'a change order cannot be edited; withdraw it and raise a new one';
  END IF;
  IF OLD.status <> 'pending' AND NEW.status <> OLD.status THEN RAISE EXCEPTION 'a decided change order cannot change (it is %)', OLD.status; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER project_change_order_guard BEFORE UPDATE ON project_change_order FOR EACH ROW EXECUTE FUNCTION project_change_order_guard();

-- Permissions for existing companies (new companies get them from the role templates).
UPDATE role SET permissions = (SELECT array_agg(DISTINCT p) FROM unnest(permissions || ARRAY['projects.view', 'projects.manage', 'projects.see_cost']) p) WHERE key = 'admin';
UPDATE role SET permissions = (SELECT array_agg(DISTINCT p) FROM unnest(permissions || ARRAY['projects.view', 'projects.manage']) p) WHERE key = 'operations_manager';
UPDATE role SET permissions = (SELECT array_agg(DISTINCT p) FROM unnest(permissions || ARRAY['projects.view', 'projects.see_cost']) p) WHERE key IN ('finance_approver', 'executive');
UPDATE role SET permissions = (SELECT array_agg(DISTINCT p) FROM unnest(permissions || ARRAY['projects.view']) p) WHERE key IN ('sales_manager', 'ar_clerk');
INSERT INTO role (tenant_id, key, name, permissions)
SELECT t.id, 'project_manager', 'Project Manager', ARRAY['org.view', 'employees.view', 'crm.view', 'reports.view', 'reports.export', 'expenses.submit', 'improve.submit', 'projects.view', 'projects.manage']
FROM tenant t ON CONFLICT (tenant_id, key) DO NOTHING;
