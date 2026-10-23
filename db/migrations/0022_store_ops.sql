-- 0022 Store operations (S10c), for retail chains and any site that logs conditions or walks a checklist.
-- Condition points: something measured on an asset with limits (cooler temperature, freezer, humidity, pressure).
-- Readings out of limits open an excursion and one maintenance request per excursion, not one per reading.
-- Site visits: checklist templates walked at a site (district manager store walks, opening checklists); failed
-- items become maintenance requests (when they point at an asset) or actions in the shared tracker.

CREATE TABLE condition_point (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenant(id),
  facility_id     uuid NOT NULL REFERENCES facility(id),
  asset_id        uuid NOT NULL REFERENCES asset(id),
  measure         text NOT NULL DEFAULT 'temperature',
  unit            text NOT NULL,                       -- °F, °C, %RH, psi
  low             numeric(10, 2),
  high            numeric(10, 2),
  interval_hours  integer CHECK (interval_hours > 0),  -- readings expected at least this often (e.g. 12 = twice a day)
  active          boolean NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (asset_id, measure),
  CHECK (low IS NOT NULL OR high IS NOT NULL),
  CHECK (low IS NULL OR high IS NULL OR low < high)
);

CREATE TABLE condition_reading (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id    uuid NOT NULL REFERENCES tenant(id),
  facility_id  uuid NOT NULL REFERENCES facility(id),
  point_id     uuid NOT NULL REFERENCES condition_point(id),
  value        numeric(10, 2) NOT NULL,
  in_range     boolean NOT NULL,
  read_at      timestamptz NOT NULL,
  note         text,
  source       text NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'import', 'telemetry')),
  recorded_by  uuid REFERENCES app_user(id),
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX condition_reading_point ON condition_reading (point_id, read_at DESC);
CREATE FUNCTION condition_reading_final() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'condition readings are a log; record a new reading with a note instead'; END $$;
CREATE TRIGGER condition_reading_final BEFORE UPDATE OR DELETE ON condition_reading FOR EACH ROW EXECUTE FUNCTION condition_reading_final();

CREATE TABLE condition_excursion (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES tenant(id),
  facility_id       uuid NOT NULL REFERENCES facility(id),
  point_id          uuid NOT NULL REFERENCES condition_point(id),
  started_at        timestamptz NOT NULL,
  first_value       numeric(10, 2) NOT NULL,
  worst_value       numeric(10, 2) NOT NULL,
  readings          integer NOT NULL DEFAULT 1,
  ended_at          timestamptz,
  request_id        uuid REFERENCES maintenance_request(id),
  CHECK (ended_at IS NULL OR ended_at >= started_at)
);
CREATE UNIQUE INDEX condition_excursion_one_open ON condition_excursion (point_id) WHERE ended_at IS NULL;

CREATE TABLE visit_template (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenant(id),
  code        text NOT NULL,
  name        text NOT NULL,
  items       jsonb NOT NULL,       -- [{ area, text, critical }]
  active      boolean NOT NULL DEFAULT true,
  created_by  uuid NOT NULL REFERENCES app_user(id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, code),
  CHECK (jsonb_typeof(items) = 'array' AND jsonb_array_length(items) > 0)
);

CREATE TABLE site_visit (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenant(id),
  facility_id   uuid NOT NULL REFERENCES facility(id),
  number        text NOT NULL,
  template_id   uuid NOT NULL REFERENCES visit_template(id),
  title         text NOT NULL,
  visited_by    uuid NOT NULL REFERENCES app_user(id),
  visited_on    date NOT NULL,
  status        text NOT NULL DEFAULT 'in_progress' CHECK (status IN ('in_progress', 'completed', 'cancelled')),
  score         numeric(5, 4) CHECK (score BETWEEN 0 AND 1),
  critical_fails integer,
  summary       text,
  completed_at  timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, number),
  CHECK ((status = 'completed') = (completed_at IS NOT NULL))
);

CREATE TABLE site_visit_item (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenant(id),
  visit_id    uuid NOT NULL REFERENCES site_visit(id),
  seq         integer NOT NULL,
  area        text,
  text        text NOT NULL,
  critical    boolean NOT NULL DEFAULT false,
  result      text CHECK (result IN ('pass', 'fail', 'na')),
  note        text,
  asset_id    uuid REFERENCES asset(id),           -- a failed item about equipment or a space becomes a maintenance request
  request_id  uuid REFERENCES maintenance_request(id),
  UNIQUE (visit_id, seq)
);
CREATE FUNCTION site_visit_item_final() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (SELECT status FROM site_visit WHERE id = coalesce(NEW.visit_id, OLD.visit_id)) = 'completed'
     AND (TG_OP = 'DELETE' OR (NEW.result, NEW.note, NEW.asset_id) IS DISTINCT FROM (OLD.result, OLD.note, OLD.asset_id)) THEN
    RAISE EXCEPTION 'completed visits are final';
  END IF;
  RETURN coalesce(NEW, OLD);
END $$;
CREATE TRIGGER site_visit_item_final BEFORE UPDATE OR DELETE ON site_visit_item FOR EACH ROW EXECUTE FUNCTION site_visit_item_final();

ALTER TABLE action_item DROP CONSTRAINT action_item_subject_type_check;
ALTER TABLE action_item ADD CONSTRAINT action_item_subject_type_check CHECK (subject_type IN ('corrective_action', 'safety_incident', 'quality_audit', 'fmea', 'continuity_plan', 'site_visit'));
ALTER TABLE action_item ADD COLUMN site_visit_item_id uuid REFERENCES site_visit_item(id);
ALTER TABLE maintenance_request DROP CONSTRAINT maintenance_request_source_check;
ALTER TABLE maintenance_request ADD CONSTRAINT maintenance_request_source_check CHECK (source IN ('user', 'public', 'condition', 'visit'));
ALTER TABLE maintenance_request DROP CONSTRAINT maintenance_request_source;
ALTER TABLE maintenance_request ADD CONSTRAINT maintenance_request_source CHECK (source <> 'public' OR requester_name IS NOT NULL);

ALTER TABLE condition_point ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_facility ON condition_point USING (tenant_id = app_tenant_id() AND app_can_see_facility(facility_id)) WITH CHECK (tenant_id = app_tenant_id() AND app_can_see_facility(facility_id));
ALTER TABLE condition_reading ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_facility ON condition_reading USING (tenant_id = app_tenant_id() AND app_can_see_facility(facility_id)) WITH CHECK (tenant_id = app_tenant_id() AND app_can_see_facility(facility_id));
ALTER TABLE condition_excursion ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_facility ON condition_excursion USING (tenant_id = app_tenant_id() AND app_can_see_facility(facility_id)) WITH CHECK (tenant_id = app_tenant_id() AND app_can_see_facility(facility_id));
ALTER TABLE visit_template ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON visit_template USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());
ALTER TABLE site_visit ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_facility ON site_visit USING (tenant_id = app_tenant_id() AND app_can_see_facility(facility_id)) WITH CHECK (tenant_id = app_tenant_id() AND app_can_see_facility(facility_id));
ALTER TABLE site_visit_item ENABLE ROW LEVEL SECURITY;
CREATE POLICY via_parent ON site_visit_item USING (tenant_id = app_tenant_id() AND EXISTS (SELECT 1 FROM site_visit v WHERE v.id = visit_id))
  WITH CHECK (tenant_id = app_tenant_id() AND EXISTS (SELECT 1 FROM site_visit v WHERE v.id = visit_id));
GRANT SELECT, INSERT, UPDATE ON condition_point, condition_excursion, visit_template, site_visit, site_visit_item TO erp_app;
GRANT SELECT, INSERT ON condition_reading TO erp_app;

-- Permissions and a district manager role (existing tenants; new tenants get them from the templates).
UPDATE role SET permissions = (SELECT array_agg(DISTINCT p) FROM unnest(permissions || ARRAY['visits.view', 'visits.conduct']) p) WHERE key IN ('admin', 'property_manager', 'operations_manager');
UPDATE role SET permissions = (SELECT array_agg(DISTINCT p) FROM unnest(permissions || ARRAY['visits.view']) p) WHERE key IN ('store_manager', 'executive', 'maintenance_manager', 'quality_manager');
INSERT INTO role (tenant_id, key, name, permissions)
SELECT t.id, 'district_manager', 'District / Area Manager', ARRAY['org.view', 'employees.view', 'assets.view', 'assets.record_state', 'documents.view', 'work_orders.view',
  'work_orders.request', 'work_orders.manage', 'work_orders.verify', 'reports.view', 'reports.export', 'learning.view', 'qualifications.view', 'safety.report', 'safety.view',
  'quality.report', 'purchasing.view', 'ap.view', 'visits.view', 'visits.conduct']
FROM tenant t WHERE NOT EXISTS (SELECT 1 FROM role x WHERE x.tenant_id = t.id AND x.key = 'district_manager');
