-- 0006 Shared approval engine + Management of Change (MOC).
-- The approval engine is generic (subject_type/subject_id) so purchasing, document control and others
-- reuse it. Steps are addressed to ROLES at the subject's facility; stages run sequentially, steps
-- within a stage in parallel. A material change to the subject supersedes the request (re-approval).

CREATE TABLE approval_request (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES tenant(id),
  facility_id       uuid REFERENCES facility(id),
  subject_type      text NOT NULL,
  subject_id        uuid NOT NULL,
  subject_revision  integer NOT NULL DEFAULT 1,
  purpose           text NOT NULL,                      -- e.g. 'moc.authorize', 'moc.startup'
  status            text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'superseded', 'cancelled')),
  requested_by      uuid NOT NULL REFERENCES app_user(id),
  distinct_approvers boolean NOT NULL DEFAULT true,     -- one person may not sign two steps of the same request
  created_at        timestamptz NOT NULL DEFAULT now(),
  decided_at        timestamptz
);
CREATE INDEX approval_request_subject ON approval_request (tenant_id, subject_type, subject_id, created_at);

CREATE TABLE approval_step (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenant(id),
  request_id   uuid NOT NULL REFERENCES approval_request(id),
  stage        integer NOT NULL,
  role_key     text NOT NULL,
  label        text NOT NULL,
  status       text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'skipped')),
  decided_by   uuid REFERENCES app_user(id),
  decided_at   timestamptz,
  comment      text,
  UNIQUE (request_id, stage, role_key)
);

-- Decisions are final.
CREATE FUNCTION approval_step_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'approval steps cannot be deleted'; END IF;
  IF OLD.status <> 'pending' THEN RAISE EXCEPTION 'approval decisions are final'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER approval_step_guard BEFORE UPDATE OR DELETE ON approval_step FOR EACH ROW EXECUTE FUNCTION approval_step_guard();

-- ---------------------------------------------------------------------------
-- Management of Change
-- ---------------------------------------------------------------------------
CREATE TABLE moc_change (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             uuid NOT NULL REFERENCES tenant(id),
  facility_id           uuid NOT NULL REFERENCES facility(id),
  number                text NOT NULL,
  title                 text NOT NULL,
  description           text NOT NULL,
  justification         text NOT NULL,
  change_type           text NOT NULL CHECK (change_type IN ('equipment', 'process', 'procedure', 'material', 'controls_software',
                                                             'organizational', 'facility', 'other')),
  is_temporary          boolean NOT NULL DEFAULT false,
  temporary_until       date,
  status                text NOT NULL DEFAULT 'draft'
                          CHECK (status IN ('draft', 'review', 'approved', 'startup_review', 'in_service', 'closed', 'rejected', 'cancelled')),
  revision              integer NOT NULL DEFAULT 1,
  screening             jsonb,                          -- answers to the screening questions
  screening_rules       text,                           -- rule-set version that produced risk/reviews
  risk_level            text CHECK (risk_level IN ('low', 'medium', 'high')),
  required_reviews      text[] NOT NULL DEFAULT '{}',   -- role keys
  pssr_required         boolean NOT NULL DEFAULT false, -- pre-startup safety review
  requested_by          uuid NOT NULL REFERENCES app_user(id),
  owner_user_id         uuid NOT NULL REFERENCES app_user(id),
  target_date           date,
  approved_at           timestamptz,
  in_service_at         timestamptz,
  closed_at             timestamptz,
  closure_note          text,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, number),
  CHECK (NOT is_temporary OR temporary_until IS NOT NULL)
);
CREATE TRIGGER moc_change_touch BEFORE UPDATE ON moc_change FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- What the change touches: assets, documents, courses, qualifications, parts.
CREATE TABLE moc_affected (
  tenant_id    uuid NOT NULL REFERENCES tenant(id),
  change_id    uuid NOT NULL REFERENCES moc_change(id),
  entity_type  text NOT NULL CHECK (entity_type IN ('asset', 'document', 'course', 'qualification', 'part')),
  entity_id    uuid NOT NULL,
  note         text,
  PRIMARY KEY (change_id, entity_type, entity_id)
);

-- Implementation plan. 'startup' actions must be done before the change goes into service.
CREATE TABLE moc_action (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenant(id),
  change_id        uuid NOT NULL REFERENCES moc_change(id),
  kind             text NOT NULL CHECK (kind IN ('document_update', 'training', 'work_order', 'hazard_review', 'inspection', 'communication', 'restore', 'other')),
  title            text NOT NULL,
  required_before  text NOT NULL CHECK (required_before IN ('startup', 'closeout')),
  owner_user_id    uuid REFERENCES app_user(id),
  due_on           date,
  document_id      uuid REFERENCES document(id),
  course_id        uuid REFERENCES course(id),
  work_order_id    uuid REFERENCES work_order(id),
  status           text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'done', 'cancelled')),
  generated        boolean NOT NULL DEFAULT false,      -- created by screening rules
  completed_by     uuid REFERENCES app_user(id),
  completed_at     timestamptz,
  completion_note  text,
  verification     jsonb,                               -- what the system checked when it was closed
  created_at       timestamptz NOT NULL DEFAULT now()
);

-- Pre-startup safety review checklist (one row per question, answered once per change revision).
CREATE TABLE moc_pssr_item (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenant(id),
  change_id     uuid NOT NULL REFERENCES moc_change(id),
  seq           integer NOT NULL,
  question      text NOT NULL,
  response      text CHECK (response IN ('yes', 'no', 'na')),
  note          text,
  responded_by  uuid REFERENCES app_user(id),
  responded_at  timestamptz,
  UNIQUE (change_id, seq)
);

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------
ALTER TABLE approval_request ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_facility ON approval_request USING (tenant_id = app_tenant_id() AND app_can_see_facility(facility_id))
  WITH CHECK (tenant_id = app_tenant_id() AND app_can_see_facility(facility_id));
ALTER TABLE approval_step ENABLE ROW LEVEL SECURITY;
CREATE POLICY via_parent ON approval_step
  USING (tenant_id = app_tenant_id() AND EXISTS (SELECT 1 FROM approval_request r WHERE r.id = request_id))
  WITH CHECK (tenant_id = app_tenant_id() AND EXISTS (SELECT 1 FROM approval_request r WHERE r.id = request_id));
ALTER TABLE moc_change ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_facility ON moc_change USING (tenant_id = app_tenant_id() AND app_can_see_facility(facility_id))
  WITH CHECK (tenant_id = app_tenant_id() AND app_can_see_facility(facility_id));
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['moc_affected', 'moc_action', 'moc_pssr_item']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY via_parent ON %I USING (tenant_id = app_tenant_id() AND EXISTS (SELECT 1 FROM moc_change c WHERE c.id = change_id)) WITH CHECK (tenant_id = app_tenant_id() AND EXISTS (SELECT 1 FROM moc_change c WHERE c.id = change_id))', t);
  END LOOP;
END $$;

GRANT SELECT, INSERT, UPDATE ON approval_request, approval_step, moc_change, moc_action, moc_pssr_item TO erp_app;
GRANT SELECT, INSERT, DELETE ON moc_affected TO erp_app;

-- New stock roles for existing tenants, plus MOC permissions on stock roles.
INSERT INTO role (tenant_id, key, name, permissions)
SELECT t.id, r.key, r.name, r.permissions FROM tenant t CROSS JOIN (VALUES
  ('operations_manager', 'Operations / Plant Manager', ARRAY['org.view', 'employees.view', 'assets.view', 'documents.view', 'documents.view_draft',
     'work_orders.view', 'reports.view', 'reports.export', 'learning.view', 'qualifications.view', 'moc.view', 'moc.request', 'moc.manage']),
  ('ehs_reviewer', 'EHS / Safety Reviewer', ARRAY['org.view', 'assets.view', 'documents.view', 'documents.view_draft', 'work_orders.view',
     'reports.view', 'learning.view', 'qualifications.view', 'moc.view', 'moc.request']),
  ('quality_reviewer', 'Quality Reviewer', ARRAY['org.view', 'assets.view', 'documents.view', 'documents.view_draft', 'work_orders.view',
     'reports.view', 'learning.view', 'qualifications.view', 'moc.view', 'moc.request'])
) AS r(key, name, permissions)
WHERE NOT EXISTS (SELECT 1 FROM role x WHERE x.tenant_id = t.id AND x.key = r.key);

UPDATE role SET permissions = (SELECT array_agg(DISTINCT p) FROM unnest(permissions || ARRAY['moc.view', 'moc.request', 'moc.manage']) p)
  WHERE key IN ('admin', 'maintenance_manager');
UPDATE role SET permissions = (SELECT array_agg(DISTINCT p) FROM unnest(permissions || ARRAY['moc.view', 'moc.request']) p)
  WHERE key IN ('technician', 'operator');
UPDATE role SET permissions = (SELECT array_agg(DISTINCT p) FROM unnest(permissions || ARRAY['moc.view']) p)
  WHERE key IN ('executive', 'trainer');
