-- S11d Consumables and chemicals in the material plan: how much of a part a work center uses per machine hour, per
-- unit made there, or a fixed quantity a month (bath changes, flushes, top-ups). Brief §12.7: production chemicals
-- and consumables are production consumption and cost, not asset maintenance cost.
CREATE TABLE consumption_rate (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenant(id),
  facility_id     uuid NOT NULL REFERENCES facility(id),
  work_center_id  uuid REFERENCES work_center(id),
  part_id         uuid NOT NULL REFERENCES part(id),
  basis           text NOT NULL CHECK (basis IN ('machine_hour', 'unit', 'month')),
  rate            numeric(20, 10) NOT NULL CHECK (rate > 0),
  note            text,
  active          boolean NOT NULL DEFAULT true,
  created_by      uuid NOT NULL REFERENCES app_user(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  CHECK (basis = 'month' OR work_center_id IS NOT NULL)
);
CREATE UNIQUE INDEX consumption_rate_one ON consumption_rate (facility_id, coalesce(work_center_id, '00000000-0000-0000-0000-000000000000'::uuid), part_id, basis) WHERE active;
ALTER TABLE consumption_rate ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_facility ON consumption_rate USING (tenant_id = app_tenant_id() AND app_can_see_facility(facility_id)) WITH CHECK (tenant_id = app_tenant_id() AND app_can_see_facility(facility_id));
GRANT SELECT, INSERT, UPDATE ON consumption_rate TO erp_app;
