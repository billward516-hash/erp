-- 0014 Production foundation: work centers, product revisions (bill of materials + routing, versioned
-- together), production orders that pin a released revision, and lightweight execution (start/stop
-- entries per operator and machine with good/scrap/rework counts, material issues, finished-goods receipts).
-- Not an MES: no recipes, machine control or electronic batch records (brief §12).

CREATE TABLE work_center (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenant(id),
  facility_id  uuid NOT NULL REFERENCES facility(id),
  code         text NOT NULL,
  name         text NOT NULL,
  active       boolean NOT NULL DEFAULT true,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, facility_id, code)
);

-- Machines that can run work at a work center (an empty list means work is done by hand).
CREATE TABLE work_center_asset (
  tenant_id       uuid NOT NULL REFERENCES tenant(id),
  work_center_id  uuid NOT NULL REFERENCES work_center(id),
  asset_id        uuid NOT NULL REFERENCES asset(id),
  PRIMARY KEY (work_center_id, asset_id)
);

-- A product revision: the materials (lines) and the routing (operations) to make one unit of a part.
CREATE TABLE product_revision (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenant(id),
  part_id      uuid NOT NULL REFERENCES part(id),
  revision     integer NOT NULL CHECK (revision > 0),
  status       text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'released', 'obsolete')),
  notes        text,
  created_by   uuid NOT NULL REFERENCES app_user(id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  released_by  uuid REFERENCES app_user(id),
  released_at  timestamptz,
  UNIQUE (part_id, revision)
);
CREATE UNIQUE INDEX product_revision_one_released ON product_revision (part_id) WHERE status = 'released';
CREATE UNIQUE INDEX product_revision_one_draft ON product_revision (part_id) WHERE status = 'draft';

CREATE TABLE product_material (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenant(id),
  revision_id   uuid NOT NULL REFERENCES product_revision(id),
  line_no       integer NOT NULL,
  part_id       uuid NOT NULL REFERENCES part(id),
  qty_per       numeric(14, 5) NOT NULL CHECK (qty_per > 0),
  scrap_pct     numeric(5, 2) NOT NULL DEFAULT 0 CHECK (scrap_pct >= 0 AND scrap_pct < 100),
  op_no         integer,                        -- the operation that consumes it (informational)
  notes         text,
  UNIQUE (revision_id, line_no),
  UNIQUE (revision_id, part_id)
);

CREATE TABLE product_operation (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             uuid NOT NULL REFERENCES tenant(id),
  revision_id           uuid NOT NULL REFERENCES product_revision(id),
  op_no                 integer NOT NULL CHECK (op_no > 0),
  work_center_id        uuid NOT NULL REFERENCES work_center(id),
  description           text NOT NULL,
  setup_minutes         numeric(10, 2) NOT NULL DEFAULT 0 CHECK (setup_minutes >= 0),
  run_minutes_per_unit  numeric(10, 3) NOT NULL DEFAULT 0 CHECK (run_minutes_per_unit >= 0),
  document_id           uuid REFERENCES document(id),    -- work instruction (controlled document)
  UNIQUE (revision_id, op_no)
);

-- Released revisions are frozen: change means a new revision.
CREATE FUNCTION product_revision_frozen() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE rid uuid := coalesce(NEW.revision_id, OLD.revision_id);
BEGIN
  IF (SELECT status FROM product_revision WHERE id = rid) <> 'draft' THEN
    RAISE EXCEPTION 'released product revisions cannot change; create a new revision';
  END IF;
  RETURN coalesce(NEW, OLD);
END $$;
CREATE TRIGGER product_material_frozen BEFORE INSERT OR UPDATE OR DELETE ON product_material FOR EACH ROW EXECUTE FUNCTION product_revision_frozen();
CREATE TRIGGER product_operation_frozen BEFORE INSERT OR UPDATE OR DELETE ON product_operation FOR EACH ROW EXECUTE FUNCTION product_revision_frozen();

CREATE TABLE production_order (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            uuid NOT NULL REFERENCES tenant(id),
  facility_id          uuid NOT NULL REFERENCES facility(id),
  number               text NOT NULL,
  part_id              uuid NOT NULL REFERENCES part(id),
  revision_id          uuid NOT NULL REFERENCES product_revision(id),
  qty                  numeric(14, 3) NOT NULL CHECK (qty > 0),
  qty_received         numeric(14, 3) NOT NULL DEFAULT 0 CHECK (qty_received >= 0),
  status               text NOT NULL DEFAULT 'planned' CHECK (status IN ('planned', 'released', 'in_progress', 'completed', 'closed', 'cancelled')),
  due_date             date,
  output_location_id   uuid REFERENCES stock_location(id),
  sales_order_line_id  uuid REFERENCES sales_order_line(id),
  notes                text,
  short_reason         text,                    -- completed with fewer than ordered
  cancel_reason        text,
  created_by           uuid NOT NULL REFERENCES app_user(id),
  created_at           timestamptz NOT NULL DEFAULT now(),
  released_by          uuid REFERENCES app_user(id),
  released_at          timestamptz,
  completed_at         timestamptz,
  closed_by            uuid REFERENCES app_user(id),
  closed_at            timestamptz,
  UNIQUE (tenant_id, number)
);

-- Copied from the revision at release, scaled to the order quantity.
CREATE TABLE production_material (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES tenant(id),
  order_id          uuid NOT NULL REFERENCES production_order(id),
  line_no           integer NOT NULL,
  part_id           uuid NOT NULL REFERENCES part(id),
  qty_per           numeric(14, 5) NOT NULL,
  scrap_pct         numeric(5, 2) NOT NULL DEFAULT 0,
  qty_required      numeric(14, 3) NOT NULL,
  qty_issued        numeric(14, 3) NOT NULL DEFAULT 0 CHECK (qty_issued >= 0),
  UNIQUE (order_id, line_no)
);

CREATE TABLE production_operation (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             uuid NOT NULL REFERENCES tenant(id),
  order_id              uuid NOT NULL REFERENCES production_order(id),
  op_no                 integer NOT NULL,
  work_center_id        uuid NOT NULL REFERENCES work_center(id),
  description           text NOT NULL,
  setup_minutes         numeric(10, 2) NOT NULL DEFAULT 0,
  run_minutes_per_unit  numeric(10, 3) NOT NULL DEFAULT 0,
  document_id           uuid REFERENCES document(id),
  status                text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'in_progress', 'done')),
  qty_good              numeric(14, 3) NOT NULL DEFAULT 0,
  qty_scrap             numeric(14, 3) NOT NULL DEFAULT 0,
  qty_rework            numeric(14, 3) NOT NULL DEFAULT 0,
  UNIQUE (order_id, op_no)
);

CREATE TABLE scrap_reason (
  tenant_id  uuid NOT NULL REFERENCES tenant(id),
  code       text NOT NULL,
  label      text NOT NULL,
  active     boolean NOT NULL DEFAULT true,
  PRIMARY KEY (tenant_id, code)
);

-- One run of one operation by one operator (on one machine, if any). Open while ended_at is null.
CREATE TABLE production_entry (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenant(id),
  facility_id    uuid NOT NULL REFERENCES facility(id),
  order_id       uuid NOT NULL REFERENCES production_order(id),
  operation_id   uuid NOT NULL REFERENCES production_operation(id),
  employee_id    uuid NOT NULL REFERENCES employee(id),
  asset_id       uuid REFERENCES asset(id),
  kind           text NOT NULL DEFAULT 'run' CHECK (kind IN ('setup', 'run')),
  started_at     timestamptz NOT NULL,
  ended_at       timestamptz,
  qty_good       numeric(14, 3) NOT NULL DEFAULT 0 CHECK (qty_good >= 0),
  qty_scrap      numeric(14, 3) NOT NULL DEFAULT 0 CHECK (qty_scrap >= 0),
  qty_rework     numeric(14, 3) NOT NULL DEFAULT 0 CHECK (qty_rework >= 0),
  scrap_reason   text,
  note           text,
  recorded_by    uuid NOT NULL REFERENCES app_user(id),
  created_at     timestamptz NOT NULL DEFAULT now(),
  CHECK (ended_at IS NULL OR ended_at > started_at),
  CHECK (qty_rework <= qty_good),
  CHECK (qty_scrap = 0 OR scrap_reason IS NOT NULL)
);
CREATE UNIQUE INDEX production_entry_one_open_per_asset ON production_entry (asset_id) WHERE ended_at IS NULL AND asset_id IS NOT NULL;
CREATE UNIQUE INDEX production_entry_one_open_per_person ON production_entry (employee_id) WHERE ended_at IS NULL;
-- Closed entries are records: they cannot be edited or deleted (corrections are new entries by a supervisor).
CREATE FUNCTION production_entry_closed() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' OR OLD.ended_at IS NOT NULL THEN
    RAISE EXCEPTION 'finished production entries cannot be changed; record a correction';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER production_entry_immutable BEFORE UPDATE OR DELETE ON production_entry FOR EACH ROW EXECUTE FUNCTION production_entry_closed();

-- Stock movements for production.
ALTER TABLE inventory_txn ADD COLUMN production_order_id uuid REFERENCES production_order(id);
ALTER TABLE inventory_txn DROP CONSTRAINT inventory_txn_txn_type_check;
ALTER TABLE inventory_txn ADD CONSTRAINT inventory_txn_txn_type_check
  CHECK (txn_type IN ('receipt', 'issue', 'return', 'adjustment', 'count', 'transfer_out', 'transfer_in', 'opening', 'shipment',
                      'production_issue', 'production_return', 'production_receipt'));

-- Machine state recorded from production runs.
ALTER TABLE asset_state_event DROP CONSTRAINT asset_state_event_source_check;
ALTER TABLE asset_state_event ADD CONSTRAINT asset_state_event_source_check CHECK (source IN ('manual', 'import', 'work_order', 'telemetry', 'production'));

-- RLS
ALTER TABLE work_center ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_facility ON work_center USING (tenant_id = app_tenant_id() AND app_can_see_facility(facility_id))
  WITH CHECK (tenant_id = app_tenant_id() AND app_can_see_facility(facility_id));
ALTER TABLE work_center_asset ENABLE ROW LEVEL SECURITY;
CREATE POLICY via_parent ON work_center_asset USING (tenant_id = app_tenant_id() AND EXISTS (SELECT 1 FROM work_center w WHERE w.id = work_center_id))
  WITH CHECK (tenant_id = app_tenant_id() AND EXISTS (SELECT 1 FROM work_center w WHERE w.id = work_center_id));
ALTER TABLE production_order ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_facility ON production_order USING (tenant_id = app_tenant_id() AND app_can_see_facility(facility_id))
  WITH CHECK (tenant_id = app_tenant_id() AND app_can_see_facility(facility_id));
ALTER TABLE production_entry ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_facility ON production_entry USING (tenant_id = app_tenant_id() AND app_can_see_facility(facility_id))
  WITH CHECK (tenant_id = app_tenant_id() AND app_can_see_facility(facility_id));
ALTER TABLE production_material ENABLE ROW LEVEL SECURITY;
CREATE POLICY via_parent ON production_material USING (tenant_id = app_tenant_id() AND EXISTS (SELECT 1 FROM production_order o WHERE o.id = order_id))
  WITH CHECK (tenant_id = app_tenant_id() AND EXISTS (SELECT 1 FROM production_order o WHERE o.id = order_id));
ALTER TABLE production_operation ENABLE ROW LEVEL SECURITY;
CREATE POLICY via_parent ON production_operation USING (tenant_id = app_tenant_id() AND EXISTS (SELECT 1 FROM production_order o WHERE o.id = order_id))
  WITH CHECK (tenant_id = app_tenant_id() AND EXISTS (SELECT 1 FROM production_order o WHERE o.id = order_id));
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['product_revision', 'product_material', 'product_operation', 'scrap_reason'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id())', t);
  END LOOP;
END $$;

GRANT SELECT, INSERT, UPDATE ON work_center, product_revision, production_order, production_operation, production_material, production_entry, scrap_reason TO erp_app;
GRANT SELECT, INSERT, DELETE ON work_center_asset TO erp_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON product_material, product_operation TO erp_app;

-- Roles and starter scrap reasons for existing tenants (new tenants get them from provisioning).
INSERT INTO role (tenant_id, key, name, permissions)
SELECT t.id, 'production_supervisor', 'Production Supervisor / Planner',
  ARRAY['org.view', 'employees.view', 'assets.view', 'documents.view', 'parts.view', 'inventory.view', 'work_orders.view', 'work_orders.request',
        'reports.view', 'reports.export', 'imports.run', 'imports.commit', 'learning.view', 'qualifications.view', 'moc.view', 'moc.request',
        'purchasing.view', 'purchasing.request', 'sales.view', 'production.view', 'production.manage', 'production.execute']
FROM tenant t WHERE NOT EXISTS (SELECT 1 FROM role x WHERE x.tenant_id = t.id AND x.key = 'production_supervisor');
UPDATE role SET permissions = (SELECT array_agg(DISTINCT p) FROM unnest(permissions || ARRAY['production.view', 'production.manage', 'production.execute']) p) WHERE key = 'admin';
UPDATE role SET permissions = (SELECT array_agg(DISTINCT p) FROM unnest(permissions || ARRAY['production.view', 'production.manage']) p) WHERE key = 'operations_manager';
UPDATE role SET permissions = (SELECT array_agg(DISTINCT p) FROM unnest(permissions || ARRAY['production.view', 'production.execute']) p) WHERE key = 'operator';
UPDATE role SET permissions = (SELECT array_agg(DISTINCT p) FROM unnest(permissions || ARRAY['production.view']) p) WHERE key IN ('executive', 'quality_reviewer', 'sales_manager');
INSERT INTO scrap_reason (tenant_id, code, label)
SELECT t.id, r.code, r.label FROM tenant t CROSS JOIN (VALUES ('DIM', 'Out of tolerance'), ('SURF', 'Surface damage / finish'), ('MAT', 'Material defect'),
  ('SETUP', 'Setup / first piece'), ('MACH', 'Machine fault'), ('HAND', 'Handling damage'), ('OTHER', 'Other')) AS r(code, label)
ON CONFLICT DO NOTHING;
