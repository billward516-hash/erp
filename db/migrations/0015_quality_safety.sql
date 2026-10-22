-- 0015 Quality and safety foundation: nonconformances (NCR) with containment and disposition, corrective
-- actions (CAPA) with root cause and an independent effectiveness check, safety incidents and near misses with
-- privacy for the people involved, and one shared action tracker used by CAPAs and incidents.

CREATE TABLE corrective_action (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL REFERENCES tenant(id),
  facility_id         uuid NOT NULL REFERENCES facility(id),
  number              text NOT NULL,
  title               text NOT NULL,
  problem             text NOT NULL,
  source              text NOT NULL CHECK (source IN ('nonconformance', 'incident', 'customer_complaint', 'audit', 'internal')),
  priority            text NOT NULL DEFAULT 'medium' CHECK (priority IN ('low', 'medium', 'high')),
  status              text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'root_cause', 'actions', 'verification', 'closed', 'cancelled')),
  owner_user_id       uuid NOT NULL REFERENCES app_user(id),
  due_date            date,
  containment         text,
  root_cause_method   text CHECK (root_cause_method IN ('five_whys', 'fishbone', 'eight_d', 'other')),
  root_cause          text,
  verify_after        date,                     -- when to check the actions worked
  effectiveness_note  text,
  effective           boolean,
  verified_by         uuid REFERENCES app_user(id),
  verified_at         timestamptz,
  cancel_reason       text,
  created_by          uuid NOT NULL REFERENCES app_user(id),
  created_at          timestamptz NOT NULL DEFAULT now(),
  closed_at           timestamptz,
  UNIQUE (tenant_id, number),
  CHECK (verified_by IS NULL OR verified_by <> owner_user_id)
);

CREATE TABLE nonconformance (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            uuid NOT NULL REFERENCES tenant(id),
  facility_id          uuid NOT NULL REFERENCES facility(id),
  number               text NOT NULL,
  source               text NOT NULL CHECK (source IN ('production', 'receiving', 'customer', 'supplier', 'internal')),
  title                text NOT NULL,
  description          text NOT NULL,
  severity             text NOT NULL DEFAULT 'minor' CHECK (severity IN ('minor', 'major', 'critical')),
  status               text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'contained', 'dispositioned', 'closed', 'cancelled')),
  part_id              uuid REFERENCES part(id),
  qty                  numeric(14, 3) CHECK (qty > 0),
  production_order_id  uuid REFERENCES production_order(id),
  production_entry_id  uuid REFERENCES production_entry(id),
  purchase_order_id    uuid REFERENCES purchase_order(id),
  supplier_id          uuid REFERENCES supplier(id),
  customer_id          uuid REFERENCES customer(id),
  sales_order_id       uuid REFERENCES sales_order(id),
  asset_id             uuid REFERENCES asset(id),
  containment          text,
  contained_by         uuid REFERENCES app_user(id),
  contained_at         timestamptz,
  disposition          text CHECK (disposition IN ('use_as_is', 'rework', 'repair', 'scrap', 'return_to_supplier')),
  disposition_reason   text,
  cost                 numeric(14, 2),          -- cost of the nonconformance (scrap at standard cost, rework estimate…)
  dispositioned_by     uuid REFERENCES app_user(id),
  dispositioned_at     timestamptz,
  capa_id              uuid REFERENCES corrective_action(id),
  cancel_reason        text,
  reported_by          uuid NOT NULL REFERENCES app_user(id),
  created_at           timestamptz NOT NULL DEFAULT now(),
  closed_by            uuid REFERENCES app_user(id),
  closed_at            timestamptz,
  UNIQUE (tenant_id, number)
);
CREATE UNIQUE INDEX nonconformance_one_per_entry ON nonconformance (production_entry_id) WHERE production_entry_id IS NOT NULL AND status <> 'cancelled';

CREATE TABLE safety_incident (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            uuid NOT NULL REFERENCES tenant(id),
  facility_id          uuid NOT NULL REFERENCES facility(id),
  number               text NOT NULL,
  kind                 text NOT NULL CHECK (kind IN ('near_miss', 'first_aid', 'injury', 'illness', 'property_damage', 'environmental')),
  occurred_at          timestamptz NOT NULL,
  location             text,
  asset_id             uuid REFERENCES asset(id),
  description          text NOT NULL,
  immediate_actions    text,
  status               text NOT NULL DEFAULT 'reported' CHECK (status IN ('reported', 'investigating', 'actions', 'closed')),
  severity             text CHECK (severity IN ('low', 'medium', 'high', 'serious')),
  -- Restricted to safety staff (privacy of the people involved).
  involved_employee_id uuid REFERENCES employee(id),
  injury_description   text,
  medical_treatment    boolean,                 -- beyond first aid
  days_away            integer CHECK (days_away >= 0),
  days_restricted      integer CHECK (days_restricted >= 0),
  recordable           boolean,                 -- the safety team's determination, not computed
  root_cause           text,
  contributing_factors text,
  capa_id              uuid REFERENCES corrective_action(id),
  reported_by          uuid NOT NULL REFERENCES app_user(id),
  created_at           timestamptz NOT NULL DEFAULT now(),
  classified_by        uuid REFERENCES app_user(id),
  closed_by            uuid REFERENCES app_user(id),
  closed_at            timestamptz,
  UNIQUE (tenant_id, number)
);

-- Shared action tracker: CAPA actions and incident actions (later: audits, FMEA).
CREATE TABLE action_item (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenant(id),
  facility_id      uuid NOT NULL REFERENCES facility(id),
  subject_type     text NOT NULL CHECK (subject_type IN ('corrective_action', 'safety_incident')),
  subject_id       uuid NOT NULL,
  title            text NOT NULL,
  owner_user_id    uuid NOT NULL REFERENCES app_user(id),
  due_date         date NOT NULL,
  status           text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'done', 'cancelled')),
  completion_note  text,
  completed_by     uuid REFERENCES app_user(id),
  completed_at     timestamptz,
  created_by       uuid NOT NULL REFERENCES app_user(id),
  created_at       timestamptz NOT NULL DEFAULT now(),
  CHECK (status <> 'done' OR completion_note IS NOT NULL)
);
CREATE INDEX action_item_subject ON action_item (subject_type, subject_id);
CREATE INDEX action_item_owner_open ON action_item (owner_user_id) WHERE status = 'open';

DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['corrective_action', 'nonconformance', 'safety_incident', 'action_item'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_facility ON %I USING (tenant_id = app_tenant_id() AND app_can_see_facility(facility_id)) WITH CHECK (tenant_id = app_tenant_id() AND app_can_see_facility(facility_id))', t);
  END LOOP;
END $$;
GRANT SELECT, INSERT, UPDATE ON corrective_action, nonconformance, safety_incident, action_item TO erp_app;

-- Roles.
INSERT INTO role (tenant_id, key, name, permissions)
SELECT t.id, 'quality_manager', 'Quality Manager',
  ARRAY['org.view', 'employees.view', 'assets.view', 'documents.view', 'documents.view_draft', 'documents.manage', 'parts.view', 'inventory.view', 'work_orders.view',
        'reports.view', 'reports.export', 'learning.view', 'qualifications.view', 'moc.view', 'moc.request', 'purchasing.view', 'crm.view', 'sales.view',
        'production.view', 'quality.view', 'quality.report', 'quality.manage', 'safety.report']
FROM tenant t WHERE NOT EXISTS (SELECT 1 FROM role x WHERE x.tenant_id = t.id AND x.key = 'quality_manager');
UPDATE role SET permissions = (SELECT array_agg(DISTINCT p) FROM unnest(permissions || ARRAY['quality.view', 'quality.report', 'quality.manage', 'safety.report', 'safety.view', 'safety.manage']) p) WHERE key = 'admin';
UPDATE role SET permissions = (SELECT array_agg(DISTINCT p) FROM unnest(permissions || ARRAY['quality.view', 'quality.report', 'quality.manage', 'safety.report']) p) WHERE key = 'quality_reviewer';
UPDATE role SET permissions = (SELECT array_agg(DISTINCT p) FROM unnest(permissions || ARRAY['safety.report', 'safety.view', 'safety.manage', 'quality.view']) p) WHERE key = 'ehs_reviewer';
UPDATE role SET permissions = (SELECT array_agg(DISTINCT p) FROM unnest(permissions || ARRAY['quality.view', 'quality.report', 'safety.report', 'safety.view']) p) WHERE key IN ('operations_manager', 'production_supervisor', 'maintenance_manager');
UPDATE role SET permissions = (SELECT array_agg(DISTINCT p) FROM unnest(permissions || ARRAY['quality.report', 'safety.report']) p) WHERE key IN ('operator', 'technician');
UPDATE role SET permissions = (SELECT array_agg(DISTINCT p) FROM unnest(permissions || ARRAY['quality.view', 'quality.report']) p) WHERE key = 'buyer';
UPDATE role SET permissions = (SELECT array_agg(DISTINCT p) FROM unnest(permissions || ARRAY['quality.view', 'safety.view']) p) WHERE key = 'executive';
