-- Business case revisions kept in full (D-163): when a case is reopened, the revision being closed is stored with its
-- header, every line and its base-case figures, so any two or three plans or revisions can be compared side by side.
CREATE TABLE proforma_revision (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenant(id),
  proforma_id  uuid NOT NULL REFERENCES proforma(id),
  revision     integer NOT NULL,
  status       text NOT NULL,                 -- what the revision had reached: submitted or approved
  header       jsonb NOT NULL,                -- title, kind, start month, horizon, rates, scenarios
  lines        jsonb NOT NULL,
  summary      jsonb NOT NULL,                -- base case: NPV, IRR, payback, funding, revenue, capital
  closed_by    uuid NOT NULL REFERENCES app_user(id),
  closed_at    timestamptz NOT NULL DEFAULT now(),
  reason       text,
  UNIQUE (proforma_id, revision)
);
ALTER TABLE proforma_revision ENABLE ROW LEVEL SECURITY;
CREATE POLICY via_parent ON proforma_revision USING (tenant_id = app_tenant_id() AND EXISTS (SELECT 1 FROM proforma p WHERE p.id = proforma_id))
  WITH CHECK (tenant_id = app_tenant_id() AND EXISTS (SELECT 1 FROM proforma p WHERE p.id = proforma_id));
GRANT SELECT, INSERT ON proforma_revision TO erp_app;
-- Where a line came from when it was pulled in from another module (books, budget, CRM, rent roll, asset, labor).
ALTER TABLE proforma_line ADD COLUMN source text;
