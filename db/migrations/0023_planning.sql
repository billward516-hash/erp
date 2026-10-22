-- 0023 Demand, capacity and material planning (S11a), the first slice of the brief's §12.8 engine.
-- Customer forecasts are versioned per customer and site; firm sales orders consume them by month. The plan itself
-- is computed on demand (deterministic, nothing stored), from forecasts, orders, stock, open production and purchase
-- orders, routings, BOMs, work-center calendars and demonstrated performance. Scenarios store only their adjustments.

ALTER TABLE work_center ADD COLUMN hours_per_week numeric(6, 1) CHECK (hours_per_week > 0 AND hours_per_week <= 168);  -- scheduled hours per machine or crew
ALTER TABLE work_center ADD COLUMN units integer CHECK (units > 0);   -- machines or crews working in parallel; NULL = its machines (or 1)

CREATE TABLE customer_forecast (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenant(id),
  facility_id   uuid NOT NULL REFERENCES facility(id),
  customer_id   uuid NOT NULL REFERENCES customer(id),
  version       integer NOT NULL CHECK (version > 0),
  status        text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'active', 'superseded')),
  received_on   date NOT NULL DEFAULT current_date,
  source        text NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'import')),
  notes         text,
  created_by    uuid NOT NULL REFERENCES app_user(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  activated_at  timestamptz,
  UNIQUE (facility_id, customer_id, version)
);
CREATE UNIQUE INDEX customer_forecast_one_active ON customer_forecast (facility_id, customer_id) WHERE status = 'active';
CREATE UNIQUE INDEX customer_forecast_one_draft ON customer_forecast (facility_id, customer_id) WHERE status = 'draft';

CREATE TABLE customer_forecast_line (
  tenant_id    uuid NOT NULL REFERENCES tenant(id),
  forecast_id  uuid NOT NULL REFERENCES customer_forecast(id),
  part_id      uuid NOT NULL REFERENCES part(id),
  period       date NOT NULL CHECK (extract(day FROM period) = 1),
  qty          numeric(14, 3) NOT NULL CHECK (qty >= 0),
  PRIMARY KEY (forecast_id, part_id, period)
);
CREATE FUNCTION customer_forecast_frozen() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (SELECT status FROM customer_forecast WHERE id = coalesce(NEW.forecast_id, OLD.forecast_id)) <> 'draft' THEN
    RAISE EXCEPTION 'an active or superseded forecast cannot change; load a new version';
  END IF;
  RETURN coalesce(NEW, OLD);
END $$;
CREATE TRIGGER customer_forecast_line_frozen BEFORE INSERT OR UPDATE OR DELETE ON customer_forecast_line FOR EACH ROW EXECUTE FUNCTION customer_forecast_frozen();

CREATE TABLE planning_scenario (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenant(id),
  facility_id     uuid NOT NULL REFERENCES facility(id),
  name            text NOT NULL,
  demand_pct      numeric(6, 2) NOT NULL DEFAULT 0 CHECK (demand_pct > -100 AND demand_pct <= 500),   -- applied to forecast, not to firm orders
  adjustments     jsonb NOT NULL DEFAULT '[]',   -- [{ workCenterId, extraHoursPerWeek, extraUnits }]
  notes           text,
  created_by      uuid NOT NULL REFERENCES app_user(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  CHECK (jsonb_typeof(adjustments) = 'array')
);

ALTER TABLE customer_forecast ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_facility ON customer_forecast USING (tenant_id = app_tenant_id() AND app_can_see_facility(facility_id)) WITH CHECK (tenant_id = app_tenant_id() AND app_can_see_facility(facility_id));
ALTER TABLE customer_forecast_line ENABLE ROW LEVEL SECURITY;
CREATE POLICY via_parent ON customer_forecast_line USING (tenant_id = app_tenant_id() AND EXISTS (SELECT 1 FROM customer_forecast f WHERE f.id = forecast_id))
  WITH CHECK (tenant_id = app_tenant_id() AND EXISTS (SELECT 1 FROM customer_forecast f WHERE f.id = forecast_id));
ALTER TABLE planning_scenario ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_facility ON planning_scenario USING (tenant_id = app_tenant_id() AND app_can_see_facility(facility_id)) WITH CHECK (tenant_id = app_tenant_id() AND app_can_see_facility(facility_id));
GRANT SELECT, INSERT, UPDATE ON customer_forecast, planning_scenario TO erp_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON customer_forecast_line TO erp_app;
GRANT DELETE ON planning_scenario TO erp_app;

UPDATE role SET permissions = (SELECT array_agg(DISTINCT p) FROM unnest(permissions || ARRAY['planning.view', 'planning.manage']) p) WHERE key IN ('admin', 'production_supervisor', 'operations_manager');
UPDATE role SET permissions = (SELECT array_agg(DISTINCT p) FROM unnest(permissions || ARRAY['planning.view']) p) WHERE key IN ('executive', 'sales_manager', 'buyer', 'maintenance_manager');
