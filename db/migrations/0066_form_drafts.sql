-- Unsaved form entries kept on the server (D-164): what a person has typed into a form is saved as they type and comes
-- back when they open the same page again, on any device, until the form is saved or discarded. Private to the person.
CREATE TABLE form_draft (
  tenant_id   uuid NOT NULL REFERENCES tenant(id),
  user_id     uuid NOT NULL REFERENCES app_user(id),
  key         text NOT NULL CHECK (length(key) BETWEEN 1 AND 300),
  path        text NOT NULL CHECK (length(path) BETWEEN 1 AND 300),
  label       text CHECK (length(label) <= 200),
  data        jsonb NOT NULL CHECK (pg_column_size(data) <= 262144),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, user_id, key)
);
ALTER TABLE form_draft ENABLE ROW LEVEL SECURITY;
CREATE POLICY own_drafts ON form_draft USING (tenant_id = app_tenant_id() AND user_id = app_user_id())
  WITH CHECK (tenant_id = app_tenant_id() AND user_id = app_user_id());
GRANT SELECT, INSERT, UPDATE, DELETE ON form_draft TO erp_app;
CREATE INDEX form_draft_updated ON form_draft (tenant_id, updated_at);
