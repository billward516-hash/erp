-- 0007 Inventory essentials (storerooms, stock ledger, counts) and preventive maintenance (plans, meters).
-- Stock quantities are changed ONLY by appending inventory_txn rows; the balance table is a
-- maintained projection, updated in the same transaction under a row lock.

CREATE TABLE stock_location (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenant(id),
  facility_id  uuid NOT NULL REFERENCES facility(id),
  code         text NOT NULL,
  name         text NOT NULL,
  active       boolean NOT NULL DEFAULT true,
  UNIQUE (tenant_id, code)
);

CREATE TABLE inventory_balance (
  tenant_id      uuid NOT NULL REFERENCES tenant(id),
  facility_id    uuid NOT NULL REFERENCES facility(id),
  location_id    uuid NOT NULL REFERENCES stock_location(id),
  part_id        uuid NOT NULL REFERENCES part(id),
  qty_on_hand    numeric(14, 3) NOT NULL DEFAULT 0 CHECK (qty_on_hand >= 0),
  bin            text,
  reorder_point  numeric(14, 3),
  reorder_qty    numeric(14, 3),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (location_id, part_id)
);

CREATE TABLE inventory_txn (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id      uuid NOT NULL REFERENCES tenant(id),
  facility_id    uuid NOT NULL REFERENCES facility(id),
  location_id    uuid NOT NULL REFERENCES stock_location(id),
  part_id        uuid NOT NULL REFERENCES part(id),
  txn_type       text NOT NULL CHECK (txn_type IN ('receipt', 'issue', 'return', 'adjustment', 'count', 'transfer_out', 'transfer_in', 'opening')),
  qty            numeric(14, 3) NOT NULL CHECK (qty <> 0),          -- signed: + into stock, - out of stock
  unit_cost      numeric(14, 4),
  balance_after  numeric(14, 3) NOT NULL,
  work_order_id  uuid REFERENCES work_order(id),
  count_id       uuid,
  reference      text,                                             -- packing slip, PO, transfer id
  reason         text,
  created_by     uuid NOT NULL REFERENCES app_user(id),
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX inventory_txn_part ON inventory_txn (tenant_id, part_id, created_at);
CREATE INDEX inventory_txn_wo ON inventory_txn (work_order_id) WHERE work_order_id IS NOT NULL;

CREATE FUNCTION inventory_txn_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'inventory transactions are append-only; post a correcting transaction';
END $$;
CREATE TRIGGER inventory_txn_immutable BEFORE UPDATE OR DELETE ON inventory_txn FOR EACH ROW EXECUTE FUNCTION inventory_txn_immutable();

CREATE TABLE inventory_count (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenant(id),
  facility_id  uuid NOT NULL REFERENCES facility(id),
  location_id  uuid NOT NULL REFERENCES stock_location(id),
  status       text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'posted', 'cancelled')),
  note         text,
  created_by   uuid NOT NULL REFERENCES app_user(id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  posted_by    uuid REFERENCES app_user(id),
  posted_at    timestamptz
);
ALTER TABLE inventory_txn ADD CONSTRAINT inventory_txn_count_fk FOREIGN KEY (count_id) REFERENCES inventory_count(id);

CREATE TABLE inventory_count_line (
  tenant_id     uuid NOT NULL REFERENCES tenant(id),
  count_id      uuid NOT NULL REFERENCES inventory_count(id),
  part_id       uuid NOT NULL REFERENCES part(id),
  expected_qty  numeric(14, 3) NOT NULL,       -- snapshot when the count was opened
  counted_qty   numeric(14, 3) CHECK (counted_qty >= 0),
  counted_by    uuid REFERENCES app_user(id),
  counted_at    timestamptz,
  PRIMARY KEY (count_id, part_id)
);

-- Issued stock on a work-order part line is traceable to its ledger rows.
ALTER TABLE work_order_part ADD COLUMN location_id uuid REFERENCES stock_location(id);

-- ---------------------------------------------------------------------------
-- Preventive maintenance
-- ---------------------------------------------------------------------------
CREATE TABLE asset_meter_reading (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id    uuid NOT NULL REFERENCES tenant(id),
  facility_id  uuid NOT NULL REFERENCES facility(id),
  asset_id     uuid NOT NULL REFERENCES asset(id),
  meter        text NOT NULL,                  -- e.g. 'run_hours', 'cycles'
  value        numeric(14, 2) NOT NULL CHECK (value >= 0),
  read_at      timestamptz NOT NULL DEFAULT now(),
  source       text NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'import', 'telemetry')),
  recorded_by  uuid REFERENCES app_user(id)
);
CREATE INDEX asset_meter_reading_latest ON asset_meter_reading (asset_id, meter, read_at DESC);

CREATE TABLE pm_plan (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid NOT NULL REFERENCES tenant(id),
  facility_id        uuid NOT NULL REFERENCES facility(id),
  asset_id           uuid NOT NULL REFERENCES asset(id),
  code               text NOT NULL,
  title              text NOT NULL,
  instructions       text,
  trigger_type       text NOT NULL CHECK (trigger_type IN ('calendar', 'meter')),
  interval_days      integer CHECK (interval_days > 0),
  meter              text,
  interval_meter     numeric(14, 2) CHECK (interval_meter > 0),
  schedule_basis     text NOT NULL DEFAULT 'completion' CHECK (schedule_basis IN ('completion', 'fixed')),
  lead_days          integer NOT NULL DEFAULT 7 CHECK (lead_days >= 0),
  lead_meter         numeric(14, 2) NOT NULL DEFAULT 0 CHECK (lead_meter >= 0),
  next_due_on        date,                     -- calendar plans
  next_due_meter     numeric(14, 2),           -- meter plans
  last_done_on       date,
  last_done_meter    numeric(14, 2),
  estimated_hours    numeric(8, 2),
  priority           smallint NOT NULL DEFAULT 3 CHECK (priority BETWEEN 1 AND 4),
  document_id        uuid REFERENCES document(id),
  active             boolean NOT NULL DEFAULT true,
  created_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, code),
  CHECK ((trigger_type = 'calendar' AND interval_days IS NOT NULL AND next_due_on IS NOT NULL)
      OR (trigger_type = 'meter' AND meter IS NOT NULL AND interval_meter IS NOT NULL AND next_due_meter IS NOT NULL))
);

-- Reference parts list (the PM's expected parts). Actual consumption is recorded on the work order.
CREATE TABLE pm_plan_part (
  tenant_id  uuid NOT NULL REFERENCES tenant(id),
  plan_id    uuid NOT NULL REFERENCES pm_plan(id),
  part_id    uuid NOT NULL REFERENCES part(id),
  qty        numeric(12, 3) NOT NULL CHECK (qty > 0),
  PRIMARY KEY (plan_id, part_id)
);

ALTER TABLE work_order ADD COLUMN pm_plan_id uuid REFERENCES pm_plan(id);
ALTER TABLE work_order ADD COLUMN pm_due_meter numeric(14, 2);
-- At most one open work order per PM plan, so generation can run repeatedly without duplicates.
CREATE UNIQUE INDEX work_order_one_open_pm ON work_order (pm_plan_id)
  WHERE pm_plan_id IS NOT NULL AND status IN ('planned', 'scheduled', 'in_progress', 'on_hold', 'completed');

-- ---------------------------------------------------------------------------
-- RLS and grants
-- ---------------------------------------------------------------------------
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['stock_location', 'inventory_balance', 'inventory_txn', 'inventory_count', 'asset_meter_reading', 'pm_plan']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_facility ON %I USING (tenant_id = app_tenant_id() AND app_can_see_facility(facility_id)) WITH CHECK (tenant_id = app_tenant_id() AND app_can_see_facility(facility_id))', t);
  END LOOP;
END $$;
ALTER TABLE inventory_count_line ENABLE ROW LEVEL SECURITY;
CREATE POLICY via_parent ON inventory_count_line
  USING (tenant_id = app_tenant_id() AND EXISTS (SELECT 1 FROM inventory_count c WHERE c.id = count_id))
  WITH CHECK (tenant_id = app_tenant_id() AND EXISTS (SELECT 1 FROM inventory_count c WHERE c.id = count_id));
ALTER TABLE pm_plan_part ENABLE ROW LEVEL SECURITY;
CREATE POLICY via_parent ON pm_plan_part
  USING (tenant_id = app_tenant_id() AND EXISTS (SELECT 1 FROM pm_plan p WHERE p.id = plan_id))
  WITH CHECK (tenant_id = app_tenant_id() AND EXISTS (SELECT 1 FROM pm_plan p WHERE p.id = plan_id));

GRANT SELECT, INSERT, UPDATE ON stock_location, inventory_balance, inventory_count, inventory_count_line, pm_plan TO erp_app;
GRANT SELECT, INSERT ON inventory_txn, asset_meter_reading TO erp_app;
GRANT SELECT, INSERT, DELETE ON pm_plan_part TO erp_app;

UPDATE role SET permissions = (SELECT array_agg(DISTINCT p) FROM unnest(permissions || ARRAY['inventory.view', 'inventory.manage']) p)
  WHERE key IN ('admin', 'maintenance_manager');
UPDATE role SET permissions = (SELECT array_agg(DISTINCT p) FROM unnest(permissions || ARRAY['inventory.view']) p)
  WHERE key IN ('technician', 'executive', 'operations_manager');
