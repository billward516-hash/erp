-- SC-003 Practice copy: a separate company a customer rehearses its data loads in. Platform table (read and written through the
-- platform's own connection), one practice copy per real company.
CREATE TABLE rehearsal_copy (
  tenant_id           uuid PRIMARY KEY REFERENCES tenant(id),
  practice_tenant_id  uuid NOT NULL UNIQUE REFERENCES tenant(id),
  mode                text NOT NULL CHECK (mode IN ('blank', 'sample')),
  created_by          uuid NOT NULL REFERENCES app_user(id),
  created_at          timestamptz NOT NULL DEFAULT now(),
  loaded              jsonb NOT NULL DEFAULT '{}'
);
GRANT SELECT ON rehearsal_copy TO erp_app;
