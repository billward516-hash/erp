-- 0017 Maintenance materials: equipment parts lists (which spares a machine uses), repair templates (repair
-- BOM + labor estimate for a known job), and kits for work orders. A kit reserves stock in its storeroom
-- (virtual kit) and can be staged into a staging location through the ledger (physical kit); both are
-- supported so the pilot can choose (D-017).

CREATE TABLE asset_part (
  tenant_id      uuid NOT NULL REFERENCES tenant(id),
  asset_id       uuid NOT NULL REFERENCES asset(id),
  part_id        uuid NOT NULL REFERENCES part(id),
  qty_installed  numeric(12, 3) NOT NULL DEFAULT 1 CHECK (qty_installed > 0),
  position       text,                       -- where on the machine (e.g. "spindle", "Y-axis ballscrew")
  critical       boolean NOT NULL DEFAULT false,  -- a breakdown waits on this part: keep at least min_on_hand at the site
  min_on_hand    numeric(12, 3) CHECK (min_on_hand >= 0),
  notes          text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (asset_id, part_id)
);

CREATE TABLE repair_template (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id              uuid NOT NULL REFERENCES tenant(id),
  code                   text NOT NULL,
  title                  text NOT NULL,
  asset_id               uuid REFERENCES asset(id),   -- for one machine…
  asset_category         text,                         -- …or every asset of a category
  procedure_document_id  uuid REFERENCES document(id),
  est_labor_hours        numeric(8, 2) CHECK (est_labor_hours >= 0),
  notes                  text,
  active                 boolean NOT NULL DEFAULT true,
  created_by             uuid NOT NULL REFERENCES app_user(id),
  created_at             timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, code),
  CHECK (asset_id IS NOT NULL OR asset_category IS NOT NULL)
);
CREATE TABLE repair_template_part (
  tenant_id    uuid NOT NULL REFERENCES tenant(id),
  template_id  uuid NOT NULL REFERENCES repair_template(id),
  part_id      uuid NOT NULL REFERENCES part(id),
  qty          numeric(12, 3) NOT NULL CHECK (qty > 0),
  PRIMARY KEY (template_id, part_id)
);
ALTER TABLE work_order ADD COLUMN repair_template_id uuid REFERENCES repair_template(id);

-- Staging locations hold kits; their stock is never counted as available for other work.
ALTER TABLE stock_location ADD COLUMN kind text NOT NULL DEFAULT 'storeroom' CHECK (kind IN ('storeroom', 'staging'));

CREATE TABLE kit (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            uuid NOT NULL REFERENCES tenant(id),
  facility_id          uuid NOT NULL REFERENCES facility(id),
  number               text NOT NULL,
  work_order_id        uuid NOT NULL REFERENCES work_order(id),
  status               text NOT NULL DEFAULT 'reserved' CHECK (status IN ('reserved', 'staged', 'issued', 'closed', 'cancelled')),
  needed_by            timestamptz,
  staging_location_id  uuid REFERENCES stock_location(id),
  created_by           uuid NOT NULL REFERENCES app_user(id),
  created_at           timestamptz NOT NULL DEFAULT now(),
  staged_by            uuid REFERENCES app_user(id),
  staged_at            timestamptz,
  issued_at            timestamptz,
  closed_at            timestamptz,
  cancel_reason        text,
  UNIQUE (tenant_id, number)
);
CREATE UNIQUE INDEX kit_one_active_per_wo ON kit (work_order_id) WHERE status NOT IN ('closed', 'cancelled');

CREATE TABLE kit_line (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL REFERENCES tenant(id),
  kit_id              uuid NOT NULL REFERENCES kit(id),
  work_order_part_id  uuid NOT NULL REFERENCES work_order_part(id),
  part_id             uuid NOT NULL REFERENCES part(id),
  qty_needed          numeric(12, 3) NOT NULL CHECK (qty_needed > 0),
  from_location_id    uuid REFERENCES stock_location(id),   -- storeroom the stock is reserved in (null: nothing available)
  qty_reserved        numeric(12, 3) NOT NULL DEFAULT 0 CHECK (qty_reserved >= 0),
  qty_staged          numeric(12, 3) NOT NULL DEFAULT 0 CHECK (qty_staged >= 0),
  qty_issued          numeric(12, 3) NOT NULL DEFAULT 0 CHECK (qty_issued >= 0),
  qty_returned        numeric(12, 3) NOT NULL DEFAULT 0 CHECK (qty_returned >= 0),
  UNIQUE (kit_id, work_order_part_id),
  CHECK (qty_reserved <= qty_needed)
);

ALTER TABLE asset_part ENABLE ROW LEVEL SECURITY;
CREATE POLICY via_parent ON asset_part USING (tenant_id = app_tenant_id() AND EXISTS (SELECT 1 FROM asset a WHERE a.id = asset_id))
  WITH CHECK (tenant_id = app_tenant_id() AND EXISTS (SELECT 1 FROM asset a WHERE a.id = asset_id));
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['repair_template', 'repair_template_part'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id())', t);
  END LOOP;
END $$;
ALTER TABLE kit ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_facility ON kit USING (tenant_id = app_tenant_id() AND app_can_see_facility(facility_id)) WITH CHECK (tenant_id = app_tenant_id() AND app_can_see_facility(facility_id));
ALTER TABLE kit_line ENABLE ROW LEVEL SECURITY;
CREATE POLICY via_parent ON kit_line USING (tenant_id = app_tenant_id() AND EXISTS (SELECT 1 FROM kit k WHERE k.id = kit_id))
  WITH CHECK (tenant_id = app_tenant_id() AND EXISTS (SELECT 1 FROM kit k WHERE k.id = kit_id));

GRANT SELECT, INSERT, UPDATE, DELETE ON asset_part, repair_template_part TO erp_app;
GRANT SELECT, INSERT, UPDATE ON repair_template, kit, kit_line TO erp_app;
