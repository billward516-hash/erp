-- S12a Statistical process control (brief §12.7, Category 2 Advanced Quality): characteristics measured on a part,
-- operation, machine and gauge; subgroups of measurements (append-only values); control limits set from a baseline
-- and kept as history; signals from the control-chart rules with their investigation.

CREATE TABLE spc_characteristic (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenant(id),
  facility_id     uuid NOT NULL REFERENCES facility(id),
  code            text NOT NULL,
  name            text NOT NULL,
  part_id         uuid REFERENCES part(id),
  op_no           integer,
  work_center_id  uuid REFERENCES work_center(id),
  asset_id        uuid REFERENCES asset(id),          -- the machine making the feature
  gauge_asset_id  uuid REFERENCES asset(id),          -- the instrument measuring it (calibration checked)
  unit            text NOT NULL DEFAULT 'mm',
  nominal         numeric(18, 6),
  lsl             numeric(18, 6),
  usl             numeric(18, 6),
  subgroup_size   integer NOT NULL CHECK (subgroup_size BETWEEN 1 AND 10),
  frequency       text,                                -- e.g. "5 consecutive parts every 2 hours"
  active          boolean NOT NULL DEFAULT true,
  created_by      uuid NOT NULL REFERENCES app_user(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, code),
  CHECK (lsl IS NULL OR usl IS NULL OR lsl < usl)
);

-- Control limits in force are the latest row; earlier rows are the history of recalculations.
CREATE TABLE spc_limit (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES tenant(id),
  characteristic_id uuid NOT NULL REFERENCES spc_characteristic(id),
  center            numeric(18, 6) NOT NULL,
  ucl               numeric(18, 6) NOT NULL,
  lcl               numeric(18, 6) NOT NULL,
  range_center      numeric(18, 6) NOT NULL,
  range_ucl         numeric(18, 6) NOT NULL,
  range_lcl         numeric(18, 6) NOT NULL,
  sigma             numeric(18, 8) NOT NULL,
  subgroups         integer NOT NULL,
  from_at           timestamptz NOT NULL,
  to_at             timestamptz NOT NULL,
  reason            text NOT NULL,
  set_by            uuid NOT NULL REFERENCES app_user(id),
  set_at            timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX spc_limit_char ON spc_limit (characteristic_id, set_at DESC);

CREATE TABLE spc_subgroup (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL REFERENCES tenant(id),
  facility_id         uuid NOT NULL REFERENCES facility(id),
  characteristic_id   uuid NOT NULL REFERENCES spc_characteristic(id),
  measured_at         timestamptz NOT NULL,
  vals                numeric(18, 6)[] NOT NULL CHECK (cardinality(vals) BETWEEN 1 AND 10),
  production_order_id uuid REFERENCES production_order(id),
  lot                 text,
  note                text,
  source              text NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'import')),
  excluded            boolean NOT NULL DEFAULT false,  -- assignable cause found: left out of limit calculations
  exclude_reason      text,
  recorded_by         uuid NOT NULL REFERENCES app_user(id),
  created_at          timestamptz NOT NULL DEFAULT now(),
  CHECK (NOT excluded OR exclude_reason IS NOT NULL)
);
CREATE INDEX spc_subgroup_char ON spc_subgroup (characteristic_id, measured_at);

-- Measurements are evidence: values, time and context never change; only the exclusion can be set.
CREATE FUNCTION spc_subgroup_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'measurements cannot be deleted; exclude the subgroup with a reason'; END IF;
  IF NEW.vals IS DISTINCT FROM OLD.vals OR NEW.measured_at IS DISTINCT FROM OLD.measured_at OR NEW.characteristic_id IS DISTINCT FROM OLD.characteristic_id
     OR NEW.production_order_id IS DISTINCT FROM OLD.production_order_id OR NEW.lot IS DISTINCT FROM OLD.lot THEN
    RAISE EXCEPTION 'measurements cannot be changed; exclude the subgroup with a reason and record it again';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER spc_subgroup_guard BEFORE UPDATE OR DELETE ON spc_subgroup FOR EACH ROW EXECUTE FUNCTION spc_subgroup_guard();

CREATE TABLE spc_signal (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES tenant(id),
  facility_id       uuid NOT NULL REFERENCES facility(id),
  characteristic_id uuid NOT NULL REFERENCES spc_characteristic(id),
  subgroup_id       uuid NOT NULL REFERENCES spc_subgroup(id),
  rule              text NOT NULL CHECK (rule IN ('beyond_limits', 'run_of_9', 'trend_of_6', 'two_of_three', 'range_beyond', 'out_of_spec')),
  chart             text NOT NULL CHECK (chart IN ('x', 'r', 'spec')),
  detail            text NOT NULL,
  status            text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
  cause             text,
  response          text,
  ncr_id            uuid REFERENCES nonconformance(id),
  responded_by      uuid REFERENCES app_user(id),
  responded_at      timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (subgroup_id, rule, chart)
);
CREATE INDEX spc_signal_open ON spc_signal (characteristic_id) WHERE status = 'open';

ALTER TABLE spc_characteristic ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_facility ON spc_characteristic USING (tenant_id = app_tenant_id() AND app_can_see_facility(facility_id)) WITH CHECK (tenant_id = app_tenant_id() AND app_can_see_facility(facility_id));
ALTER TABLE spc_limit ENABLE ROW LEVEL SECURITY;
CREATE POLICY via_parent ON spc_limit USING (tenant_id = app_tenant_id() AND EXISTS (SELECT 1 FROM spc_characteristic c WHERE c.id = characteristic_id))
  WITH CHECK (tenant_id = app_tenant_id() AND EXISTS (SELECT 1 FROM spc_characteristic c WHERE c.id = characteristic_id));
ALTER TABLE spc_subgroup ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_facility ON spc_subgroup USING (tenant_id = app_tenant_id() AND app_can_see_facility(facility_id)) WITH CHECK (tenant_id = app_tenant_id() AND app_can_see_facility(facility_id));
ALTER TABLE spc_signal ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_facility ON spc_signal USING (tenant_id = app_tenant_id() AND app_can_see_facility(facility_id)) WITH CHECK (tenant_id = app_tenant_id() AND app_can_see_facility(facility_id));

GRANT SELECT, INSERT, UPDATE ON spc_characteristic, spc_subgroup, spc_signal TO erp_app;
GRANT SELECT, INSERT ON spc_limit TO erp_app;
