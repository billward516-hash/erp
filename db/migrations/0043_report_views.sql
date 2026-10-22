-- S19b Saved report views (D-144): a name for a report and its filters, kept for the person who saved it or shared
-- with everyone in the company who may run that report. The filters are validated against the report when saved and
-- again when run, so a view never widens what anyone can see (the report's own scope rules still apply).
CREATE TABLE report_view (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenant(id),
  report_id   text NOT NULL,
  name        text NOT NULL CHECK (length(name) BETWEEN 2 AND 80),
  params      jsonb NOT NULL DEFAULT '{}',
  owner_id    uuid NOT NULL REFERENCES app_user(id),
  shared      boolean NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX report_view_name ON report_view (tenant_id, report_id, owner_id, lower(name));
ALTER TABLE report_view ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON report_view USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());
GRANT SELECT, INSERT, UPDATE, DELETE ON report_view TO erp_app;
