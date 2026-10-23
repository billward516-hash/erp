-- 0003 Data import framework: saved mapping profiles, staged batches/rows, external ID crosswalk.
-- Customer data arrives in whatever shape their current systems produce. Nothing is written to
-- operational tables until a batch is parsed, mapped, validated, reviewed (dry run) and committed.

-- Reusable, declarative mapping (no executable code) per tenant + source system + target.
CREATE TABLE import_profile (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenant(id),
  name           text NOT NULL,
  target         text NOT NULL,
  source_system  text NOT NULL,
  mapping        jsonb NOT NULL,
  version        integer NOT NULL DEFAULT 1,
  created_by     uuid REFERENCES app_user(id),
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, name)
);
CREATE TRIGGER import_profile_touch BEFORE UPDATE ON import_profile FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

CREATE TABLE import_batch (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            uuid NOT NULL REFERENCES tenant(id),
  facility_id          uuid REFERENCES facility(id),      -- default facility for rows that do not name one
  target               text NOT NULL,
  source_system        text NOT NULL,
  profile_id           uuid REFERENCES import_profile(id),
  file_name            text NOT NULL,
  file_sha256          text NOT NULL,
  format               text NOT NULL CHECK (format IN ('csv', 'xlsx', 'json')),
  parse_info           jsonb NOT NULL DEFAULT '{}',        -- detected delimiter/encoding/header row/sheet
  source_columns       text[] NOT NULL DEFAULT '{}',
  mapping              jsonb NOT NULL,                     -- exact mapping used (snapshot)
  status               text NOT NULL DEFAULT 'validated'
                         CHECK (status IN ('validated', 'committed', 'failed', 'cancelled')),
  stats                jsonb NOT NULL DEFAULT '{}',
  created_by           uuid REFERENCES app_user(id),
  created_at           timestamptz NOT NULL DEFAULT now(),
  committed_by         uuid REFERENCES app_user(id),
  committed_at         timestamptz
);

CREATE TABLE import_row (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id    uuid NOT NULL REFERENCES tenant(id),
  batch_id     uuid NOT NULL REFERENCES import_batch(id),
  row_number   integer NOT NULL,                           -- 1-based line/row in the source file
  raw          jsonb NOT NULL,
  normalized   jsonb,
  status       text NOT NULL CHECK (status IN ('valid', 'warning', 'error', 'committed', 'skipped')),
  messages     jsonb NOT NULL DEFAULT '[]',
  action       text CHECK (action IN ('create', 'update', 'unchanged')),
  entity_id    uuid,
  UNIQUE (batch_id, row_number)
);

-- Crosswalk from a customer's legacy identifiers to platform IDs. Makes re-imports idempotent
-- (update instead of duplicate) and lets later files reference earlier ones by legacy key.
CREATE TABLE external_ref (
  tenant_id      uuid NOT NULL REFERENCES tenant(id),
  source_system  text NOT NULL,
  entity_type    text NOT NULL,
  external_id    text NOT NULL,
  entity_id      uuid NOT NULL,
  batch_id       uuid REFERENCES import_batch(id),
  created_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, source_system, entity_type, external_id)
);
CREATE INDEX external_ref_entity ON external_ref (tenant_id, entity_type, entity_id);

ALTER TABLE import_profile ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON import_profile USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());
ALTER TABLE import_batch ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_facility ON import_batch
  USING (tenant_id = app_tenant_id() AND app_can_see_facility(facility_id))
  WITH CHECK (tenant_id = app_tenant_id() AND app_can_see_facility(facility_id));
ALTER TABLE import_row ENABLE ROW LEVEL SECURITY;
CREATE POLICY via_parent ON import_row
  USING (tenant_id = app_tenant_id() AND EXISTS (SELECT 1 FROM import_batch b WHERE b.id = batch_id))
  WITH CHECK (tenant_id = app_tenant_id() AND EXISTS (SELECT 1 FROM import_batch b WHERE b.id = batch_id));
ALTER TABLE external_ref ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON external_ref USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());

GRANT SELECT, INSERT, UPDATE ON import_profile, import_batch, import_row, external_ref TO erp_app;
