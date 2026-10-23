-- SC-002 F4 Truck stock and tools in trucks.
ALTER TABLE stock_location DROP CONSTRAINT stock_location_kind_check;
ALTER TABLE stock_location ADD CONSTRAINT stock_location_kind_check CHECK (kind IN ('storeroom', 'staging', 'truck'));
ALTER TABLE vehicle_profile ADD COLUMN truck_location_id uuid REFERENCES stock_location(id);
CREATE INDEX ix_vehicle_truck_location ON vehicle_profile (truck_location_id) WHERE truck_location_id IS NOT NULL;

CREATE TABLE tool_checkout (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenant(id),
  facility_id      uuid NOT NULL REFERENCES facility(id),
  asset_id         uuid NOT NULL REFERENCES asset(id),
  employee_id      uuid NOT NULL REFERENCES employee(id),
  vehicle_id       uuid REFERENCES asset(id),
  checked_out_at   timestamptz NOT NULL DEFAULT now(),
  checked_out_by   uuid NOT NULL REFERENCES app_user(id),
  returned_at      timestamptz,
  returned_by      uuid REFERENCES app_user(id),
  note             text,
  CHECK (returned_at IS NULL OR returned_at >= checked_out_at)
);
CREATE UNIQUE INDEX ux_tool_open ON tool_checkout (asset_id) WHERE returned_at IS NULL;
CREATE INDEX ix_toolco_facility ON tool_checkout (facility_id);
CREATE INDEX ix_toolco_employee ON tool_checkout (employee_id);
CREATE INDEX ix_toolco_vehicle ON tool_checkout (vehicle_id) WHERE vehicle_id IS NOT NULL;
CREATE INDEX ix_toolco_out_by ON tool_checkout (checked_out_by);
CREATE INDEX ix_toolco_ret_by ON tool_checkout (returned_by) WHERE returned_by IS NOT NULL;
ALTER TABLE tool_checkout ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_facility ON tool_checkout USING (tenant_id = app_tenant_id() AND app_can_see_facility(facility_id)) WITH CHECK (tenant_id = app_tenant_id() AND app_can_see_facility(facility_id));
GRANT SELECT, INSERT, UPDATE ON tool_checkout TO erp_app;
