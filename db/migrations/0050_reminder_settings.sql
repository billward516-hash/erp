-- S25a Reminder settings (D-153). Each company turns reminders on or off and sets how far ahead they warn and how
-- often they repeat. No row means the defaults in the catalogue (src/modules/reminders/catalogue.ts). editor_roles:
-- the roles that may change this reminder; NULL means holders of the area's manage permission. Administrators always may.
CREATE TABLE tenant_reminder (
  tenant_id     uuid NOT NULL REFERENCES tenant(id),
  reminder_key  text NOT NULL,
  enabled       boolean NOT NULL DEFAULT true,
  lead_days     integer CHECK (lead_days >= 0),
  repeat        text CHECK (repeat IN ('daily', 'weekly', 'once')),
  editor_roles  text[],
  updated_by    uuid NOT NULL REFERENCES app_user(id),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, reminder_key)
);
ALTER TABLE tenant_reminder ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON tenant_reminder USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());
GRANT SELECT, INSERT, UPDATE, DELETE ON tenant_reminder TO erp_app;
