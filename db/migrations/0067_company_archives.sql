-- Company archives and restore (D-165). Every 30 days (each company can change it) a full copy of the company's data is
-- written to storage with a checksum. Administrators can download one, bring back chosen records from it, or roll the
-- whole company back to it; a rollback needs a second administrator and first archives the present state.
CREATE TABLE company_archive (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenant(id),
  kind            text NOT NULL CHECK (kind IN ('scheduled', 'manual', 'pre_rollback')),
  status          text NOT NULL DEFAULT 'ready' CHECK (status IN ('ready', 'failed', 'deleted')),
  blob_key        text,
  sha256          text,
  size_bytes      bigint,
  table_count     integer,
  row_count       bigint,
  schema_version  text,                -- the last migration applied when it was taken
  note            text,
  error           text,
  created_by      uuid REFERENCES app_user(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  deleted_at      timestamptz
);
CREATE INDEX company_archive_recent ON company_archive (tenant_id, created_at DESC);

CREATE TABLE archive_settings (
  tenant_id      uuid PRIMARY KEY REFERENCES tenant(id),
  interval_days  integer NOT NULL DEFAULT 30 CHECK (interval_days BETWEEN 1 AND 90),
  keep_count     integer NOT NULL DEFAULT 12 CHECK (keep_count BETWEEN 1 AND 120),
  updated_by     uuid NOT NULL REFERENCES app_user(id),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE company_rollback (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenant(id),
  archive_id      uuid NOT NULL REFERENCES company_archive(id),
  status          text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'done', 'cancelled', 'failed', 'expired')),
  reason          text NOT NULL CHECK (length(trim(reason)) >= 5),
  requested_by    uuid NOT NULL REFERENCES app_user(id),
  requested_at    timestamptz NOT NULL DEFAULT now(),
  confirmed_by    uuid REFERENCES app_user(id),
  confirmed_at    timestamptz,
  pre_archive_id  uuid REFERENCES company_archive(id),
  finished_at     timestamptz,
  result          jsonb,
  error           text,
  CHECK (confirmed_by IS NULL OR confirmed_by <> requested_by)
);
CREATE UNIQUE INDEX company_rollback_one_pending ON company_rollback (tenant_id) WHERE status = 'pending';

ALTER TABLE company_archive ENABLE ROW LEVEL SECURITY;
ALTER TABLE archive_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE company_rollback ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON company_archive USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());
CREATE POLICY tenant_isolation ON archive_settings USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());
CREATE POLICY tenant_isolation ON company_rollback USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());
-- Archives are written and restored by the platform (owner connection); the app reads them and records requests.
GRANT SELECT ON company_archive TO erp_app;
GRANT SELECT, INSERT, UPDATE ON archive_settings TO erp_app;
GRANT SELECT, INSERT, UPDATE ON company_rollback TO erp_app;
