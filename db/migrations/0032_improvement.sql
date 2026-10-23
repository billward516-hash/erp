-- S14b Continuous-improvement tracking: ideas and projects with a metric measured from the records (or entered), a
-- baseline and the result after, and savings estimated by the owner and validated by someone else.
CREATE TABLE improvement (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL REFERENCES tenant(id),
  facility_id         uuid NOT NULL REFERENCES facility(id),
  number              text NOT NULL,
  title               text NOT NULL,
  problem             text NOT NULL,
  idea                text,
  category            text NOT NULL CHECK (category IN ('safety', 'quality', 'cost', 'delivery', 'maintenance', 'energy', 'workplace', 'other')),
  stage               text NOT NULL DEFAULT 'idea' CHECK (stage IN ('idea', 'approved', 'in_progress', 'measuring', 'closed', 'rejected')),
  submitted_by        uuid NOT NULL REFERENCES app_user(id),
  owner_user_id       uuid REFERENCES app_user(id),
  asset_id            uuid REFERENCES asset(id),
  work_center_id      uuid REFERENCES work_center(id),
  -- What is measured: from the records (downtime of an asset, scrap at a work center) or entered by hand.
  metric_kind         text NOT NULL DEFAULT 'manual' CHECK (metric_kind IN ('manual', 'asset_unplanned_downtime', 'work_center_scrap_rate')),
  metric_name         text,
  metric_unit         text,
  lower_is_better     boolean NOT NULL DEFAULT true,
  baseline_value      numeric(18, 6),
  baseline_from       date,
  baseline_to         date,
  target_value        numeric(18, 6),
  implemented_on      date,
  result_value        numeric(18, 6),
  result_from         date,
  result_to           date,
  est_annual_savings  numeric(14, 2),
  one_time_cost       numeric(14, 2),
  validated_savings   numeric(14, 2),
  validated_by        uuid REFERENCES app_user(id),
  validated_at        timestamptz,
  validation_note     text,
  decision_note       text,
  decided_by          uuid REFERENCES app_user(id),
  closed_at           timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, number),
  CHECK (metric_kind <> 'asset_unplanned_downtime' OR asset_id IS NOT NULL),
  CHECK (metric_kind <> 'work_center_scrap_rate' OR work_center_id IS NOT NULL),
  CHECK (validated_by IS NULL OR validated_by <> owner_user_id)
);
ALTER TABLE improvement ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_facility ON improvement USING (tenant_id = app_tenant_id() AND app_can_see_facility(facility_id)) WITH CHECK (tenant_id = app_tenant_id() AND app_can_see_facility(facility_id));
GRANT SELECT, INSERT, UPDATE ON improvement TO erp_app;

ALTER TABLE action_item DROP CONSTRAINT action_item_subject_type_check;
ALTER TABLE action_item ADD CONSTRAINT action_item_subject_type_check CHECK (subject_type IN ('corrective_action', 'safety_incident', 'quality_audit', 'fmea', 'continuity_plan', 'site_visit', 'improvement'));

-- Anyone may suggest an improvement; leads approve, own and validate them.
UPDATE role SET permissions = (SELECT array_agg(DISTINCT p) FROM unnest(permissions || ARRAY['improve.submit']) p);
UPDATE role SET permissions = (SELECT array_agg(DISTINCT p) FROM unnest(permissions || ARRAY['improve.manage']) p)
  WHERE key IN ('admin', 'maintenance_manager', 'operations_manager', 'production_supervisor', 'quality_manager', 'executive');
