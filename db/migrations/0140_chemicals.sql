-- SC-007 C Chemicals and reagents (D-184C): chemical attributes on a part, containers with beyond-use dates, storage groups with an
-- editable (NOT certified) incompatible-pairs list, preparations (reagents and standards), per-location hazard-class limits that the
-- company sets (the platform ships none), and event history. Containers and preparations sit on top of the stock ledger and lots
-- (0045/0046): receipts, moves, use and disposal post the ledger; these tables add what a lab needs to know about each container.

-- One row per company. The starter lists (hazard classes, storage groups, incompatible pairs) are copied in the first time the
-- module is used (not at provisioning), so a company that never uses chemicals carries nothing.
CREATE TABLE chemical_setting (
  tenant_id          uuid PRIMARY KEY REFERENCES tenant(id),
  starter_loaded     boolean NOT NULL DEFAULT false,
  sds_max_age_years  integer NOT NULL DEFAULT 3 CHECK (sds_max_age_years BETWEEN 1 AND 20),   -- a company choice, not a regulatory number
  receipt_containers boolean NOT NULL DEFAULT true,                                           -- receiving a chemical part creates containers
  updated_by         uuid REFERENCES app_user(id),
  updated_at         timestamptz NOT NULL DEFAULT now()
);

-- GHS hazard classes: a fixed starter list stored as data (the pictogram code is the GHS pictogram that goes with the class).
CREATE TABLE chemical_hazard_class (
  tenant_id   uuid NOT NULL REFERENCES tenant(id),
  code        text NOT NULL,
  label       text NOT NULL,
  pictogram   text NOT NULL,
  sort_order  integer NOT NULL,
  PRIMARY KEY (tenant_id, code)
);

CREATE TABLE chemical_storage_group (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenant(id),
  code        text NOT NULL CHECK (length(code) BETWEEN 1 AND 20),
  name        text NOT NULL CHECK (length(trim(name)) >= 2),
  description text,
  starter     boolean NOT NULL DEFAULT false,
  active      boolean NOT NULL DEFAULT true,
  UNIQUE (tenant_id, code)
);

-- Stored once per pair with group_a < group_b.
CREATE TABLE chemical_incompatibility (
  id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  group_a   uuid NOT NULL REFERENCES chemical_storage_group(id),
  group_b   uuid NOT NULL REFERENCES chemical_storage_group(id),
  reason    text,
  starter   boolean NOT NULL DEFAULT false,
  CHECK (group_a < group_b),
  UNIQUE (tenant_id, group_a, group_b)
);
CREATE INDEX chemical_incompatibility_a ON chemical_incompatibility (group_a);
CREATE INDEX chemical_incompatibility_b ON chemical_incompatibility (group_b);

-- Chemical attributes of a part. A chemical part is lot tracked (the lot carries the expiry).
CREATE TABLE chemical_part (
  part_id            uuid PRIMARY KEY REFERENCES part(id),
  tenant_id          uuid NOT NULL REFERENCES tenant(id),
  is_chemical        boolean NOT NULL DEFAULT true,
  hazard_classes     text[] NOT NULL DEFAULT '{}',
  signal_word        text NOT NULL DEFAULT 'none' CHECK (signal_word IN ('none', 'warning', 'danger')),
  cas_number         text,
  sds_document_id    uuid REFERENCES document(id),
  sds_revision_on    date,                                 -- the revision date printed on the supplier's safety data sheet
  storage_group_id   uuid REFERENCES chemical_storage_group(id),
  in_use_days        integer CHECK (in_use_days > 0),      -- days a container stays usable after it is opened
  storage_conditions text,
  updated_by         uuid REFERENCES app_user(id),
  updated_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX chemical_part_sds ON chemical_part (sds_document_id);
CREATE INDEX chemical_part_group ON chemical_part (storage_group_id);

CREATE TABLE chemical_container (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenant(id),
  facility_id    uuid NOT NULL REFERENCES facility(id),
  number         text NOT NULL,
  part_id        uuid NOT NULL REFERENCES part(id),
  lot_id         uuid NOT NULL REFERENCES stock_lot(id),
  lot_number     text NOT NULL,
  initial_qty    numeric(14, 3) NOT NULL CHECK (initial_qty > 0),
  qty            numeric(14, 3) NOT NULL CHECK (qty >= 0),
  uom            text NOT NULL,
  location_id    uuid NOT NULL REFERENCES stock_location(id),
  status         text NOT NULL DEFAULT 'in_storage' CHECK (status IN ('in_storage', 'in_use', 'empty', 'disposed')),
  expires_on     date,                                       -- the lot's expiry when the container was made
  opened_on      date,
  in_use_days    integer,                                    -- the part's in-use days when it was opened
  beyond_use_on  date,                                       -- opened_on + in_use_days, never later than expires_on
  use_by         date GENERATED ALWAYS AS (LEAST(beyond_use_on, expires_on)) STORED,
  emptied_on     date,
  disposed_on    date,
  disposal_note  text,
  created_by     uuid NOT NULL REFERENCES app_user(id),
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, number),
  CHECK (status <> 'disposed' OR (disposed_on IS NOT NULL AND disposal_note IS NOT NULL))
);
CREATE INDEX chemical_container_site ON chemical_container (facility_id, status);
CREATE INDEX chemical_container_location ON chemical_container (location_id, status);
CREATE INDEX chemical_container_part ON chemical_container (part_id);
CREATE INDEX chemical_container_lot ON chemical_container (lot_id);
CREATE INDEX chemical_container_use_by ON chemical_container (tenant_id, use_by) WHERE status IN ('in_storage', 'in_use');
CREATE TRIGGER chemical_container_touch BEFORE UPDATE ON chemical_container FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- What happened to a container, oldest first; overrides of the storage rule are kept here too. Append-only.
CREATE TABLE chemical_container_event (
  id           bigserial PRIMARY KEY,
  tenant_id    uuid NOT NULL REFERENCES tenant(id),
  facility_id  uuid NOT NULL REFERENCES facility(id),
  container_id uuid NOT NULL REFERENCES chemical_container(id),
  kind         text NOT NULL CHECK (kind IN ('created', 'opened', 'used', 'moved', 'emptied', 'disposed', 'override')),
  data         jsonb NOT NULL DEFAULT '{}',
  created_by   uuid REFERENCES app_user(id),
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX chemical_container_event_container ON chemical_container_event (container_id, id);
CREATE INDEX chemical_container_event_site ON chemical_container_event (facility_id, kind);

-- A limit the company sets for one hazard class at one storeroom (for example the quantity its fire plan allows). None ship.
CREATE TABLE chemical_location_limit (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenant(id),
  facility_id  uuid NOT NULL REFERENCES facility(id),
  location_id  uuid NOT NULL REFERENCES stock_location(id),
  hazard_class text NOT NULL,
  limit_qty    numeric(14, 3) NOT NULL CHECK (limit_qty >= 0),
  uom          text NOT NULL,
  note         text,
  updated_by   uuid REFERENCES app_user(id),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (location_id, hazard_class)
);
CREATE INDEX chemical_location_limit_site ON chemical_location_limit (facility_id);

CREATE TABLE chemical_preparation (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenant(id),
  facility_id    uuid NOT NULL REFERENCES facility(id),
  number         text NOT NULL,
  name           text NOT NULL CHECK (length(trim(name)) >= 2),
  kind           text NOT NULL CHECK (kind IN ('reagent', 'standard')),
  concentration  text,
  qty            numeric(14, 3) NOT NULL CHECK (qty > 0),
  qty_remaining  numeric(14, 3) NOT NULL CHECK (qty_remaining >= 0),
  uom            text NOT NULL,
  prepared_by    uuid NOT NULL REFERENCES app_user(id),
  prepared_on    date NOT NULL,
  shelf_life_days integer CHECK (shelf_life_days > 0),
  expires_on     date,                                       -- the earliest of the components' use-by dates and the stated shelf life
  status         text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'used_up', 'discarded')),
  discarded_on   date,
  discard_note   text,
  notes          text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, number)
);
CREATE INDEX chemical_preparation_site ON chemical_preparation (facility_id, status);
CREATE INDEX chemical_preparation_expiry ON chemical_preparation (tenant_id, expires_on) WHERE status = 'active';

CREATE TABLE chemical_preparation_component (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             uuid NOT NULL REFERENCES tenant(id),
  facility_id           uuid NOT NULL REFERENCES facility(id),
  preparation_id        uuid NOT NULL REFERENCES chemical_preparation(id),
  container_id          uuid REFERENCES chemical_container(id),
  source_preparation_id uuid REFERENCES chemical_preparation(id),
  part_id               uuid REFERENCES part(id),
  lot_number            text,
  qty                   numeric(14, 3) NOT NULL CHECK (qty > 0),
  uom                   text NOT NULL,
  use_by                date,
  CHECK ((container_id IS NOT NULL) <> (source_preparation_id IS NOT NULL))
);
CREATE INDEX chemical_prep_component_prep ON chemical_preparation_component (preparation_id);
CREATE INDEX chemical_prep_component_container ON chemical_preparation_component (container_id);
CREATE INDEX chemical_prep_component_source ON chemical_preparation_component (source_preparation_id);
CREATE INDEX chemical_prep_component_part ON chemical_preparation_component (part_id);
CREATE INDEX chemical_prep_component_site ON chemical_preparation_component (facility_id);

-- Row-level security: company-wide tables by company, site tables by company and site.
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['chemical_setting', 'chemical_hazard_class', 'chemical_storage_group', 'chemical_incompatibility', 'chemical_part'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id())', t);
  END LOOP;
  FOREACH t IN ARRAY ARRAY['chemical_container', 'chemical_container_event', 'chemical_location_limit', 'chemical_preparation', 'chemical_preparation_component'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_facility ON %I USING (tenant_id = app_tenant_id() AND app_can_see_facility(facility_id)) WITH CHECK (tenant_id = app_tenant_id() AND app_can_see_facility(facility_id))', t);
  END LOOP;
END $$;
GRANT SELECT, INSERT, UPDATE ON chemical_setting, chemical_storage_group, chemical_part, chemical_container, chemical_location_limit, chemical_preparation TO erp_app;
GRANT SELECT, INSERT ON chemical_hazard_class, chemical_container_event, chemical_preparation_component TO erp_app;
GRANT SELECT, INSERT, DELETE ON chemical_incompatibility TO erp_app;
GRANT DELETE ON chemical_location_limit TO erp_app;
GRANT USAGE ON SEQUENCE chemical_container_event_id_seq TO erp_app;

-- Who may see and keep chemicals. Overriding the storage rule is its own permission.
UPDATE role SET permissions = (SELECT array_agg(DISTINCT p) FROM unnest(permissions || ARRAY['chemicals.view', 'chemicals.manage', 'chemicals.override']) p)
WHERE key IN ('admin', 'ehs_reviewer');
UPDATE role SET permissions = (SELECT array_agg(DISTINCT p) FROM unnest(permissions || ARRAY['chemicals.view', 'chemicals.manage']) p)
WHERE key IN ('maintenance_manager', 'quality_manager');
UPDATE role SET permissions = (SELECT array_agg(DISTINCT p) FROM unnest(permissions || ARRAY['chemicals.view']) p)
WHERE key IN ('operations_manager', 'quality_reviewer', 'technician', 'production_supervisor', 'executive');
