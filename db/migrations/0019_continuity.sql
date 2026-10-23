-- 0019 Business continuity plans for critical processes. Built on the existing primitives: revisions with the
-- approvals engine (document-control style), the shared action tracker for corrective actions from exercises,
-- attachments for test evidence, and references to assets, suppliers, qualifications and employees so the plan
-- can be checked against live records (is the machine down now, how many people still hold the skill).
-- Out of scope (brief §12.6): crisis command centres, disaster simulation, regulatory interpretation, GRC.

CREATE TABLE continuity_plan (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                 uuid NOT NULL REFERENCES tenant(id),
  facility_id               uuid NOT NULL REFERENCES facility(id),
  number                    text NOT NULL,                 -- shared by all revisions of one plan
  revision                  integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  process                   text NOT NULL,                 -- the critical process or function the plan protects
  title                     text NOT NULL,
  description               text,
  criticality               text NOT NULL DEFAULT 'high' CHECK (criticality IN ('critical', 'high', 'medium')),
  rto_hours                 numeric(8, 1) NOT NULL CHECK (rto_hours > 0),   -- recovery time objective
  rpo_hours                 numeric(8, 1) CHECK (rpo_hours >= 0),           -- recovery point objective (data/records), where it applies
  owner_user_id             uuid NOT NULL REFERENCES app_user(id),
  alternate_user_id         uuid REFERENCES app_user(id),
  review_interval_months    integer NOT NULL DEFAULT 12 CHECK (review_interval_months BETWEEN 1 AND 60),
  exercise_interval_months  integer NOT NULL DEFAULT 12 CHECK (exercise_interval_months BETWEEN 1 AND 60),
  status                    text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'in_review', 'approved', 'superseded')),
  revision_reason           text,
  review_due                date,
  last_reviewed_at          timestamptz,
  last_review_note          text,
  approved_at               timestamptz,
  created_by                uuid NOT NULL REFERENCES app_user(id),
  created_at                timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, number, revision),
  CHECK (alternate_user_id IS NULL OR alternate_user_id <> owner_user_id)
);
CREATE UNIQUE INDEX continuity_one_open_revision ON continuity_plan (tenant_id, number) WHERE status IN ('draft', 'in_review');

-- What the process depends on. Typed references are checked live; 'other' covers utilities, IT services, buildings.
CREATE TABLE continuity_dependency (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES tenant(id),
  plan_id           uuid NOT NULL REFERENCES continuity_plan(id),
  seq               integer NOT NULL,
  kind              text NOT NULL CHECK (kind IN ('asset', 'supplier', 'skill', 'person', 'other')),
  asset_id          uuid REFERENCES asset(id),
  supplier_id       uuid REFERENCES supplier(id),
  qualification_id  uuid REFERENCES qualification(id),
  employee_id       uuid REFERENCES employee(id),
  description       text NOT NULL,
  workaround        text,                                 -- what we do without it (spare machine, second source, cover)
  min_holders       integer CHECK (min_holders > 0),      -- skill: how many current holders the plan needs
  UNIQUE (plan_id, seq),
  CHECK ((kind = 'asset') = (asset_id IS NOT NULL)),
  CHECK ((kind = 'supplier') = (supplier_id IS NOT NULL)),
  CHECK ((kind = 'skill') = (qualification_id IS NOT NULL)),
  CHECK ((kind = 'person') = (employee_id IS NOT NULL))
);

-- Disruption scenarios and how the process is recovered from each.
CREATE TABLE continuity_scenario (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id              uuid NOT NULL REFERENCES tenant(id),
  plan_id                uuid NOT NULL REFERENCES continuity_plan(id),
  seq                    integer NOT NULL,
  scenario               text NOT NULL,                  -- e.g. loss of the press line, key supplier fails, site inaccessible
  impact                 text,
  recovery_steps         text NOT NULL,
  recovery_owner_user_id uuid NOT NULL REFERENCES app_user(id),
  est_recovery_hours     numeric(8, 1) CHECK (est_recovery_hours > 0),
  document_id            uuid REFERENCES document(id),   -- the controlled recovery procedure, when there is one
  UNIQUE (plan_id, seq)
);

-- Call list. Contacts change more often than plans, so they stay editable on the approved revision (audited).
CREATE TABLE continuity_contact (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenant(id),
  plan_id      uuid NOT NULL REFERENCES continuity_plan(id),
  seq          integer NOT NULL,
  name         text NOT NULL,
  role         text NOT NULL,                             -- e.g. plan owner, OEM service desk, utility outage line
  phone        text,
  email        text,
  user_id      uuid REFERENCES app_user(id),
  supplier_id  uuid REFERENCES supplier(id),
  UNIQUE (plan_id, seq),
  CHECK (phone IS NOT NULL OR email IS NOT NULL)
);

-- Exercises (tabletop through full test). Results are immutable once recorded; findings become actions.
CREATE TABLE continuity_exercise (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                uuid NOT NULL REFERENCES tenant(id),
  facility_id              uuid NOT NULL REFERENCES facility(id),
  plan_id                  uuid NOT NULL REFERENCES continuity_plan(id),  -- the revision exercised
  scenario_id              uuid REFERENCES continuity_scenario(id),
  kind                     text NOT NULL CHECK (kind IN ('tabletop', 'walkthrough', 'simulation', 'full_test')),
  scheduled_on             date NOT NULL,
  facilitator_user_id      uuid NOT NULL REFERENCES app_user(id),
  status                   text NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled', 'completed', 'cancelled')),
  conducted_on             date,
  participants             text,
  achieved_recovery_hours  numeric(8, 1) CHECK (achieved_recovery_hours > 0),
  outcome                  text CHECK (outcome IN ('met', 'partly_met', 'not_met')),
  findings                 text,
  cancel_reason            text,
  recorded_by              uuid REFERENCES app_user(id),
  created_at               timestamptz NOT NULL DEFAULT now(),
  CHECK ((status = 'completed') = (outcome IS NOT NULL AND conducted_on IS NOT NULL))
);

CREATE FUNCTION continuity_frozen() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE st text := (SELECT status FROM continuity_plan WHERE id = coalesce(NEW.plan_id, OLD.plan_id));
BEGIN
  IF st = 'draft' THEN RETURN coalesce(NEW, OLD); END IF;
  IF TG_TABLE_NAME = 'continuity_contact' AND st = 'approved' THEN RETURN coalesce(NEW, OLD); END IF;
  RAISE EXCEPTION 'this revision of the continuity plan cannot change; start a new revision';
END $$;
CREATE TRIGGER continuity_dependency_frozen BEFORE INSERT OR UPDATE OR DELETE ON continuity_dependency FOR EACH ROW EXECUTE FUNCTION continuity_frozen();
CREATE TRIGGER continuity_scenario_frozen BEFORE INSERT OR UPDATE OR DELETE ON continuity_scenario FOR EACH ROW EXECUTE FUNCTION continuity_frozen();
CREATE TRIGGER continuity_contact_frozen BEFORE INSERT OR UPDATE OR DELETE ON continuity_contact FOR EACH ROW EXECUTE FUNCTION continuity_frozen();

CREATE FUNCTION continuity_exercise_final() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'exercises cannot be deleted; cancel instead'; END IF;
  IF OLD.status <> 'scheduled' THEN RAISE EXCEPTION 'recorded exercises are final'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER continuity_exercise_final BEFORE UPDATE OR DELETE ON continuity_exercise FOR EACH ROW EXECUTE FUNCTION continuity_exercise_final();

ALTER TABLE action_item DROP CONSTRAINT action_item_subject_type_check;
ALTER TABLE action_item ADD CONSTRAINT action_item_subject_type_check CHECK (subject_type IN ('corrective_action', 'safety_incident', 'quality_audit', 'fmea', 'continuity_plan'));
ALTER TABLE action_item ADD COLUMN continuity_exercise_id uuid REFERENCES continuity_exercise(id);
ALTER TABLE attachment DROP CONSTRAINT attachment_subject_type_check;
ALTER TABLE attachment ADD CONSTRAINT attachment_subject_type_check CHECK (subject_type IN ('nonconformance', 'corrective_action', 'safety_incident', 'calibration_record', 'quality_audit', 'fmea',
  'continuity_plan', 'continuity_exercise'));

ALTER TABLE continuity_plan ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_facility ON continuity_plan USING (tenant_id = app_tenant_id() AND app_can_see_facility(facility_id)) WITH CHECK (tenant_id = app_tenant_id() AND app_can_see_facility(facility_id));
ALTER TABLE continuity_exercise ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_facility ON continuity_exercise USING (tenant_id = app_tenant_id() AND app_can_see_facility(facility_id)) WITH CHECK (tenant_id = app_tenant_id() AND app_can_see_facility(facility_id));
ALTER TABLE continuity_dependency ENABLE ROW LEVEL SECURITY;
CREATE POLICY via_parent ON continuity_dependency USING (tenant_id = app_tenant_id() AND EXISTS (SELECT 1 FROM continuity_plan p WHERE p.id = plan_id))
  WITH CHECK (tenant_id = app_tenant_id() AND EXISTS (SELECT 1 FROM continuity_plan p WHERE p.id = plan_id));
ALTER TABLE continuity_scenario ENABLE ROW LEVEL SECURITY;
CREATE POLICY via_parent ON continuity_scenario USING (tenant_id = app_tenant_id() AND EXISTS (SELECT 1 FROM continuity_plan p WHERE p.id = plan_id))
  WITH CHECK (tenant_id = app_tenant_id() AND EXISTS (SELECT 1 FROM continuity_plan p WHERE p.id = plan_id));
ALTER TABLE continuity_contact ENABLE ROW LEVEL SECURITY;
CREATE POLICY via_parent ON continuity_contact USING (tenant_id = app_tenant_id() AND EXISTS (SELECT 1 FROM continuity_plan p WHERE p.id = plan_id))
  WITH CHECK (tenant_id = app_tenant_id() AND EXISTS (SELECT 1 FROM continuity_plan p WHERE p.id = plan_id));
GRANT SELECT, INSERT, UPDATE ON continuity_plan, continuity_exercise TO erp_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON continuity_dependency, continuity_scenario, continuity_contact TO erp_app;

-- Permissions on stock roles of existing tenants (new tenants get them from the role templates).
UPDATE role SET permissions = (SELECT array_agg(DISTINCT p) FROM unnest(permissions || ARRAY['continuity.view', 'continuity.manage']) p) WHERE key IN ('admin', 'operations_manager', 'ehs_reviewer');
UPDATE role SET permissions = (SELECT array_agg(DISTINCT p) FROM unnest(permissions || ARRAY['continuity.view']) p)
  WHERE key IN ('maintenance_manager', 'quality_manager', 'production_supervisor', 'executive', 'buyer');
