-- 0016 Calibration of measuring equipment, internal audits with findings, and attachments (photos,
-- certificates) on quality and safety records.

-- An instrument (any asset) under calibration control.
CREATE TABLE calibration_plan (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenant(id),
  facility_id     uuid NOT NULL REFERENCES facility(id),
  asset_id        uuid NOT NULL UNIQUE REFERENCES asset(id),
  interval_days   integer NOT NULL CHECK (interval_days BETWEEN 1 AND 3650),
  tolerance       text NOT NULL,                 -- e.g. "±0.002 mm over 0–300 mm"
  method          text,
  provider        text NOT NULL DEFAULT 'internal' CHECK (provider IN ('internal', 'external')),
  supplier_id     uuid REFERENCES supplier(id),  -- external calibration lab
  procedure_document_id uuid REFERENCES document(id),
  next_due        date NOT NULL,
  active          boolean NOT NULL DEFAULT true,
  created_by      uuid NOT NULL REFERENCES app_user(id),
  created_at      timestamptz NOT NULL DEFAULT now()
);

-- One calibration event. As-found decides whether earlier measurements are suspect; as-left whether it returns to service.
CREATE TABLE calibration_record (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenant(id),
  facility_id      uuid NOT NULL REFERENCES facility(id),
  plan_id          uuid NOT NULL REFERENCES calibration_plan(id),
  asset_id         uuid NOT NULL REFERENCES asset(id),
  performed_on     date NOT NULL,
  performed_by     text NOT NULL,                -- person or lab
  as_found         text NOT NULL CHECK (as_found IN ('in_tolerance', 'out_of_tolerance')),
  as_left          text NOT NULL CHECK (as_left IN ('in_tolerance', 'adjusted', 'failed')),
  certificate_no   text,
  notes            text,
  next_due         date,                         -- null when the instrument failed
  ncr_id           uuid REFERENCES nonconformance(id),
  recorded_by      uuid NOT NULL REFERENCES app_user(id),
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE FUNCTION calibration_record_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'calibration records cannot be changed; record a new calibration';
END $$;
CREATE TRIGGER calibration_record_immutable BEFORE UPDATE OR DELETE ON calibration_record FOR EACH ROW EXECUTE FUNCTION calibration_record_immutable();

CREATE TABLE quality_audit (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenant(id),
  facility_id      uuid NOT NULL REFERENCES facility(id),
  number           text NOT NULL,
  title            text NOT NULL,
  scope            text NOT NULL,                -- process/area and the standard or clauses
  kind             text NOT NULL DEFAULT 'internal' CHECK (kind IN ('internal', 'supplier', 'customer', 'certification')),
  supplier_id      uuid REFERENCES supplier(id),
  planned_on       date NOT NULL,
  lead_auditor_id  uuid NOT NULL REFERENCES app_user(id),
  auditee_user_id  uuid REFERENCES app_user(id), -- owner of the audited area
  status           text NOT NULL DEFAULT 'planned' CHECK (status IN ('planned', 'in_progress', 'reported', 'closed', 'cancelled')),
  summary          text,
  started_at       timestamptz,
  reported_at      timestamptz,
  closed_at        timestamptz,
  created_by       uuid NOT NULL REFERENCES app_user(id),
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, number),
  CHECK (auditee_user_id IS NULL OR auditee_user_id <> lead_auditor_id)
);

CREATE TABLE audit_item (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenant(id),
  audit_id      uuid NOT NULL REFERENCES quality_audit(id),
  seq           integer NOT NULL,
  requirement   text NOT NULL,                  -- the question or clause checked
  result        text CHECK (result IN ('conforming', 'observation', 'minor_nc', 'major_nc', 'not_applicable')),
  evidence      text,
  capa_id       uuid REFERENCES corrective_action(id),
  UNIQUE (audit_id, seq)
);

ALTER TABLE action_item DROP CONSTRAINT action_item_subject_type_check;
ALTER TABLE action_item ADD CONSTRAINT action_item_subject_type_check CHECK (subject_type IN ('corrective_action', 'safety_incident', 'quality_audit'));
ALTER TABLE action_item ADD COLUMN audit_item_id uuid REFERENCES audit_item(id);

-- Files attached to quality and safety records (photos, certificates, reports).
CREATE TABLE attachment (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenant(id),
  facility_id   uuid NOT NULL REFERENCES facility(id),
  subject_type  text NOT NULL CHECK (subject_type IN ('nonconformance', 'corrective_action', 'safety_incident', 'calibration_record', 'quality_audit')),
  subject_id    uuid NOT NULL,
  file_name     text NOT NULL,
  mime          text NOT NULL,
  size_bytes    integer NOT NULL,
  blob_key      text NOT NULL,
  sha256        text NOT NULL,
  restricted    boolean NOT NULL DEFAULT false, -- incident attachments showing people: safety staff only
  uploaded_by   uuid NOT NULL REFERENCES app_user(id),
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX attachment_subject ON attachment (subject_type, subject_id);

DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['calibration_plan', 'calibration_record', 'quality_audit', 'attachment'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_facility ON %I USING (tenant_id = app_tenant_id() AND app_can_see_facility(facility_id)) WITH CHECK (tenant_id = app_tenant_id() AND app_can_see_facility(facility_id))', t);
  END LOOP;
END $$;
ALTER TABLE audit_item ENABLE ROW LEVEL SECURITY;
CREATE POLICY via_parent ON audit_item USING (tenant_id = app_tenant_id() AND EXISTS (SELECT 1 FROM quality_audit a WHERE a.id = audit_id))
  WITH CHECK (tenant_id = app_tenant_id() AND EXISTS (SELECT 1 FROM quality_audit a WHERE a.id = audit_id));

GRANT SELECT, INSERT, UPDATE ON calibration_plan, quality_audit, audit_item TO erp_app;
GRANT SELECT, INSERT ON calibration_record TO erp_app;
GRANT SELECT, INSERT ON attachment TO erp_app;
GRANT DELETE ON audit_item TO erp_app;
