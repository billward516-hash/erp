-- SC-009 P3 staffing and utilization (D-188C): working patterns, company holidays, time-off requests, assignments of people
-- to projects, utilization targets and the company's staffing settings. Reads project (0160) and time_entry/timesheet; the
-- technician time off of field service (0080) is reused as approved full days off.

-- One row per company: the pattern a person follows when they have none of their own, and the thresholds the views use.
CREATE TABLE staffing_settings (
  tenant_id             uuid PRIMARY KEY REFERENCES tenant(id),
  default_hours         numeric(4, 2)[] NOT NULL DEFAULT '{8,8,8,8,8,0,0}' CHECK (array_length(default_hours, 1) = 7),   -- Monday to Sunday
  target_pct            numeric(5, 2) NOT NULL DEFAULT 75 CHECK (target_pct BETWEEN 0 AND 100),                          -- company utilization target
  bench_pct             numeric(5, 2) NOT NULL DEFAULT 50 CHECK (bench_pct BETWEEN 0 AND 100),                           -- booked below this share of capacity = bench
  overbook_tolerance_h  numeric(4, 2) NOT NULL DEFAULT 0.5 CHECK (overbook_tolerance_h BETWEEN 0 AND 20),                -- hours over capacity ignored per week
  updated_by            uuid NOT NULL REFERENCES app_user(id),
  updated_at            timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX staffing_settings_updated_by ON staffing_settings (updated_by);
ALTER TABLE staffing_settings ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_only ON staffing_settings USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());
GRANT SELECT, INSERT, UPDATE ON staffing_settings TO erp_app;

-- A person's own hours per weekday (Monday first), from a date until their next pattern starts.
CREATE TABLE work_pattern (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenant(id),
  facility_id     uuid NOT NULL REFERENCES facility(id),
  employee_id     uuid NOT NULL REFERENCES employee(id),
  effective_from  date NOT NULL,
  hours           numeric(4, 2)[] NOT NULL CHECK (array_length(hours, 1) = 7),
  note            text,
  created_by      uuid NOT NULL REFERENCES app_user(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (employee_id, effective_from)
);
CREATE INDEX work_pattern_tenant ON work_pattern (tenant_id);
CREATE INDEX work_pattern_facility ON work_pattern (facility_id);
CREATE INDEX work_pattern_created_by ON work_pattern (created_by);
ALTER TABLE work_pattern ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_facility ON work_pattern USING (tenant_id = app_tenant_id() AND app_can_see_facility(facility_id)) WITH CHECK (tenant_id = app_tenant_id() AND app_can_see_facility(facility_id));
GRANT SELECT, INSERT, UPDATE, DELETE ON work_pattern TO erp_app;

-- Company holidays. No site: every site. hours_off null: the whole scheduled day.
CREATE TABLE company_holiday (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenant(id),
  facility_id   uuid REFERENCES facility(id),
  holiday_date  date NOT NULL,
  name          text NOT NULL,
  hours_off     numeric(4, 2) CHECK (hours_off IS NULL OR (hours_off > 0 AND hours_off <= 24)),
  created_by    uuid NOT NULL REFERENCES app_user(id),
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX company_holiday_day ON company_holiday (tenant_id, coalesce(facility_id, '00000000-0000-0000-0000-000000000000'::uuid), holiday_date);
CREATE INDEX company_holiday_facility ON company_holiday (facility_id);
CREATE INDEX company_holiday_created_by ON company_holiday (created_by);
ALTER TABLE company_holiday ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_facility ON company_holiday USING (tenant_id = app_tenant_id() AND (facility_id IS NULL OR app_can_see_facility(facility_id))) WITH CHECK (tenant_id = app_tenant_id() AND (facility_id IS NULL OR app_can_see_facility(facility_id)));
GRANT SELECT, INSERT, UPDATE, DELETE ON company_holiday TO erp_app;

-- Personal time off: asked for by the person (or entered by a manager), approved by someone else with the manage permission.
CREATE TABLE employee_time_off (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES tenant(id),
  facility_id       uuid NOT NULL REFERENCES facility(id),
  employee_id       uuid NOT NULL REFERENCES employee(id),
  from_date         date NOT NULL,
  to_date           date NOT NULL,
  hours_per_day     numeric(4, 2) CHECK (hours_per_day IS NULL OR (hours_per_day > 0 AND hours_per_day <= 24)),   -- null: the whole scheduled day
  kind              text NOT NULL DEFAULT 'vacation' CHECK (kind IN ('vacation', 'sick', 'personal', 'training', 'other')),
  status            text NOT NULL DEFAULT 'requested' CHECK (status IN ('requested', 'approved', 'rejected', 'cancelled')),
  note              text,
  requested_by      uuid NOT NULL REFERENCES app_user(id),
  decided_by        uuid REFERENCES app_user(id),
  decided_at        timestamptz,
  decision_comment  text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  CHECK (to_date >= from_date)
);
CREATE INDEX employee_time_off_employee ON employee_time_off (employee_id, from_date);
CREATE INDEX employee_time_off_tenant ON employee_time_off (tenant_id);
CREATE INDEX employee_time_off_facility ON employee_time_off (facility_id);
CREATE INDEX employee_time_off_requested_by ON employee_time_off (requested_by);
CREATE INDEX employee_time_off_decided_by ON employee_time_off (decided_by) WHERE decided_by IS NOT NULL;
ALTER TABLE employee_time_off ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_facility ON employee_time_off USING (tenant_id = app_tenant_id() AND app_can_see_facility(facility_id)) WITH CHECK (tenant_id = app_tenant_id() AND app_can_see_facility(facility_id));
GRANT SELECT, INSERT, UPDATE ON employee_time_off TO erp_app;

-- A person planned onto a project for some hours a week over a date range. facility_id is the person's home site.
-- Removing sets removed_at (the row and its audit history stay).
CREATE TABLE project_assignment (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenant(id),
  facility_id      uuid NOT NULL REFERENCES facility(id),
  project_id       uuid NOT NULL REFERENCES project(id),
  employee_id      uuid NOT NULL REFERENCES employee(id),
  role             text,
  hours_per_week   numeric(5, 2) NOT NULL CHECK (hours_per_week > 0 AND hours_per_week <= 168),
  start_date       date NOT NULL,
  end_date         date NOT NULL,
  billable         boolean NOT NULL DEFAULT true,
  state            text NOT NULL DEFAULT 'tentative' CHECK (state IN ('tentative', 'confirmed')),
  override_reason  text,                                    -- why it was saved although it overbooks the person
  note             text,
  removed_at       timestamptz,
  removed_by       uuid REFERENCES app_user(id),
  created_by       uuid NOT NULL REFERENCES app_user(id),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CHECK (end_date >= start_date)
);
CREATE INDEX project_assignment_tenant ON project_assignment (tenant_id);
CREATE INDEX project_assignment_facility ON project_assignment (facility_id);
CREATE INDEX project_assignment_project ON project_assignment (project_id);
CREATE INDEX project_assignment_employee ON project_assignment (employee_id, start_date);
CREATE INDEX project_assignment_created_by ON project_assignment (created_by);
CREATE INDEX project_assignment_removed_by ON project_assignment (removed_by) WHERE removed_by IS NOT NULL;
CREATE TRIGGER project_assignment_touch BEFORE UPDATE ON project_assignment FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
ALTER TABLE project_assignment ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_facility ON project_assignment USING (tenant_id = app_tenant_id() AND app_can_see_facility(facility_id)) WITH CHECK (tenant_id = app_tenant_id() AND app_can_see_facility(facility_id));
GRANT SELECT, INSERT, UPDATE ON project_assignment TO erp_app;

-- Utilization targets (percent of available hours that should be billable): one per person or per job title.
-- Resolution: the person's own, then their job title's, then the company's (staffing_settings.target_pct).
CREATE TABLE utilization_target (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenant(id),
  kind         text NOT NULL CHECK (kind IN ('employee', 'job_title')),
  employee_id  uuid REFERENCES employee(id),
  job_title    text,
  target_pct   numeric(5, 2) NOT NULL CHECK (target_pct BETWEEN 0 AND 100),
  updated_by   uuid NOT NULL REFERENCES app_user(id),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  CHECK ((kind = 'employee' AND employee_id IS NOT NULL AND job_title IS NULL) OR (kind = 'job_title' AND job_title IS NOT NULL AND employee_id IS NULL))
);
CREATE UNIQUE INDEX utilization_target_employee ON utilization_target (employee_id) WHERE kind = 'employee';
CREATE UNIQUE INDEX utilization_target_title ON utilization_target (tenant_id, lower(job_title)) WHERE kind = 'job_title';
CREATE INDEX utilization_target_tenant ON utilization_target (tenant_id);
CREATE INDEX utilization_target_updated_by ON utilization_target (updated_by);
ALTER TABLE utilization_target ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_only ON utilization_target USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());
GRANT SELECT, INSERT, UPDATE, DELETE ON utilization_target TO erp_app;

-- People who are not staffed on projects (office staff, owners): left out of utilization, the bench report, the forecast and reminders.
CREATE TABLE staffing_exclusion (
  employee_id  uuid PRIMARY KEY REFERENCES employee(id),
  tenant_id    uuid NOT NULL REFERENCES tenant(id),
  facility_id  uuid NOT NULL REFERENCES facility(id),
  reason       text,
  created_by   uuid NOT NULL REFERENCES app_user(id),
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX staffing_exclusion_tenant ON staffing_exclusion (tenant_id);
CREATE INDEX staffing_exclusion_facility ON staffing_exclusion (facility_id);
CREATE INDEX staffing_exclusion_created_by ON staffing_exclusion (created_by);
ALTER TABLE staffing_exclusion ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_facility ON staffing_exclusion USING (tenant_id = app_tenant_id() AND app_can_see_facility(facility_id)) WITH CHECK (tenant_id = app_tenant_id() AND app_can_see_facility(facility_id));
GRANT SELECT, INSERT, UPDATE, DELETE ON staffing_exclusion TO erp_app;

-- Permissions: everyone sees their own staffing; operations and HR see the teams at their sites; operations and HR manage.
UPDATE role SET permissions = (SELECT array_agg(DISTINCT p) FROM unnest(permissions || ARRAY['staffing.view_own']) p);
UPDATE role SET permissions = (SELECT array_agg(DISTINCT p) FROM unnest(permissions || ARRAY['staffing.view_team']) p) WHERE key IN ('admin', 'operations_manager', 'hr_manager', 'executive', 'district_manager');
UPDATE role SET permissions = (SELECT array_agg(DISTINCT p) FROM unnest(permissions || ARRAY['staffing.manage']) p) WHERE key IN ('admin', 'operations_manager', 'hr_manager');
