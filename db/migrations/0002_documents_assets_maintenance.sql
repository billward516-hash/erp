-- 0002 Controlled documents, asset registry, utilization state log, parts, maintenance work orders.

-- ---------------------------------------------------------------------------
-- Controlled documents (shared by Assets, Work Orders, and later LMS/Quality)
-- ---------------------------------------------------------------------------
CREATE TABLE document (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             uuid NOT NULL REFERENCES tenant(id),
  facility_id           uuid REFERENCES facility(id),          -- NULL = tenant-wide document
  doc_number            text NOT NULL,
  title                 text NOT NULL,
  doc_type              text NOT NULL CHECK (doc_type IN (
                          'manual', 'troubleshooting_guide', 'repair_procedure', 'service_bulletin',
                          'drawing', 'sop', 'training_material', 'photo', 'video', 'contract', 'other')),
  tags                  text[] NOT NULL DEFAULT '{}',
  restricted            boolean NOT NULL DEFAULT false,       -- requires documents.view_restricted
  safety_critical       boolean NOT NULL DEFAULT false,
  owner_user_id         uuid REFERENCES app_user(id),
  current_version_id    uuid,                                  -- latest APPROVED version
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, doc_number)
);
CREATE TRIGGER document_touch BEFORE UPDATE ON document FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

CREATE TABLE document_version (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenant(id),
  document_id     uuid NOT NULL REFERENCES document(id),
  revision        integer NOT NULL,
  version_label   text NOT NULL,
  status          text NOT NULL DEFAULT 'draft'
                    CHECK (status IN ('draft', 'in_review', 'approved', 'superseded', 'obsolete')),
  storage_key     text NOT NULL,
  file_name       text NOT NULL,
  mime_type       text NOT NULL,
  size_bytes      bigint NOT NULL,
  sha256          text NOT NULL,
  change_summary  text,
  extracted_text  text,                                        -- for search; filled by text extractors
  created_by      uuid REFERENCES app_user(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  approved_by     uuid REFERENCES app_user(id),
  approved_at     timestamptz,
  UNIQUE (document_id, revision)
);
ALTER TABLE document ADD CONSTRAINT document_current_version_fk
  FOREIGN KEY (current_version_id) REFERENCES document_version(id);

-- Released content is immutable: once approved, only the status may move forward.
CREATE FUNCTION document_version_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status IN ('approved', 'superseded', 'obsolete') THEN
    IF NEW.storage_key <> OLD.storage_key OR NEW.sha256 <> OLD.sha256 OR NEW.revision <> OLD.revision
       OR NEW.document_id <> OLD.document_id OR NEW.approved_by IS DISTINCT FROM OLD.approved_by THEN
      RAISE EXCEPTION 'released document versions are immutable';
    END IF;
    IF NOT (NEW.status = OLD.status
            OR (OLD.status = 'approved' AND NEW.status IN ('superseded', 'obsolete'))
            OR (OLD.status = 'superseded' AND NEW.status = 'obsolete')) THEN
      RAISE EXCEPTION 'invalid released status transition % -> %', OLD.status, NEW.status;
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER document_version_guard BEFORE UPDATE ON document_version
  FOR EACH ROW EXECUTE FUNCTION document_version_guard();

-- Generic link from a document to any record (asset, work order, course, ...).
-- pinned_version_id NULL = "always the current approved version".
CREATE TABLE document_link (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid NOT NULL REFERENCES tenant(id),
  document_id        uuid NOT NULL REFERENCES document(id),
  entity_type        text NOT NULL,
  entity_id          uuid NOT NULL,
  link_role          text NOT NULL DEFAULT 'reference',
  pinned_version_id  uuid REFERENCES document_version(id),
  created_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (document_id, entity_type, entity_id, link_role)
);
CREATE INDEX document_link_entity ON document_link (tenant_id, entity_type, entity_id);

-- ---------------------------------------------------------------------------
-- Asset registry: facility > functional location (area/line/cell) > asset > component
-- ---------------------------------------------------------------------------
CREATE TABLE functional_location (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenant(id),
  facility_id  uuid NOT NULL REFERENCES facility(id),
  parent_id    uuid REFERENCES functional_location(id),
  code         text NOT NULL,
  name         text NOT NULL,
  kind         text NOT NULL DEFAULT 'area' CHECK (kind IN ('building', 'area', 'line', 'cell', 'storeroom', 'other')),
  UNIQUE (facility_id, code)
);

CREATE TABLE downtime_reason (
  tenant_id  uuid NOT NULL REFERENCES tenant(id),
  code       text NOT NULL,
  label      text NOT NULL,
  category   text NOT NULL CHECK (category IN ('planned', 'unplanned')),
  PRIMARY KEY (tenant_id, code)
);

CREATE TABLE asset (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             uuid NOT NULL REFERENCES tenant(id),
  facility_id           uuid NOT NULL REFERENCES facility(id),
  location_id           uuid REFERENCES functional_location(id),
  parent_asset_id       uuid REFERENCES asset(id),
  asset_tag             text NOT NULL,
  name                  text NOT NULL,
  asset_class           text NOT NULL DEFAULT 'equipment'
                          CHECK (asset_class IN ('equipment', 'component', 'tool', 'vehicle', 'facility_system', 'it')),
  category              text,
  manufacturer          text,
  model                 text,
  serial_number         text,
  commissioned_on       date,
  warranty_expires_on   date,
  criticality           text CHECK (criticality IN ('high', 'medium', 'low')),
  lifecycle_status      text NOT NULL DEFAULT 'active'
                          CHECK (lifecycle_status IN ('planned', 'active', 'inactive', 'disposed')),
  operational_state     text NOT NULL DEFAULT 'available'
                          CHECK (operational_state IN ('available', 'running', 'idle', 'planned_downtime',
                                                       'unplanned_downtime', 'out_of_service')),
  owner_department_id   uuid REFERENCES department(id),
  responsible_team      text,
  vendor_name           text,
  rated_capacity        numeric,
  rated_capacity_unit   text,
  replacement_cost      numeric(14, 2),
  qr_token              text NOT NULL DEFAULT substr(replace(gen_random_uuid()::text, '-', ''), 1, 16),
  custom_fields         jsonb NOT NULL DEFAULT '{}',
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, asset_tag),
  UNIQUE (qr_token),
  CHECK (parent_asset_id IS NULL OR parent_asset_id <> id)
);
CREATE INDEX asset_facility ON asset (tenant_id, facility_id);
CREATE TRIGGER asset_touch BEFORE UPDATE ON asset FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- State intervals drive utilization/availability. ended_at NULL = current state.
-- Overlapping intervals for one asset are rejected so time is never double-counted.
CREATE TABLE asset_state_event (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenant(id),
  facility_id  uuid NOT NULL REFERENCES facility(id),
  asset_id     uuid NOT NULL REFERENCES asset(id),
  state        text NOT NULL CHECK (state IN ('available', 'running', 'idle', 'planned_downtime',
                                              'unplanned_downtime', 'out_of_service')),
  reason_code  text,
  started_at   timestamptz NOT NULL,
  ended_at     timestamptz,
  source       text NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'import', 'work_order', 'telemetry')),
  note         text,
  recorded_by  uuid REFERENCES app_user(id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  CHECK (ended_at IS NULL OR ended_at > started_at),
  EXCLUDE USING gist (asset_id WITH =, tstzrange(started_at, coalesce(ended_at, 'infinity')) WITH &&)
);
CREATE INDEX asset_state_event_asset ON asset_state_event (asset_id, started_at);

-- ---------------------------------------------------------------------------
-- Parts (master only in this slice; stock locations/movements arrive with Inventory)
-- ---------------------------------------------------------------------------
CREATE TABLE part (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                 uuid NOT NULL REFERENCES tenant(id),
  part_number               text NOT NULL,
  description               text NOT NULL,
  uom                       text NOT NULL DEFAULT 'EA',
  manufacturer              text,
  manufacturer_part_number  text,
  unit_cost                 numeric(14, 4),
  currency                  text NOT NULL DEFAULT 'USD',
  active                    boolean NOT NULL DEFAULT true,
  custom_fields             jsonb NOT NULL DEFAULT '{}',
  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, part_number)
);
CREATE TRIGGER part_touch BEFORE UPDATE ON part FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- ---------------------------------------------------------------------------
-- Maintenance: request -> work order -> labor/parts/procedures -> verification
-- ---------------------------------------------------------------------------
CREATE TABLE maintenance_request (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenant(id),
  facility_id    uuid NOT NULL REFERENCES facility(id),
  asset_id       uuid NOT NULL REFERENCES asset(id),
  requested_by   uuid REFERENCES app_user(id),
  symptom        text NOT NULL,
  severity       text NOT NULL CHECK (severity IN ('low', 'medium', 'high', 'critical')),
  safety_impact  boolean NOT NULL DEFAULT false,
  asset_down     boolean NOT NULL DEFAULT false,
  status         text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'converted', 'rejected')),
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE work_order (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id              uuid NOT NULL REFERENCES tenant(id),
  facility_id            uuid NOT NULL REFERENCES facility(id),
  number                 text NOT NULL,
  asset_id               uuid NOT NULL REFERENCES asset(id),
  request_id             uuid REFERENCES maintenance_request(id),
  wo_type                text NOT NULL DEFAULT 'corrective'
                           CHECK (wo_type IN ('corrective', 'preventive', 'inspection', 'other')),
  priority               smallint NOT NULL DEFAULT 3 CHECK (priority BETWEEN 1 AND 4),  -- 1 = emergency
  title                  text NOT NULL,
  description            text,
  safety_notes           text,
  status                 text NOT NULL DEFAULT 'planned'
                           CHECK (status IN ('planned', 'scheduled', 'in_progress', 'on_hold',
                                             'completed', 'verified', 'closed', 'cancelled')),
  due_at                 timestamptz,
  estimated_labor_hours  numeric(8, 2),
  started_at             timestamptz,
  completed_at           timestamptz,
  completed_by           uuid REFERENCES app_user(id),
  verified_at            timestamptz,
  verified_by            uuid REFERENCES app_user(id),
  closed_at              timestamptz,
  failure_code           text,
  cause_code             text,
  remedy                 text,
  findings               text,
  downtime_event_id      uuid REFERENCES asset_state_event(id),
  origin                 text NOT NULL DEFAULT 'native' CHECK (origin IN ('native', 'import')),
  legacy_number          text,
  custom_fields          jsonb NOT NULL DEFAULT '{}',
  created_by             uuid REFERENCES app_user(id),
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, number)
);
CREATE INDEX work_order_open ON work_order (tenant_id, facility_id, status);
CREATE INDEX work_order_asset ON work_order (asset_id, created_at);
CREATE TRIGGER work_order_touch BEFORE UPDATE ON work_order FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

CREATE TABLE work_order_assignment (
  tenant_id      uuid NOT NULL REFERENCES tenant(id),
  work_order_id  uuid NOT NULL REFERENCES work_order(id),
  employee_id    uuid NOT NULL REFERENCES employee(id),
  role           text NOT NULL DEFAULT 'technician' CHECK (role IN ('lead', 'technician')),
  assigned_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (work_order_id, employee_id)
);

CREATE TABLE work_order_labor (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenant(id),
  work_order_id  uuid NOT NULL REFERENCES work_order(id),
  employee_id    uuid NOT NULL REFERENCES employee(id),
  work_date      date NOT NULL,
  hours          numeric(8, 2) NOT NULL CHECK (hours > 0 AND hours <= 24),
  hourly_rate    numeric(10, 2),          -- snapshot at entry time (operational cost, not payroll)
  note           text,
  recorded_by    uuid REFERENCES app_user(id),
  created_at     timestamptz NOT NULL DEFAULT now()
);

-- Reference (planned) vs actual consumption are kept distinct on each line.
CREATE TABLE work_order_part (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id              uuid NOT NULL REFERENCES tenant(id),
  work_order_id          uuid NOT NULL REFERENCES work_order(id),
  part_id                uuid NOT NULL REFERENCES part(id),
  substitute_for_part_id uuid REFERENCES part(id),
  qty_planned            numeric(12, 3) NOT NULL DEFAULT 0 CHECK (qty_planned >= 0),
  qty_used               numeric(12, 3) NOT NULL DEFAULT 0 CHECK (qty_used >= 0),
  unit_cost              numeric(14, 4),   -- snapshot
  note                   text,
  created_at             timestamptz NOT NULL DEFAULT now()
);

-- Procedure versions actually used on a work order (pinned for history).
CREATE TABLE work_order_document (
  tenant_id            uuid NOT NULL REFERENCES tenant(id),
  work_order_id        uuid NOT NULL REFERENCES work_order(id),
  document_version_id  uuid NOT NULL REFERENCES document_version(id),
  attached_at          timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (work_order_id, document_version_id)
);

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------
DO $$
DECLARE t text;
BEGIN
  -- facility-scoped tables (facility_id column; NULL means tenant-wide)
  FOREACH t IN ARRAY ARRAY['document', 'functional_location', 'asset', 'asset_state_event',
                           'maintenance_request', 'work_order']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_facility ON %I USING (tenant_id = app_tenant_id() AND app_can_see_facility(facility_id)) WITH CHECK (tenant_id = app_tenant_id() AND app_can_see_facility(facility_id))', t);
  END LOOP;
  FOREACH t IN ARRAY ARRAY['downtime_reason', 'part']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id())', t);
  END LOOP;
END $$;

-- Child tables inherit visibility from their parent so facility scope cannot be bypassed.
ALTER TABLE document_version ENABLE ROW LEVEL SECURITY;
CREATE POLICY via_parent ON document_version
  USING (tenant_id = app_tenant_id() AND EXISTS (SELECT 1 FROM document d WHERE d.id = document_id))
  WITH CHECK (tenant_id = app_tenant_id() AND EXISTS (SELECT 1 FROM document d WHERE d.id = document_id));

ALTER TABLE document_link ENABLE ROW LEVEL SECURITY;
CREATE POLICY via_parent ON document_link
  USING (tenant_id = app_tenant_id() AND EXISTS (SELECT 1 FROM document d WHERE d.id = document_id))
  WITH CHECK (tenant_id = app_tenant_id() AND EXISTS (SELECT 1 FROM document d WHERE d.id = document_id));

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['work_order_assignment', 'work_order_labor', 'work_order_part', 'work_order_document']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY via_parent ON %I USING (tenant_id = app_tenant_id() AND EXISTS (SELECT 1 FROM work_order w WHERE w.id = work_order_id)) WITH CHECK (tenant_id = app_tenant_id() AND EXISTS (SELECT 1 FROM work_order w WHERE w.id = work_order_id))', t);
  END LOOP;
END $$;

GRANT SELECT, INSERT, UPDATE ON document, document_version, document_link, functional_location,
  downtime_reason, asset, asset_state_event, part, maintenance_request, work_order,
  work_order_assignment, work_order_labor, work_order_part, work_order_document TO erp_app;
GRANT DELETE ON document_link, work_order_assignment, work_order_part TO erp_app;
