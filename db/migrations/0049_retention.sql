-- S23 Data retention (D-151). Short-lived working data (staged import rows, notifications, sent emails, expired sign-in
-- tokens) is removed after a period each company sets within limits. Business records, documents and the audit log are
-- never removed by retention. The daily sweep runs as the owner role with an explicit company filter.
CREATE TABLE tenant_retention (
  tenant_id   uuid NOT NULL REFERENCES tenant(id),
  category    text NOT NULL,
  days        integer NOT NULL CHECK (days > 0),
  updated_by  uuid NOT NULL REFERENCES app_user(id),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, category)
);
ALTER TABLE tenant_retention ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON tenant_retention USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());
GRANT SELECT, INSERT, UPDATE, DELETE ON tenant_retention TO erp_app;

CREATE TABLE retention_run (
  id        bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  ran_at    timestamptz NOT NULL DEFAULT now(),
  removed   jsonb NOT NULL DEFAULT '{}'
);
CREATE INDEX retention_run_recent ON retention_run (tenant_id, ran_at DESC);
ALTER TABLE retention_run ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON retention_run USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());
GRANT SELECT, INSERT ON retention_run TO erp_app;

-- An import keeps its summary (file, mapping, counts) after its staged rows are removed.
ALTER TABLE import_batch ADD COLUMN rows_purged_at timestamptz;
CREATE INDEX notification_retention ON notification (tenant_id, created_at);
