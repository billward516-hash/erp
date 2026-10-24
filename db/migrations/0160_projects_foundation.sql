-- SC-009 foundation (service companies): the project record that time, billing, staffing and tickets all point to.
-- Slices build on it: projects and costing (0170s), rates, billing runs and retainers (0180s), staffing and utilization (0190s),
-- support tickets (0200s). Only what they share lives here.
CREATE TABLE project (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenant(id),
  facility_id    uuid NOT NULL REFERENCES facility(id),   -- the site that invoices and owns the work
  number         text NOT NULL,
  name           text NOT NULL,
  customer_id    uuid REFERENCES customer(id),            -- null for internal work
  status         text NOT NULL DEFAULT 'active' CHECK (status IN ('proposed', 'active', 'on_hold', 'completed', 'cancelled')),
  billing_type   text NOT NULL DEFAULT 'time_materials' CHECK (billing_type IN ('time_materials', 'fixed_price', 'retainer', 'non_billable')),
  owner_user_id  uuid REFERENCES app_user(id),
  start_date     date,
  end_date       date,
  description    text,
  created_by     uuid NOT NULL REFERENCES app_user(id),
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, number),
  CHECK (end_date IS NULL OR start_date IS NULL OR end_date >= start_date)
);
CREATE INDEX project_facility ON project (facility_id);
CREATE INDEX project_customer ON project (customer_id);
CREATE INDEX project_owner ON project (owner_user_id);
CREATE INDEX project_created_by ON project (created_by);
ALTER TABLE project ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_facility ON project USING (tenant_id = app_tenant_id() AND app_can_see_facility(facility_id)) WITH CHECK (tenant_id = app_tenant_id() AND app_can_see_facility(facility_id));
GRANT SELECT, INSERT, UPDATE ON project TO erp_app;

CREATE TABLE project_task (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenant(id),
  project_id  uuid NOT NULL REFERENCES project(id),
  sort_no     integer NOT NULL DEFAULT 0,
  name        text NOT NULL,
  billable    boolean NOT NULL DEFAULT true,
  active      boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, name)
);
CREATE INDEX project_task_project ON project_task (project_id);
ALTER TABLE project_task ENABLE ROW LEVEL SECURITY;
CREATE POLICY via_parent ON project_task USING (tenant_id = app_tenant_id() AND EXISTS (SELECT 1 FROM project p WHERE p.id = project_id)) WITH CHECK (tenant_id = app_tenant_id() AND EXISTS (SELECT 1 FROM project p WHERE p.id = project_id));
GRANT SELECT, INSERT, UPDATE ON project_task TO erp_app;

-- Time against a project: an hour on a timesheet can name its project, optionally a task, and whether it is billable.
ALTER TABLE time_entry DROP CONSTRAINT time_entry_source_check;
ALTER TABLE time_entry ADD CONSTRAINT time_entry_source_check CHECK (source IN ('manual', 'work_order', 'project'));
ALTER TABLE time_entry ADD COLUMN project_id uuid REFERENCES project(id);
ALTER TABLE time_entry ADD COLUMN project_task_id uuid REFERENCES project_task(id);
ALTER TABLE time_entry ADD COLUMN billable boolean NOT NULL DEFAULT false;
CREATE INDEX time_entry_project ON time_entry (project_id);
CREATE INDEX time_entry_project_task ON time_entry (project_task_id);
