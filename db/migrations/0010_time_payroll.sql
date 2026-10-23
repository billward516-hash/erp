-- 0010 Time capture, approval and payroll-ready export (Category 1 workforce essentials).
-- Weekly timesheets per employee. Work-order labor is the source for maintenance hours and is copied
-- into the timesheet when it is submitted; other time (training, meetings, leave) is entered directly.
-- A supervisor other than the employee approves. Approved weeks are exported for the payroll provider,
-- which remains the system of record for pay, overtime calculation, taxes and payments.

CREATE TABLE earning_code (
  tenant_id      uuid NOT NULL REFERENCES tenant(id),
  code           text NOT NULL,
  label          text NOT NULL,
  kind           text NOT NULL CHECK (kind IN ('worked', 'paid_leave', 'unpaid')),
  external_code  text,                           -- the payroll provider's code; defaults to code
  active         boolean NOT NULL DEFAULT true,
  PRIMARY KEY (tenant_id, code)
);

CREATE TABLE timesheet (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES tenant(id),
  facility_id       uuid NOT NULL REFERENCES facility(id),
  employee_id       uuid NOT NULL REFERENCES employee(id),
  week_start        date NOT NULL CHECK (extract(isodow FROM week_start) = 1),   -- Monday
  status            text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'submitted', 'approved', 'rejected', 'exported')),
  submitted_by      uuid REFERENCES app_user(id),
  submitted_at      timestamptz,
  decided_by        uuid REFERENCES app_user(id),
  decided_at        timestamptz,
  decision_comment  text,
  export_id         uuid,
  created_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (employee_id, week_start)
);

CREATE TABLE time_entry (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            uuid NOT NULL REFERENCES tenant(id),
  timesheet_id         uuid NOT NULL REFERENCES timesheet(id),
  work_date            date NOT NULL,
  earning_code         text NOT NULL,
  hours                numeric(5, 2) NOT NULL CHECK (hours > 0 AND hours <= 24),
  source               text NOT NULL CHECK (source IN ('manual', 'work_order')),
  work_order_labor_id  uuid UNIQUE REFERENCES work_order_labor(id),
  work_order_id        uuid REFERENCES work_order(id),
  note                 text,
  created_by           uuid NOT NULL REFERENCES app_user(id),
  created_at           timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX time_entry_sheet ON time_entry (timesheet_id, work_date);

CREATE TABLE payroll_export (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenant(id),
  period_from   date NOT NULL,
  period_to     date NOT NULL,
  layout        text NOT NULL CHECK (layout IN ('summary', 'daily')),
  file_name     text NOT NULL,
  content       text NOT NULL,
  row_count     integer NOT NULL,
  timesheets    integer NOT NULL,
  created_by    uuid NOT NULL REFERENCES app_user(id),
  created_at    timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE timesheet ADD CONSTRAINT timesheet_export_fk FOREIGN KEY (export_id) REFERENCES payroll_export(id);

-- Approved and exported timesheets are frozen: their entries cannot change.
CREATE FUNCTION time_entry_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE s text;
BEGIN
  SELECT status INTO s FROM timesheet WHERE id = COALESCE(NEW.timesheet_id, OLD.timesheet_id);
  IF s IN ('approved', 'exported') THEN RAISE EXCEPTION 'timesheet is %; its entries cannot change', s; END IF;
  RETURN COALESCE(NEW, OLD);
END $$;
CREATE TRIGGER time_entry_guard BEFORE INSERT OR UPDATE OR DELETE ON time_entry FOR EACH ROW EXECUTE FUNCTION time_entry_guard();

ALTER TABLE timesheet ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_facility ON timesheet USING (tenant_id = app_tenant_id() AND app_can_see_facility(facility_id))
  WITH CHECK (tenant_id = app_tenant_id() AND app_can_see_facility(facility_id));
ALTER TABLE time_entry ENABLE ROW LEVEL SECURITY;
CREATE POLICY via_parent ON time_entry
  USING (tenant_id = app_tenant_id() AND EXISTS (SELECT 1 FROM timesheet t WHERE t.id = timesheet_id))
  WITH CHECK (tenant_id = app_tenant_id() AND EXISTS (SELECT 1 FROM timesheet t WHERE t.id = timesheet_id));
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['earning_code', 'payroll_export']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id())', t);
  END LOOP;
END $$;

GRANT SELECT, INSERT, UPDATE ON timesheet, earning_code TO erp_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON time_entry TO erp_app;
GRANT SELECT, INSERT ON payroll_export TO erp_app;

-- Roles, permissions and default earning codes for existing tenants (new tenants get them at provisioning).
INSERT INTO role (tenant_id, key, name, permissions)
SELECT t.id, 'payroll_admin', 'Payroll Administrator', ARRAY['org.view', 'employees.view', 'reports.view', 'reports.export', 'time.view_all', 'time.export']
FROM tenant t WHERE NOT EXISTS (SELECT 1 FROM role x WHERE x.tenant_id = t.id AND x.key = 'payroll_admin');
UPDATE role SET permissions = (SELECT array_agg(DISTINCT p) FROM unnest(permissions || ARRAY['time.approve', 'time.view_all', 'time.export']) p) WHERE key = 'admin';
UPDATE role SET permissions = (SELECT array_agg(DISTINCT p) FROM unnest(permissions || ARRAY['time.approve']) p) WHERE key IN ('maintenance_manager', 'operations_manager');

INSERT INTO earning_code (tenant_id, code, label, kind)
SELECT t.id, c.code, c.label, c.kind FROM tenant t CROSS JOIN (VALUES
  ('REG', 'Regular hours', 'worked'), ('OT', 'Overtime hours', 'worked'), ('PTO', 'Paid time off', 'paid_leave'),
  ('HOL', 'Holiday', 'paid_leave'), ('SICK', 'Sick leave', 'paid_leave'), ('UNPAID', 'Unpaid leave', 'unpaid')
) AS c(code, label, kind)
ON CONFLICT DO NOTHING;
