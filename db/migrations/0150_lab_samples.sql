-- 0150 Samples and test results (SC-007 D, D-184D): a deliberately small laboratory record system. Methods with analytes and
-- specification limits, samples with append-only custody, tests and results (qualified analyst, calibrated instrument, a different
-- reviewer), out-of-specification investigations that must close before release, and the certificate of analysis built from them.
-- These are records to support a lab's own quality system; nothing here claims ISO/IEC 17025 or 21 CFR Part 11 compliance.

-- A test method at one site. A change to what a method measures is a new version (a new row); a version in use is never edited.
CREATE TABLE lab_method (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                uuid NOT NULL REFERENCES tenant(id),
  facility_id              uuid NOT NULL REFERENCES facility(id),
  code                     text NOT NULL CHECK (length(trim(code)) >= 1),
  version                  integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  name                     text NOT NULL CHECK (length(trim(name)) >= 2),
  description              text,
  document_id              uuid REFERENCES document(id),
  document_version_id      uuid REFERENCES document_version(id),   -- the approved revision current when this method version was saved
  required_qualification_id uuid REFERENCES qualification(id),     -- who may enter results (existing qualification gating)
  required_instrument_class text,                                  -- matched to the asset's category; the instrument must be under calibration control
  status                   text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'retired')),
  created_by               uuid NOT NULL REFERENCES app_user(id),
  created_at               timestamptz NOT NULL DEFAULT now(),
  retired_at               timestamptz,
  UNIQUE (tenant_id, facility_id, code, version)
);
CREATE INDEX lab_method_facility ON lab_method (facility_id);
CREATE INDEX lab_method_document ON lab_method (document_id) WHERE document_id IS NOT NULL;
CREATE INDEX lab_method_document_version ON lab_method (document_version_id) WHERE document_version_id IS NOT NULL;
CREATE INDEX lab_method_qualification ON lab_method (required_qualification_id) WHERE required_qualification_id IS NOT NULL;
CREATE INDEX lab_method_creator ON lab_method (created_by);

CREATE TABLE lab_method_analyte (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenant(id),
  method_id   uuid NOT NULL REFERENCES lab_method(id) ON DELETE CASCADE,
  seq         integer NOT NULL,
  name        text NOT NULL CHECK (length(trim(name)) >= 1),
  unit        text NOT NULL CHECK (length(trim(unit)) >= 1),
  spec_low    numeric,        -- inclusive; either limit may be absent (a one-sided specification)
  spec_high   numeric,
  UNIQUE (method_id, seq),
  UNIQUE (method_id, name),
  CHECK (spec_low IS NULL OR spec_high IS NULL OR spec_low <= spec_high)
);

CREATE TABLE lab_sample (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid NOT NULL REFERENCES tenant(id),
  facility_id        uuid NOT NULL REFERENCES facility(id),
  number             text NOT NULL,
  source             text NOT NULL CHECK (source IN ('customer', 'internal')),
  customer_id        uuid REFERENCES customer(id),
  customer_reference text,
  description        text NOT NULL CHECK (length(trim(description)) >= 2),
  container          text,
  quantity           numeric CHECK (quantity IS NULL OR quantity >= 0),
  quantity_unit      text,
  storage_location   text,
  received_on        date NOT NULL,
  due_on             date NOT NULL,                       -- turnaround target
  retention_until    date,
  status             text NOT NULL DEFAULT 'received' CHECK (status IN ('received', 'in_testing', 'in_review', 'released', 'on_hold', 'disposed')),
  hold_reason        text,
  held_from          text,
  released_at        timestamptz,
  released_by        uuid REFERENCES app_user(id),
  release_note       text,
  disposed_at        timestamptz,
  disposed_by        uuid REFERENCES app_user(id),
  disposal_note      text,
  received_by        uuid NOT NULL REFERENCES app_user(id),
  created_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, number),
  CHECK (source = 'customer' OR customer_id IS NULL),
  CHECK (due_on >= received_on),
  CHECK (retention_until IS NULL OR retention_until >= received_on)
);
CREATE INDEX lab_sample_facility_status ON lab_sample (facility_id, status);
CREATE INDEX lab_sample_customer ON lab_sample (customer_id) WHERE customer_id IS NOT NULL;
CREATE INDEX lab_sample_received_by ON lab_sample (received_by);
CREATE INDEX lab_sample_released_by ON lab_sample (released_by) WHERE released_by IS NOT NULL;
CREATE INDEX lab_sample_disposed_by ON lab_sample (disposed_by) WHERE disposed_by IS NOT NULL;

-- Who held the sample, from where to where, and when. Appended, never changed.
CREATE TABLE lab_custody_event (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenant(id),
  facility_id uuid NOT NULL REFERENCES facility(id),
  sample_id   uuid NOT NULL REFERENCES lab_sample(id),
  kind        text NOT NULL CHECK (kind IN ('received', 'moved', 'handed_over', 'returned', 'on_hold', 'resumed', 'released', 'disposed')),
  from_where  text,
  to_where    text,
  note        text,
  by_user_id  uuid NOT NULL REFERENCES app_user(id),
  at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX lab_custody_sample ON lab_custody_event (sample_id, at);
CREATE INDEX lab_custody_facility ON lab_custody_event (facility_id);
CREATE INDEX lab_custody_by ON lab_custody_event (by_user_id);
CREATE FUNCTION lab_custody_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'custody events cannot be changed or removed; record a new event';
END $$;
CREATE TRIGGER lab_custody_immutable BEFORE UPDATE OR DELETE ON lab_custody_event FOR EACH ROW EXECUTE FUNCTION lab_custody_immutable();

CREATE TABLE lab_test (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenant(id),
  facility_id      uuid NOT NULL REFERENCES facility(id),
  sample_id        uuid NOT NULL REFERENCES lab_sample(id),
  method_id        uuid NOT NULL REFERENCES lab_method(id),
  status           text NOT NULL DEFAULT 'assigned' CHECK (status IN ('assigned', 'entered', 'reviewed', 'cancelled')),
  assigned_user_id uuid REFERENCES app_user(id),
  entered_by       uuid REFERENCES app_user(id),
  entered_at       timestamptz,
  reviewed_by      uuid REFERENCES app_user(id),
  reviewed_at      timestamptz,
  review_note      text,
  cancelled_reason text,
  created_by       uuid NOT NULL REFERENCES app_user(id),
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX lab_test_sample ON lab_test (sample_id);
CREATE INDEX lab_test_method ON lab_test (method_id);
CREATE INDEX lab_test_facility ON lab_test (facility_id);
CREATE INDEX lab_test_assigned ON lab_test (assigned_user_id) WHERE assigned_user_id IS NOT NULL;
CREATE INDEX lab_test_entered_by ON lab_test (entered_by) WHERE entered_by IS NOT NULL;
CREATE INDEX lab_test_reviewed_by ON lab_test (reviewed_by) WHERE reviewed_by IS NOT NULL;
CREATE INDEX lab_test_creator ON lab_test (created_by);

-- Once a test uses a method version, what it measures and the limits are frozen: a change is a new version.
CREATE FUNCTION lab_analyte_frozen() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE mid uuid := coalesce(NEW.method_id, OLD.method_id);
BEGIN
  IF EXISTS (SELECT 1 FROM lab_test WHERE method_id = mid) THEN
    RAISE EXCEPTION 'this method version has been used in a test; save a new version to change its analytes or limits';
  END IF;
  RETURN coalesce(NEW, OLD);
END $$;
CREATE TRIGGER lab_analyte_frozen BEFORE INSERT OR UPDATE OR DELETE ON lab_method_analyte FOR EACH ROW EXECUTE FUNCTION lab_analyte_frozen();

-- One result per analyte of a test. The analyte, unit and limits are copied here so the result keeps the limits it was judged against,
-- and so are the instrument's tag and calibration due date. A result is never edited; a correction supersedes it with a reason.
CREATE TABLE lab_result (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid NOT NULL REFERENCES tenant(id),
  facility_id        uuid NOT NULL REFERENCES facility(id),
  test_id            uuid NOT NULL REFERENCES lab_test(id),
  analyte_id         uuid NOT NULL REFERENCES lab_method_analyte(id),
  analyte_name       text NOT NULL,
  unit               text NOT NULL,
  spec_low           numeric,
  spec_high          numeric,
  value              numeric NOT NULL,
  outcome            text NOT NULL CHECK (outcome IN ('pass', 'fail', 'reported')),   -- reported: the analyte has no limits
  instrument_asset_id uuid REFERENCES asset(id),
  instrument_tag     text,
  instrument_cal_due date,
  note               text,
  entered_by         uuid NOT NULL REFERENCES app_user(id),
  analyst_employee_id uuid REFERENCES employee(id),
  entered_at         timestamptz NOT NULL DEFAULT now(),
  superseded_at      timestamptz,
  superseded_reason  text
);
CREATE UNIQUE INDEX lab_result_active ON lab_result (test_id, analyte_id) WHERE superseded_at IS NULL;
CREATE INDEX lab_result_test ON lab_result (test_id);
CREATE INDEX lab_result_analyte ON lab_result (analyte_id);
CREATE INDEX lab_result_facility ON lab_result (facility_id);
CREATE INDEX lab_result_instrument ON lab_result (instrument_asset_id) WHERE instrument_asset_id IS NOT NULL;
CREATE INDEX lab_result_entered_by ON lab_result (entered_by);
CREATE INDEX lab_result_employee ON lab_result (analyst_employee_id) WHERE analyst_employee_id IS NOT NULL;
CREATE FUNCTION lab_result_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'results cannot be deleted; supersede the result with a reason'; END IF;
  IF OLD.superseded_at IS NOT NULL OR NEW.superseded_at IS NULL OR NEW.superseded_reason IS NULL
     OR (to_jsonb(NEW) - 'superseded_at' - 'superseded_reason') IS DISTINCT FROM (to_jsonb(OLD) - 'superseded_at' - 'superseded_reason') THEN
    RAISE EXCEPTION 'a result cannot be changed; supersede it with a reason and enter a new one';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER lab_result_guard BEFORE UPDATE OR DELETE ON lab_result FOR EACH ROW EXECUTE FUNCTION lab_result_guard();

-- An out-of-specification result opens exactly one investigation; it must be closed before the sample is released.
CREATE TABLE lab_investigation (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenant(id),
  facility_id    uuid NOT NULL REFERENCES facility(id),
  number         text NOT NULL,
  sample_id      uuid NOT NULL REFERENCES lab_sample(id),
  test_id        uuid NOT NULL REFERENCES lab_test(id),
  result_id      uuid NOT NULL UNIQUE REFERENCES lab_result(id),
  status         text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
  cause          text,
  retest_result  text,
  conclusion     text,
  decision       text CHECK (decision IN ('confirmed_oos', 'invalidated')),
  invalid_reason text,
  opened_by      uuid NOT NULL REFERENCES app_user(id),
  opened_at      timestamptz NOT NULL DEFAULT now(),
  closed_by      uuid REFERENCES app_user(id),
  closed_at      timestamptz,
  ncr_id         uuid UNIQUE REFERENCES nonconformance(id),
  capa_id        uuid UNIQUE REFERENCES corrective_action(id),
  UNIQUE (tenant_id, number),
  CHECK (ncr_id IS NULL OR capa_id IS NULL),
  CHECK (status = 'open' OR (decision IS NOT NULL AND conclusion IS NOT NULL AND closed_by IS NOT NULL AND closed_at IS NOT NULL)),
  CHECK (decision IS DISTINCT FROM 'invalidated' OR invalid_reason IS NOT NULL)
);
CREATE INDEX lab_investigation_sample ON lab_investigation (sample_id, status);
CREATE INDEX lab_investigation_test ON lab_investigation (test_id);
CREATE INDEX lab_investigation_facility ON lab_investigation (facility_id);
CREATE INDEX lab_investigation_opened_by ON lab_investigation (opened_by);
CREATE INDEX lab_investigation_closed_by ON lab_investigation (closed_by) WHERE closed_by IS NOT NULL;

DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['lab_method', 'lab_sample', 'lab_custody_event', 'lab_test', 'lab_result', 'lab_investigation'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_facility ON %I USING (tenant_id = app_tenant_id() AND app_can_see_facility(facility_id)) WITH CHECK (tenant_id = app_tenant_id() AND app_can_see_facility(facility_id))', t);
  END LOOP;
END $$;
ALTER TABLE lab_method_analyte ENABLE ROW LEVEL SECURITY;
CREATE POLICY via_parent ON lab_method_analyte USING (tenant_id = app_tenant_id() AND EXISTS (SELECT 1 FROM lab_method m WHERE m.id = method_id))
  WITH CHECK (tenant_id = app_tenant_id() AND EXISTS (SELECT 1 FROM lab_method m WHERE m.id = method_id));
CREATE INDEX lab_method_analyte_tenant ON lab_method_analyte (tenant_id);

GRANT SELECT, INSERT, UPDATE ON lab_method, lab_sample, lab_test, lab_result, lab_investigation TO erp_app;
GRANT SELECT, INSERT ON lab_custody_event TO erp_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON lab_method_analyte TO erp_app;

-- Permissions: view; analyze (receive samples, assign tests, enter results, work investigations); review (review results, close investigations, release);
-- manage (methods, disposal). Administrators hold all four; quality managers and reviewers review.
INSERT INTO role (tenant_id, key, name, permissions)
SELECT t.id, r.key, r.name, r.permissions FROM tenant t CROSS JOIN (VALUES
  ('lab_analyst', 'Laboratory Analyst', ARRAY['org.view', 'assets.view', 'documents.view', 'learning.view', 'qualifications.view', 'reports.view', 'quality.report', 'lab.view', 'lab.analyze', 'expenses.submit', 'improve.submit']),
  ('lab_manager', 'Laboratory Manager', ARRAY['org.view', 'employees.view', 'assets.view', 'documents.view', 'documents.view_draft', 'learning.view', 'qualifications.view', 'reports.view', 'reports.export',
     'quality.view', 'quality.report', 'crm.view', 'lab.view', 'lab.analyze', 'lab.review', 'lab.manage', 'expenses.submit', 'improve.submit'])
) AS r(key, name, permissions)
WHERE NOT EXISTS (SELECT 1 FROM role x WHERE x.tenant_id = t.id AND x.key = r.key);
UPDATE role SET permissions = (SELECT array_agg(DISTINCT p) FROM unnest(permissions || ARRAY['lab.view', 'lab.analyze', 'lab.review', 'lab.manage']) p) WHERE key = 'admin';
UPDATE role SET permissions = (SELECT array_agg(DISTINCT p) FROM unnest(permissions || ARRAY['lab.view', 'lab.review', 'lab.manage']) p) WHERE key = 'quality_manager';
UPDATE role SET permissions = (SELECT array_agg(DISTINCT p) FROM unnest(permissions || ARRAY['lab.view', 'lab.review']) p) WHERE key = 'quality_reviewer';
