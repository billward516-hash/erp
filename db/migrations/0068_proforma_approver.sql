-- Who approves business cases (D-167, founder answer to O-15): the company owner (its administrators) unless an
-- administrator assigns a named approver.
CREATE TABLE proforma_settings (
  tenant_id         uuid PRIMARY KEY REFERENCES tenant(id),
  approver_user_id  uuid REFERENCES app_user(id),
  updated_by        uuid NOT NULL REFERENCES app_user(id),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE proforma_settings ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON proforma_settings USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());
GRANT SELECT, INSERT, UPDATE ON proforma_settings TO erp_app;
