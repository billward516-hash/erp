-- S20 Lot and serial tracking (D-147), opt-in per part (brief §12.7: "basic optional item lot/serial fields and
-- transaction linkage when selected"). A tracked part's stock is held per lot (or per serial, quantity one) as well as
-- per storeroom, and every movement records the lots it moved. Full multi-level genealogy and recall campaigns are
-- out of scope; tracing follows production orders and shipments one level at a time.
ALTER TABLE part ADD COLUMN tracking text NOT NULL DEFAULT 'none' CHECK (tracking IN ('none', 'lot', 'serial'));
ALTER TABLE part ADD COLUMN shelf_life_days integer CHECK (shelf_life_days > 0);

CREATE TABLE stock_lot (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL REFERENCES tenant(id),
  part_id             uuid NOT NULL REFERENCES part(id),
  number              text NOT NULL CHECK (length(number) BETWEEN 1 AND 60),
  kind                text NOT NULL CHECK (kind IN ('lot', 'serial')),
  status              text NOT NULL DEFAULT 'available' CHECK (status IN ('available', 'hold', 'scrapped')),
  hold_reason         text,
  expires_on          date,
  made_on             date,                                  -- manufacture or receipt date
  supplier_id         uuid REFERENCES supplier(id),
  supplier_lot        text,
  source              text NOT NULL CHECK (source IN ('receipt', 'production', 'opening', 'return', 'count', 'adjustment')),
  production_order_id uuid REFERENCES production_order(id),  -- the order that made it
  nonconformance_id   uuid,                                   -- the nonconformance that put it on hold
  created_by          uuid NOT NULL REFERENCES app_user(id),
  created_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, part_id, number)
);
CREATE INDEX stock_lot_expiry ON stock_lot (tenant_id, expires_on) WHERE status = 'available' AND expires_on IS NOT NULL;

-- On hand per lot and storeroom. For a tracked part these always add up to inventory_balance (checked in postTxn).
CREATE TABLE lot_balance (
  tenant_id     uuid NOT NULL REFERENCES tenant(id),
  facility_id   uuid NOT NULL REFERENCES facility(id),
  location_id   uuid NOT NULL REFERENCES stock_location(id),
  lot_id        uuid NOT NULL REFERENCES stock_lot(id),
  qty           numeric(14, 3) NOT NULL DEFAULT 0 CHECK (qty >= 0),
  PRIMARY KEY (location_id, lot_id)
);
CREATE INDEX lot_balance_lot ON lot_balance (lot_id);

-- Which lots each ledger movement moved (signed like the movement). Append-only, as the ledger is.
CREATE TABLE inventory_txn_lot (
  tenant_id     uuid NOT NULL REFERENCES tenant(id),
  facility_id   uuid NOT NULL REFERENCES facility(id),
  txn_id        bigint NOT NULL REFERENCES inventory_txn(id),
  lot_id        uuid NOT NULL REFERENCES stock_lot(id),
  qty           numeric(14, 3) NOT NULL CHECK (qty <> 0),
  PRIMARY KEY (txn_id, lot_id)
);
CREATE INDEX inventory_txn_lot_lot ON inventory_txn_lot (lot_id);
CREATE TRIGGER inventory_txn_lot_immutable BEFORE UPDATE OR DELETE ON inventory_txn_lot FOR EACH ROW EXECUTE FUNCTION inventory_txn_immutable();

ALTER TABLE stock_lot ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON stock_lot USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['lot_balance', 'inventory_txn_lot'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_facility ON %I USING (tenant_id = app_tenant_id() AND app_can_see_facility(facility_id)) WITH CHECK (tenant_id = app_tenant_id() AND app_can_see_facility(facility_id))', t);
  END LOOP;
END $$;
GRANT SELECT, INSERT, UPDATE ON stock_lot, lot_balance TO erp_app;
GRANT SELECT, INSERT ON inventory_txn_lot TO erp_app;
