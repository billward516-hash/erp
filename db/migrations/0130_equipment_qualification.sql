-- 0130 Equipment qualification, logbook and tool states (SC-007 B, D-184B). Built on assets and their state history, the
-- approval engine (executed protocols are approved by someone other than the executor), controlled documents (document_link),
-- attachments, work orders and changes. Numbers 0130 to 0139 are reserved for this slice.

-- SEMI E10-style tool states: an up state (available, running, idle) can be flagged as engineering use (process
-- characterisation, trials, qualification runs). No state is added to the existing set.
ALTER TABLE asset_state_event ADD COLUMN engineering boolean NOT NULL DEFAULT false;
ALTER TABLE asset_state_event ADD CONSTRAINT asset_state_engineering_up CHECK (NOT engineering OR state IN ('available', 'running', 'idle'));

-- Per company: requalification interval for each protocol type (months; null = not periodic) and how far ahead a due date warns.
CREATE TABLE qualification_setting (
  tenant_id      uuid PRIMARY KEY REFERENCES tenant(id),
  intervals      jsonb NOT NULL DEFAULT '{"IQ": null, "OQ": 12, "PQ": 12, "requalification": 12}',
  due_lead_days  integer NOT NULL DEFAULT 30 CHECK (due_lead_days BETWEEN 1 AND 365),
  updated_by     uuid REFERENCES app_user(id),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

-- An asset under qualification control (one row per asset; no row = not under control, so nothing is gated).
CREATE TABLE asset_qualification (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            uuid NOT NULL REFERENCES tenant(id),
  facility_id          uuid NOT NULL REFERENCES facility(id),
  asset_id             uuid NOT NULL UNIQUE REFERENCES asset(id),
  enabled              boolean NOT NULL DEFAULT true,
  status               text NOT NULL DEFAULT 'not_qualified' CHECK (status IN ('not_qualified', 'qualified', 'requalification_required')),
  requalify_after_work boolean NOT NULL DEFAULT true,     -- completed work or an implemented change on this tool requires requalification
  qualified_on         date,
  requal_due_on        date,                              -- periodic requalification, from the last approved protocol that has an interval
  required_since       timestamptz,                       -- when requalification became required; a passing approved protocol executed after this clears it
  required_reason      text,
  required_ref_type    text,
  required_ref_id      uuid,
  last_protocol_id     uuid,
  created_by           uuid REFERENCES app_user(id),
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  CHECK ((status = 'requalification_required') = (required_since IS NOT NULL))
);
CREATE INDEX asset_qualification_facility ON asset_qualification (facility_id);
CREATE TRIGGER asset_qualification_touch BEFORE UPDATE ON asset_qualification FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- A qualification protocol (IQ, OQ, PQ or requalification): draft -> executed -> approved or failed.
CREATE TABLE qualification_protocol (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL REFERENCES tenant(id),
  facility_id         uuid NOT NULL REFERENCES facility(id),
  asset_id            uuid NOT NULL REFERENCES asset(id),
  number              text NOT NULL,
  protocol_type       text NOT NULL CHECK (protocol_type IN ('IQ', 'OQ', 'PQ', 'requalification')),
  title               text NOT NULL,
  acceptance_criteria text NOT NULL DEFAULT '',
  interval_months     integer CHECK (interval_months BETWEEN 1 AND 120),   -- requalification interval once approved; null = none
  approver_user_id    uuid REFERENCES app_user(id),                         -- a named approver; null = anyone holding the quality manager role
  status              text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'executed', 'approved', 'failed', 'cancelled')),
  overall             text CHECK (overall IN ('pass', 'fail')),
  executed_by         uuid REFERENCES app_user(id),
  executed_at         timestamptz,
  conclusion          text,
  decided_at          timestamptz,
  requal_due_on       date,
  cancel_reason       text,
  created_by          uuid NOT NULL REFERENCES app_user(id),
  created_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, number),
  CHECK ((status IN ('executed', 'approved', 'failed')) = (executed_at IS NOT NULL AND overall IS NOT NULL AND executed_by IS NOT NULL))
);
CREATE INDEX qualification_protocol_asset ON qualification_protocol (asset_id, created_at);
CREATE INDEX qualification_protocol_facility ON qualification_protocol (facility_id);

-- Result entries: the step, what was expected, what was found, pass or fail.
CREATE TABLE qualification_result (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenant(id),
  facility_id  uuid NOT NULL REFERENCES facility(id),
  protocol_id  uuid NOT NULL REFERENCES qualification_protocol(id),
  seq          integer NOT NULL,
  step         text NOT NULL,
  expected     text NOT NULL DEFAULT '',
  actual       text,
  outcome      text NOT NULL DEFAULT 'pending' CHECK (outcome IN ('pending', 'pass', 'fail', 'na')),
  note         text,
  recorded_by  uuid REFERENCES app_user(id),
  recorded_at  timestamptz,
  UNIQUE (protocol_id, seq)
);
CREATE INDEX qualification_result_facility ON qualification_result (facility_id);

-- Results change only while the protocol is a draft (they are final once executed; a rejected protocol returns to draft).
CREATE FUNCTION qualification_result_frozen() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE st text := (SELECT status FROM qualification_protocol WHERE id = coalesce(NEW.protocol_id, OLD.protocol_id));
BEGIN
  IF st = 'draft' THEN RETURN coalesce(NEW, OLD); END IF;
  RAISE EXCEPTION 'the results of an executed protocol cannot change';
END $$;
CREATE TRIGGER qualification_result_frozen BEFORE INSERT OR UPDATE OR DELETE ON qualification_result FOR EACH ROW EXECUTE FUNCTION qualification_result_frozen();

-- What happened to an asset's qualification, in order. Append-only.
CREATE TABLE qualification_event (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenant(id),
  facility_id   uuid NOT NULL REFERENCES facility(id),
  asset_id      uuid NOT NULL REFERENCES asset(id),
  kind          text NOT NULL CHECK (kind IN ('switched_on', 'switched_off', 'declared', 'protocol_executed', 'protocol_approved', 'protocol_failed', 'protocol_rejected',
                                              'requal_required', 'requal_cleared', 'setting_changed')),
  occurred_at   timestamptz NOT NULL DEFAULT now(),
  actor_user_id uuid REFERENCES app_user(id),
  protocol_id   uuid REFERENCES qualification_protocol(id),
  ref_type      text,
  ref_id        uuid,
  summary       text NOT NULL,
  data          jsonb NOT NULL DEFAULT '{}'
);
CREATE INDEX qualification_event_asset ON qualification_event (asset_id, occurred_at);
CREATE INDEX qualification_event_facility ON qualification_event (facility_id);
CREATE INDEX qualification_event_protocol ON qualification_event (protocol_id) WHERE protocol_id IS NOT NULL;

-- Manual logbook notes. Append-only: a correction is a new note.
CREATE TABLE equipment_note (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenant(id),
  facility_id  uuid NOT NULL REFERENCES facility(id),
  asset_id     uuid NOT NULL REFERENCES asset(id),
  body         text NOT NULL CHECK (length(btrim(body)) > 0),
  created_by   uuid NOT NULL REFERENCES app_user(id),
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX equipment_note_asset ON equipment_note (asset_id, created_at);
CREATE INDEX equipment_note_facility ON equipment_note (facility_id);

CREATE FUNCTION qualification_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% records cannot be changed or deleted; add a new entry', TG_TABLE_NAME;
END $$;
CREATE TRIGGER qualification_event_append_only BEFORE UPDATE OR DELETE ON qualification_event FOR EACH ROW EXECUTE FUNCTION qualification_append_only();
CREATE TRIGGER equipment_note_append_only BEFORE UPDATE OR DELETE ON equipment_note FOR EACH ROW EXECUTE FUNCTION qualification_append_only();

-- Attachments on protocols and on result entries. The list is rebuilt from the current constraint, so parallel work that also adds
-- subject types is not overwritten whichever migration runs last.
DO $$
DECLARE subjects text[];
BEGIN
  SELECT array_agg(m[1]) INTO subjects FROM pg_constraint c, regexp_matches(pg_get_constraintdef(c.oid), '''([a-z_]+)''', 'g') m
   WHERE c.conrelid = 'attachment'::regclass AND c.conname = 'attachment_subject_type_check';
  subjects := (SELECT array_agg(DISTINCT s) FROM unnest(subjects || ARRAY['qualification_protocol', 'qualification_result']) s);
  ALTER TABLE attachment DROP CONSTRAINT attachment_subject_type_check;
  EXECUTE format('ALTER TABLE attachment ADD CONSTRAINT attachment_subject_type_check CHECK (subject_type = ANY (%L::text[]))', subjects);
END $$;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['asset_qualification', 'qualification_protocol', 'qualification_result', 'qualification_event', 'equipment_note']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_facility ON %I USING (tenant_id = app_tenant_id() AND app_can_see_facility(facility_id)) WITH CHECK (tenant_id = app_tenant_id() AND app_can_see_facility(facility_id))', t);
  END LOOP;
END $$;
ALTER TABLE qualification_setting ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON qualification_setting USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());
GRANT SELECT, INSERT, UPDATE ON asset_qualification, qualification_protocol, qualification_setting TO erp_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON qualification_result TO erp_app;
GRANT SELECT, INSERT ON qualification_event, equipment_note TO erp_app;

-- Permissions on stock roles of existing tenants (new tenants get them from the role templates).
UPDATE role SET permissions = (SELECT array_agg(DISTINCT p) FROM unnest(permissions || ARRAY['qualification.view', 'qualification.manage', 'qualification.execute']) p)
 WHERE key IN ('admin', 'maintenance_manager');
UPDATE role SET permissions = (SELECT array_agg(DISTINCT p) FROM unnest(permissions || ARRAY['qualification.view', 'qualification.manage']) p) WHERE key = 'quality_manager';
UPDATE role SET permissions = (SELECT array_agg(DISTINCT p) FROM unnest(permissions || ARRAY['qualification.view', 'qualification.execute']) p) WHERE key IN ('technician', 'field_technician');
UPDATE role SET permissions = (SELECT array_agg(DISTINCT p) FROM unnest(permissions || ARRAY['qualification.view']) p)
 WHERE key IN ('operations_manager', 'quality_reviewer', 'ehs_reviewer', 'executive', 'property_manager');
