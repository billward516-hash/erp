-- S12b Attribute control charts: p (fraction defective, sample size may vary), np (number defective, fixed sample),
-- c (defects per inspection unit of fixed size), u (defects per unit, size may vary). A subgroup's count is vals[1];
-- its sample size (parts inspected, or units of area/length for c and u) is sample_size.
ALTER TABLE spc_characteristic ADD COLUMN chart_type text NOT NULL DEFAULT 'variables' CHECK (chart_type IN ('variables', 'p', 'np', 'c', 'u'));
ALTER TABLE spc_characteristic ADD COLUMN sample_size numeric(14, 3) CHECK (sample_size > 0);
ALTER TABLE spc_characteristic ADD CONSTRAINT spc_attribute_shape CHECK (chart_type = 'variables' OR subgroup_size = 1);
ALTER TABLE spc_characteristic ADD CONSTRAINT spc_np_needs_n CHECK (chart_type <> 'np' OR sample_size IS NOT NULL);
ALTER TABLE spc_subgroup ADD COLUMN sample_size numeric(14, 3) CHECK (sample_size > 0);

CREATE OR REPLACE FUNCTION spc_subgroup_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'measurements cannot be deleted; exclude the subgroup with a reason'; END IF;
  IF NEW.vals IS DISTINCT FROM OLD.vals OR NEW.measured_at IS DISTINCT FROM OLD.measured_at OR NEW.characteristic_id IS DISTINCT FROM OLD.characteristic_id
     OR NEW.production_order_id IS DISTINCT FROM OLD.production_order_id OR NEW.lot IS DISTINCT FROM OLD.lot OR NEW.sample_size IS DISTINCT FROM OLD.sample_size THEN
    RAISE EXCEPTION 'measurements cannot be changed; exclude the subgroup with a reason and record it again';
  END IF;
  RETURN NEW;
END $$;
