-- S21 Feature visibility by role (D-149). A company chooses, feature by feature, whether everyone sees it, only some
-- roles, or nobody. Hidden features disappear from navigation, pages, reports, search and the API for those users;
-- only the administrators' Features screen still lists them. No row means everyone (the default).
CREATE TABLE tenant_feature (
  tenant_id    uuid NOT NULL REFERENCES tenant(id),
  feature_key  text NOT NULL,
  mode         text NOT NULL CHECK (mode IN ('all', 'roles', 'off')),
  role_keys    text[] NOT NULL DEFAULT '{}',
  updated_by   uuid NOT NULL REFERENCES app_user(id),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, feature_key),
  CHECK (mode <> 'roles' OR cardinality(role_keys) > 0)
);
ALTER TABLE tenant_feature ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON tenant_feature USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());
GRANT SELECT, INSERT, UPDATE, DELETE ON tenant_feature TO erp_app;
