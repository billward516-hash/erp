-- 0018 FMEA (process, design, equipment) built on the existing primitives: approvals engine for review,
-- the shared action tracker for recommended actions, corrective actions, assets, parts, PM plans and controlled
-- documents for links. Scoring is configurable: AIAG-VDA action priority (default) or RPN with a threshold.

CREATE TABLE fmea (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenant(id),
  facility_id      uuid NOT NULL REFERENCES facility(id),
  number           text NOT NULL,                 -- shared by all revisions of one FMEA
  revision         integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  kind             text NOT NULL CHECK (kind IN ('process', 'design', 'equipment')),
  title            text NOT NULL,
  scope            text NOT NULL,
  method           text NOT NULL DEFAULT 'ap' CHECK (method IN ('ap', 'rpn')),
  rpn_threshold    integer CHECK (rpn_threshold BETWEEN 1 AND 1000),
  asset_id         uuid REFERENCES asset(id),     -- equipment FMEA
  part_id          uuid REFERENCES part(id),      -- product (design/process FMEA)
  document_id      uuid REFERENCES document(id),  -- the SOP / work instruction the process FMEA covers
  team             text,
  owner_user_id    uuid NOT NULL REFERENCES app_user(id),
  status           text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'in_review', 'approved', 'superseded')),
  review_due       date,                          -- periodic review
  approved_at      timestamptz,
  created_by       uuid NOT NULL REFERENCES app_user(id),
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, number, revision),
  CHECK (kind <> 'equipment' OR asset_id IS NOT NULL),
  CHECK (method <> 'rpn' OR rpn_threshold IS NOT NULL)
);
CREATE UNIQUE INDEX fmea_one_open_revision ON fmea (tenant_id, number) WHERE status IN ('draft', 'in_review');

CREATE TABLE fmea_row (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             uuid NOT NULL REFERENCES tenant(id),
  fmea_id               uuid NOT NULL REFERENCES fmea(id),
  seq                   integer NOT NULL,
  item                  text NOT NULL,             -- process step / function / component
  failure_mode          text NOT NULL,
  effect                text NOT NULL,
  severity              integer NOT NULL CHECK (severity BETWEEN 1 AND 10),
  cause                 text NOT NULL,
  occurrence            integer NOT NULL CHECK (occurrence BETWEEN 1 AND 10),
  prevention_controls   text,
  detection_controls    text,
  detection             integer NOT NULL CHECK (detection BETWEEN 1 AND 10),
  priority              text NOT NULL CHECK (priority IN ('H', 'M', 'L')),   -- computed by the chosen method
  failure_code          text,                      -- equipment FMEA: matches work order failure codes
  pm_plan_id            uuid REFERENCES pm_plan(id),     -- the PM task that is the control
  capa_id               uuid REFERENCES corrective_action(id),
  -- After the recommended actions:
  post_severity         integer CHECK (post_severity BETWEEN 1 AND 10),
  post_occurrence       integer CHECK (post_occurrence BETWEEN 1 AND 10),
  post_detection        integer CHECK (post_detection BETWEEN 1 AND 10),
  post_priority         text CHECK (post_priority IN ('H', 'M', 'L')),
  UNIQUE (fmea_id, seq)
);

-- The analysis is frozen once submitted; on an approved FMEA only the after-action evaluation and the
-- corrective action link may be recorded.
CREATE FUNCTION fmea_frozen() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE st text := (SELECT status FROM fmea WHERE id = coalesce(NEW.fmea_id, OLD.fmea_id));
BEGIN
  IF st = 'draft' THEN RETURN coalesce(NEW, OLD); END IF;
  IF TG_OP = 'UPDATE' AND st = 'approved'
     AND (NEW.seq, NEW.item, NEW.failure_mode, NEW.effect, NEW.severity, NEW.cause, NEW.occurrence, NEW.prevention_controls, NEW.detection_controls, NEW.detection,
          NEW.priority, NEW.failure_code, NEW.pm_plan_id)
     IS NOT DISTINCT FROM (OLD.seq, OLD.item, OLD.failure_mode, OLD.effect, OLD.severity, OLD.cause, OLD.occurrence, OLD.prevention_controls, OLD.detection_controls, OLD.detection,
          OLD.priority, OLD.failure_code, OLD.pm_plan_id) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'approved FMEAs cannot change; start a new revision';
END $$;
CREATE TRIGGER fmea_row_frozen BEFORE INSERT OR UPDATE OR DELETE ON fmea_row FOR EACH ROW EXECUTE FUNCTION fmea_frozen();

ALTER TABLE action_item DROP CONSTRAINT action_item_subject_type_check;
ALTER TABLE action_item ADD CONSTRAINT action_item_subject_type_check CHECK (subject_type IN ('corrective_action', 'safety_incident', 'quality_audit', 'fmea'));
ALTER TABLE action_item ADD COLUMN fmea_row_id uuid REFERENCES fmea_row(id);
ALTER TABLE corrective_action DROP CONSTRAINT corrective_action_source_check;
ALTER TABLE corrective_action ADD CONSTRAINT corrective_action_source_check CHECK (source IN ('nonconformance', 'incident', 'customer_complaint', 'audit', 'internal', 'fmea'));
ALTER TABLE attachment DROP CONSTRAINT attachment_subject_type_check;
ALTER TABLE attachment ADD CONSTRAINT attachment_subject_type_check CHECK (subject_type IN ('nonconformance', 'corrective_action', 'safety_incident', 'calibration_record', 'quality_audit', 'fmea'));

ALTER TABLE fmea ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_facility ON fmea USING (tenant_id = app_tenant_id() AND app_can_see_facility(facility_id)) WITH CHECK (tenant_id = app_tenant_id() AND app_can_see_facility(facility_id));
ALTER TABLE fmea_row ENABLE ROW LEVEL SECURITY;
CREATE POLICY via_parent ON fmea_row USING (tenant_id = app_tenant_id() AND EXISTS (SELECT 1 FROM fmea f WHERE f.id = fmea_id))
  WITH CHECK (tenant_id = app_tenant_id() AND EXISTS (SELECT 1 FROM fmea f WHERE f.id = fmea_id));
GRANT SELECT, INSERT, UPDATE ON fmea TO erp_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON fmea_row TO erp_app;
