-- 0004 Internal LMS and qualifications (brief §12.3).
-- Distinct, separately recorded states — none implies the next:
--   training completed   -> enrollment.status = 'completed' (every learning event done)
--   assessment passed    -> assessment_attempt.passed
--   competency verified  -> event_completion of a practical_evaluation, signed by an evaluator
--   qualification authorized -> employee_qualification granted by a person holding qualifications.grant
--   certification issued -> certificate row (internal document, no external accreditation implied)
-- Course content references the SAME controlled documents used by assets and work orders.

-- ---------------------------------------------------------------------------
-- Catalog
-- ---------------------------------------------------------------------------
CREATE TABLE course (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenant(id),
  facility_id    uuid REFERENCES facility(id),                 -- NULL = offered at every facility
  code           text NOT NULL,
  title          text NOT NULL,
  description    text,
  owner_user_id  uuid REFERENCES app_user(id),
  active         boolean NOT NULL DEFAULT true,
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, code)
);

CREATE TABLE course_version (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenant(id),
  course_id       uuid NOT NULL REFERENCES course(id),
  version_no      integer NOT NULL,
  status          text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'retired')),
  objectives      text,
  review_due_on   date,
  change_summary  text,
  created_by      uuid REFERENCES app_user(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  published_by    uuid REFERENCES app_user(id),
  published_at    timestamptz,
  UNIQUE (course_id, version_no)
);

-- One course version may mix several event kinds.
CREATE TABLE learning_event (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            uuid NOT NULL REFERENCES tenant(id),
  course_version_id    uuid NOT NULL REFERENCES course_version(id),
  seq                  integer NOT NULL,
  kind                 text NOT NULL CHECK (kind IN ('video', 'instructor_led', 'self_study', 'ojt_shadowing',
                                                     'practical_evaluation', 'assessment')),
  title                text NOT NULL,
  instructions         text,
  document_id          uuid REFERENCES document(id),          -- controlled source content (video, SOP, procedure)
  duration_minutes     integer CHECK (duration_minutes > 0),
  -- who may record completion: the learner (video/self-study), an instructor/trainer, or an evaluator
  completion_by        text NOT NULL CHECK (completion_by IN ('learner', 'instructor', 'evaluator', 'system')),
  UNIQUE (course_version_id, seq)
);

CREATE TABLE assessment (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid NOT NULL REFERENCES tenant(id),
  learning_event_id  uuid NOT NULL UNIQUE REFERENCES learning_event(id),
  passing_score      numeric(5, 2) NOT NULL CHECK (passing_score BETWEEN 0 AND 100),
  max_attempts       integer NOT NULL DEFAULT 3 CHECK (max_attempts > 0),
  -- [{id, prompt, type: single|multi|true_false, options: [..], answer: [..], points}] — answers never sent to learners
  questions          jsonb NOT NULL
);

-- Published versions are frozen; only retirement is allowed afterwards.
CREATE FUNCTION course_version_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status <> 'draft' THEN
    IF NOT (NEW.status = OLD.status OR (OLD.status = 'published' AND NEW.status = 'retired')) THEN
      RAISE EXCEPTION 'invalid course version transition % -> %', OLD.status, NEW.status;
    END IF;
    IF NEW.objectives IS DISTINCT FROM OLD.objectives OR NEW.version_no <> OLD.version_no OR NEW.course_id <> OLD.course_id THEN
      RAISE EXCEPTION 'published course versions are immutable';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER course_version_guard BEFORE UPDATE ON course_version FOR EACH ROW EXECUTE FUNCTION course_version_guard();

CREATE FUNCTION assert_course_version_draft(p_version uuid) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF (SELECT status FROM course_version WHERE id = p_version) <> 'draft' THEN
    RAISE EXCEPTION 'content of a published course version is immutable';
  END IF;
END $$;
CREATE FUNCTION learning_event_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN PERFORM assert_course_version_draft(OLD.course_version_id); END IF;
  IF TG_OP <> 'DELETE' THEN PERFORM assert_course_version_draft(NEW.course_version_id); END IF;
  RETURN coalesce(NEW, OLD);
END $$;
CREATE FUNCTION assessment_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN PERFORM assert_course_version_draft((SELECT course_version_id FROM learning_event WHERE id = OLD.learning_event_id)); END IF;
  IF TG_OP <> 'DELETE' THEN PERFORM assert_course_version_draft((SELECT course_version_id FROM learning_event WHERE id = NEW.learning_event_id)); END IF;
  RETURN coalesce(NEW, OLD);
END $$;
CREATE TRIGGER learning_event_guard BEFORE INSERT OR UPDATE OR DELETE ON learning_event FOR EACH ROW EXECUTE FUNCTION learning_event_guard();
CREATE TRIGGER assessment_guard BEFORE INSERT OR UPDATE OR DELETE ON assessment FOR EACH ROW EXECUTE FUNCTION assessment_guard();

-- ---------------------------------------------------------------------------
-- Enrollment, completion, assessment attempts, evidence
-- ---------------------------------------------------------------------------
CREATE TABLE enrollment (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid NOT NULL REFERENCES tenant(id),
  course_version_id  uuid NOT NULL REFERENCES course_version(id),
  employee_id        uuid NOT NULL REFERENCES employee(id),
  source             text NOT NULL DEFAULT 'individual'
                       CHECK (source IN ('individual', 'job_title', 'facility', 'qualification', 'retraining', 'import')),
  assigned_by        uuid REFERENCES app_user(id),
  assigned_at        timestamptz NOT NULL DEFAULT now(),
  due_on             date,
  status             text NOT NULL DEFAULT 'assigned' CHECK (status IN ('assigned', 'in_progress', 'completed', 'cancelled')),
  completed_at       timestamptz
);
CREATE UNIQUE INDEX enrollment_one_active ON enrollment (course_version_id, employee_id) WHERE status <> 'cancelled';

CREATE TABLE event_completion (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid NOT NULL REFERENCES tenant(id),
  enrollment_id      uuid NOT NULL REFERENCES enrollment(id),
  learning_event_id  uuid NOT NULL REFERENCES learning_event(id),
  outcome            text NOT NULL CHECK (outcome IN ('completed', 'attended', 'passed', 'not_yet_competent')),
  completed_at       timestamptz NOT NULL DEFAULT now(),
  recorded_by        uuid NOT NULL REFERENCES app_user(id),
  attestation        text,                                   -- evaluator / instructor statement
  document_version_id uuid REFERENCES document_version(id),  -- exact content version trained on
  UNIQUE (enrollment_id, learning_event_id, completed_at)
);

CREATE TABLE assessment_attempt (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenant(id),
  enrollment_id  uuid NOT NULL REFERENCES enrollment(id),
  assessment_id  uuid NOT NULL REFERENCES assessment(id),
  attempt_no     integer NOT NULL,
  responses      jsonb NOT NULL,
  score          numeric(5, 2) NOT NULL,
  passed         boolean NOT NULL,
  submitted_at   timestamptz NOT NULL DEFAULT now(),
  submitted_by   uuid NOT NULL REFERENCES app_user(id),
  UNIQUE (enrollment_id, assessment_id, attempt_no)
);

CREATE TABLE training_evidence (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            uuid NOT NULL REFERENCES tenant(id),
  enrollment_id        uuid NOT NULL REFERENCES enrollment(id),
  event_completion_id  uuid REFERENCES event_completion(id),
  storage_key          text NOT NULL,
  file_name            text NOT NULL,
  mime_type            text NOT NULL,
  size_bytes           bigint NOT NULL,
  sha256               text NOT NULL,
  uploaded_by          uuid NOT NULL REFERENCES app_user(id),
  uploaded_at          timestamptz NOT NULL DEFAULT now()
);

-- Training records are evidence: append-only for the runtime role (corrections are new rows).
CREATE FUNCTION training_record_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% records are append-only', TG_TABLE_NAME;
END $$;
CREATE TRIGGER event_completion_immutable BEFORE UPDATE OR DELETE ON event_completion FOR EACH ROW EXECUTE FUNCTION training_record_immutable();
CREATE TRIGGER assessment_attempt_immutable BEFORE UPDATE OR DELETE ON assessment_attempt FOR EACH ROW EXECUTE FUNCTION training_record_immutable();
CREATE TRIGGER training_evidence_immutable BEFORE UPDATE OR DELETE ON training_evidence FOR EACH ROW EXECUTE FUNCTION training_record_immutable();

-- ---------------------------------------------------------------------------
-- Qualifications and certifications
-- ---------------------------------------------------------------------------
CREATE TABLE qualification (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid NOT NULL REFERENCES tenant(id),
  code               text NOT NULL,
  name               text NOT NULL,
  description        text,
  validity_months    integer CHECK (validity_months > 0),     -- NULL = does not expire
  safety_critical    boolean NOT NULL DEFAULT false,
  requires_practical boolean NOT NULL DEFAULT false,          -- a signed practical evaluation must be on record
  active             boolean NOT NULL DEFAULT true,
  UNIQUE (tenant_id, code)
);

-- Courses whose completion is a prerequisite for granting (any published version of the course).
CREATE TABLE qualification_course (
  tenant_id         uuid NOT NULL REFERENCES tenant(id),
  qualification_id  uuid NOT NULL REFERENCES qualification(id),
  course_id         uuid NOT NULL REFERENCES course(id),
  PRIMARY KEY (qualification_id, course_id)
);

-- Grants are never edited away: revocation and expiry are recorded, renewals are new rows.
CREATE TABLE employee_qualification (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES tenant(id),
  employee_id       uuid NOT NULL REFERENCES employee(id),
  qualification_id  uuid NOT NULL REFERENCES qualification(id),
  granted_at        timestamptz NOT NULL DEFAULT now(),
  granted_by        uuid NOT NULL REFERENCES app_user(id),
  effective_on      date NOT NULL DEFAULT current_date,
  expires_on        date,
  basis             jsonb NOT NULL DEFAULT '{}',              -- enrollments, attempts, evaluations, or legacy source
  origin            text NOT NULL DEFAULT 'native' CHECK (origin IN ('native', 'import')),
  revoked_at        timestamptz,
  revoked_by        uuid REFERENCES app_user(id),
  revoke_reason     text,
  CHECK ((revoked_at IS NULL) = (revoked_by IS NULL))
);
CREATE INDEX employee_qualification_lookup ON employee_qualification (employee_id, qualification_id);

CREATE FUNCTION employee_qualification_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'qualification grants cannot be deleted; revoke instead'; END IF;
  IF OLD.revoked_at IS NOT NULL THEN RAISE EXCEPTION 'revoked grants are final'; END IF;
  IF NEW.employee_id <> OLD.employee_id OR NEW.qualification_id <> OLD.qualification_id OR NEW.granted_at <> OLD.granted_at
     OR NEW.granted_by <> OLD.granted_by OR NEW.expires_on IS DISTINCT FROM OLD.expires_on OR NEW.basis <> OLD.basis THEN
    RAISE EXCEPTION 'grant details are immutable; only revocation may be recorded';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER employee_qualification_guard BEFORE UPDATE OR DELETE ON employee_qualification
  FOR EACH ROW EXECUTE FUNCTION employee_qualification_guard();

CREATE TABLE certificate (
  id                         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                  uuid NOT NULL REFERENCES tenant(id),
  employee_qualification_id  uuid NOT NULL UNIQUE REFERENCES employee_qualification(id),
  number                     text NOT NULL,
  issued_at                  timestamptz NOT NULL DEFAULT now(),
  issued_by                  uuid NOT NULL REFERENCES app_user(id),
  UNIQUE (tenant_id, number)
);

-- Credentials issued by outside bodies (forklift, NFPA 70E, OEM schools). Recorded, never claimed as ours.
CREATE TABLE external_credential (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenant(id),
  employee_id   uuid NOT NULL REFERENCES employee(id),
  name          text NOT NULL,
  issuer        text NOT NULL,
  credential_no text,
  issued_on     date,
  expires_on    date,
  recorded_by   uuid NOT NULL REFERENCES app_user(id),
  recorded_at   timestamptz NOT NULL DEFAULT now()
);

-- What a person must hold to operate or maintain a given asset.
CREATE TABLE asset_qualification_requirement (
  tenant_id         uuid NOT NULL REFERENCES tenant(id),
  asset_id          uuid NOT NULL REFERENCES asset(id),
  qualification_id  uuid NOT NULL REFERENCES qualification(id),
  scope             text NOT NULL CHECK (scope IN ('operate', 'maintain')),
  PRIMARY KEY (asset_id, qualification_id, scope)
);

-- Raised when a controlled document used by a published course gets a new approved version.
-- A person decides whether retraining is needed; nothing is reassigned automatically.
CREATE TABLE training_review (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             uuid NOT NULL REFERENCES tenant(id),
  course_version_id     uuid NOT NULL REFERENCES course_version(id),
  document_id           uuid NOT NULL REFERENCES document(id),
  document_version_id   uuid NOT NULL REFERENCES document_version(id),
  status                text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'no_retraining', 'retraining_assigned')),
  raised_at             timestamptz NOT NULL DEFAULT now(),
  decided_by            uuid REFERENCES app_user(id),
  decided_at            timestamptz,
  decision_note         text,
  UNIQUE (course_version_id, document_version_id)
);

-- ---------------------------------------------------------------------------
-- RLS: catalog by tenant (+ course facility); learner records follow the employee's facility visibility
-- ---------------------------------------------------------------------------
ALTER TABLE course ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_facility ON course USING (tenant_id = app_tenant_id() AND app_can_see_facility(facility_id))
  WITH CHECK (tenant_id = app_tenant_id() AND app_can_see_facility(facility_id));

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['qualification', 'qualification_course']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id())', t);
  END LOOP;
END $$;

ALTER TABLE course_version ENABLE ROW LEVEL SECURITY;
CREATE POLICY via_parent ON course_version
  USING (tenant_id = app_tenant_id() AND EXISTS (SELECT 1 FROM course c WHERE c.id = course_id))
  WITH CHECK (tenant_id = app_tenant_id() AND EXISTS (SELECT 1 FROM course c WHERE c.id = course_id));
ALTER TABLE learning_event ENABLE ROW LEVEL SECURITY;
CREATE POLICY via_parent ON learning_event
  USING (tenant_id = app_tenant_id() AND EXISTS (SELECT 1 FROM course_version v WHERE v.id = course_version_id))
  WITH CHECK (tenant_id = app_tenant_id() AND EXISTS (SELECT 1 FROM course_version v WHERE v.id = course_version_id));
ALTER TABLE assessment ENABLE ROW LEVEL SECURITY;
CREATE POLICY via_parent ON assessment
  USING (tenant_id = app_tenant_id() AND EXISTS (SELECT 1 FROM learning_event e WHERE e.id = learning_event_id))
  WITH CHECK (tenant_id = app_tenant_id() AND EXISTS (SELECT 1 FROM learning_event e WHERE e.id = learning_event_id));
ALTER TABLE training_review ENABLE ROW LEVEL SECURITY;
CREATE POLICY via_parent ON training_review
  USING (tenant_id = app_tenant_id() AND EXISTS (SELECT 1 FROM course_version v WHERE v.id = course_version_id))
  WITH CHECK (tenant_id = app_tenant_id() AND EXISTS (SELECT 1 FROM course_version v WHERE v.id = course_version_id));

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['enrollment', 'employee_qualification', 'external_credential']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY via_employee ON %I USING (tenant_id = app_tenant_id() AND EXISTS (SELECT 1 FROM employee e WHERE e.id = employee_id)) WITH CHECK (tenant_id = app_tenant_id() AND EXISTS (SELECT 1 FROM employee e WHERE e.id = employee_id))', t);
  END LOOP;
  FOREACH t IN ARRAY ARRAY['event_completion', 'assessment_attempt', 'training_evidence']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY via_enrollment ON %I USING (tenant_id = app_tenant_id() AND EXISTS (SELECT 1 FROM enrollment n WHERE n.id = enrollment_id)) WITH CHECK (tenant_id = app_tenant_id() AND EXISTS (SELECT 1 FROM enrollment n WHERE n.id = enrollment_id))', t);
  END LOOP;
END $$;

ALTER TABLE certificate ENABLE ROW LEVEL SECURITY;
CREATE POLICY via_grant ON certificate
  USING (tenant_id = app_tenant_id() AND EXISTS (SELECT 1 FROM employee_qualification q WHERE q.id = employee_qualification_id))
  WITH CHECK (tenant_id = app_tenant_id() AND EXISTS (SELECT 1 FROM employee_qualification q WHERE q.id = employee_qualification_id));
ALTER TABLE asset_qualification_requirement ENABLE ROW LEVEL SECURITY;
CREATE POLICY via_asset ON asset_qualification_requirement
  USING (tenant_id = app_tenant_id() AND EXISTS (SELECT 1 FROM asset a WHERE a.id = asset_id))
  WITH CHECK (tenant_id = app_tenant_id() AND EXISTS (SELECT 1 FROM asset a WHERE a.id = asset_id));

GRANT SELECT, INSERT, UPDATE ON course, course_version, learning_event, assessment, enrollment, qualification,
  qualification_course, employee_qualification, training_review TO erp_app;
GRANT SELECT, INSERT ON event_completion, assessment_attempt, training_evidence, certificate, external_credential,
  asset_qualification_requirement TO erp_app;
GRANT DELETE ON learning_event, assessment, qualification_course, asset_qualification_requirement TO erp_app;

-- Existing tenants: extend the stock admin and maintenance-manager roles with the new permissions.
-- (Tenant-customized roles are left alone; admins add permissions to them deliberately.)
UPDATE role SET permissions = (SELECT array_agg(DISTINCT p) FROM unnest(permissions || ARRAY[
    'learning.view', 'learning.manage', 'learning.assign', 'learning.instruct', 'learning.evaluate', 'learning.view_records',
    'qualifications.view', 'qualifications.grant']) p)
  WHERE key IN ('admin', 'maintenance_manager');
