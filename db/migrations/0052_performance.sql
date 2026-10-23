-- S26 Performance reviews (D-155). Each employee is reviewed by their manager at a frequency the company sets, with
-- check-ins in between and goals carried from one review to the next. Reviews are HR-sensitive (D-010): only the
-- employee, their reviewer and people with performance.manage see them; the application enforces this on top of RLS.

-- Who an employee reports to (also imported from payroll exports as the manager's employee number).
ALTER TABLE employee ADD COLUMN manager_employee_id uuid REFERENCES employee(id);
ALTER TABLE employee ADD CONSTRAINT employee_not_own_manager CHECK (manager_employee_id IS DISTINCT FROM id);

-- One row per company; no row means performance reviews are not set up yet.
CREATE TABLE performance_settings (
  tenant_id             uuid PRIMARY KEY REFERENCES tenant(id),
  enabled               boolean NOT NULL DEFAULT true,
  interval_months       integer NOT NULL DEFAULT 12 CHECK (interval_months BETWEEN 1 AND 36),
  anchor                text NOT NULL DEFAULT 'calendar' CHECK (anchor IN ('calendar', 'hire_date')),
  calendar_month        integer NOT NULL DEFAULT 1 CHECK (calendar_month BETWEEN 1 AND 12),  -- first review month in the year (calendar anchor)
  first_review_months   integer NOT NULL DEFAULT 3 CHECK (first_review_months BETWEEN 1 AND 24),  -- after hire, before joining the cycle
  checkin_months        integer NOT NULL DEFAULT 3 CHECK (checkin_months BETWEEN 0 AND 12),     -- 0: no check-ins
  self_assessment       boolean NOT NULL DEFAULT true,
  open_days_before      integer NOT NULL DEFAULT 21 CHECK (open_days_before BETWEEN 0 AND 90),  -- a review opens this many days before it is due
  updated_by            uuid REFERENCES app_user(id),
  updated_at            timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE performance_settings ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON performance_settings USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());
GRANT SELECT, INSERT, UPDATE ON performance_settings TO erp_app;

CREATE TABLE performance_review (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid NOT NULL REFERENCES tenant(id),
  facility_id        uuid REFERENCES facility(id),
  employee_id        uuid NOT NULL REFERENCES employee(id),
  reviewer_user_id   uuid REFERENCES app_user(id),
  kind               text NOT NULL CHECK (kind IN ('review', 'check_in')),
  period_start       date NOT NULL,
  due_on             date NOT NULL,
  status             text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'shared', 'completed', 'cancelled')),
  self_assessment    text,
  self_submitted_at  timestamptz,
  rating             integer CHECK (rating BETWEEN 1 AND 5),
  strengths          text,
  development        text,
  summary            text,
  shared_at          timestamptz,
  employee_comment   text,
  acknowledged_at    timestamptz,
  completed_at       timestamptz,
  cancelled_reason   text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (employee_id, kind, due_on),
  CHECK (kind = 'check_in' OR status IN ('open', 'cancelled') OR rating IS NOT NULL),
  CHECK (status <> 'completed' OR completed_at IS NOT NULL)
);
CREATE INDEX performance_review_open ON performance_review (tenant_id, status, due_on);
ALTER TABLE performance_review ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON performance_review USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());
GRANT SELECT, INSERT, UPDATE ON performance_review TO erp_app;

CREATE TABLE performance_goal (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenant(id),
  employee_id    uuid NOT NULL REFERENCES employee(id),
  set_in_review  uuid REFERENCES performance_review(id),
  title          text NOT NULL,
  measure        text,
  due_on         date,
  status         text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'met', 'partly_met', 'not_met', 'dropped')),
  progress_note  text,
  closed_in_review uuid REFERENCES performance_review(id),
  created_by     uuid NOT NULL REFERENCES app_user(id),
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE performance_goal ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON performance_goal USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());
GRANT SELECT, INSERT, UPDATE ON performance_goal TO erp_app;

-- HR runs the programme; administrators hold every permission.
UPDATE role SET permissions = (SELECT array_agg(DISTINCT p) FROM unnest(permissions || ARRAY['performance.manage']) p) WHERE key IN ('admin', 'hr_manager');
