-- S19a Units of measure (D-143). A part is stocked in one unit (part.uom). Standard units of the same kind convert
-- by fixed factors (in code); anything else (BOX, CASE, DRUM, ROLL…) converts through the part's own units: how
-- many stock units one of them holds. Orders keep the unit they were placed in and freeze the conversion, so a later
-- change to a part's units never rewrites history; receipts put stock units into the ledger.
CREATE TABLE part_uom (
  tenant_id     uuid NOT NULL REFERENCES tenant(id),
  part_id       uuid NOT NULL REFERENCES part(id),
  uom           text NOT NULL CHECK (uom ~ '^[A-Z0-9]{1,10}$'),
  per_unit      numeric(14, 6) NOT NULL CHECK (per_unit > 0),   -- stock units in one of this unit
  updated_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (part_id, uom)
);
ALTER TABLE part_uom ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON part_uom USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());
GRANT SELECT, INSERT, UPDATE, DELETE ON part_uom TO erp_app;

-- The unit a supplier sells in (its price is per this unit); NULL = the part's stock unit.
ALTER TABLE supplier_part ADD COLUMN uom text;
-- The unit an order line is in, and the stock units in one of it, frozen when the order is placed.
ALTER TABLE purchase_order_line ADD COLUMN uom text NOT NULL DEFAULT 'EA';
ALTER TABLE purchase_order_line ADD COLUMN stock_per_unit numeric(14, 6) NOT NULL DEFAULT 1 CHECK (stock_per_unit > 0);
UPDATE purchase_order_line pl SET uom = rl.uom FROM purchase_request_line rl WHERE rl.id = pl.request_line_id;
-- What went into stock for a receipt, in the part's stock unit.
ALTER TABLE po_receipt ADD COLUMN stock_qty numeric(14, 3);
-- Request lines carry the same conversion, so "already requested" counts in stock units.
ALTER TABLE purchase_request_line ADD COLUMN stock_per_unit numeric(14, 6) NOT NULL DEFAULT 1 CHECK (stock_per_unit > 0);
