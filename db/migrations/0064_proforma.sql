-- S31 Opportunity pro forma (D-162): a business case for a new site, product line, customer contract or capital
-- project, built from driver lines and projected by scenario. Company-wide opportunities have no site.
CREATE TABLE proforma (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            uuid NOT NULL REFERENCES tenant(id),
  facility_id          uuid REFERENCES facility(id),
  number               text NOT NULL,
  revision             integer NOT NULL DEFAULT 1,
  title                text NOT NULL CHECK (length(trim(title)) >= 3),
  kind                 text NOT NULL CHECK (kind IN ('new_site', 'product_line', 'customer_contract', 'capital_project', 'other')),
  description          text,
  start_month          date NOT NULL CHECK (extract(day FROM start_month) = 1),
  years                integer NOT NULL DEFAULT 5 CHECK (years BETWEEN 1 AND 10),
  discount_rate_pct    numeric(6, 2) NOT NULL DEFAULT 10 CHECK (discount_rate_pct BETWEEN 0 AND 100),
  tax_rate_pct         numeric(6, 2) NOT NULL DEFAULT 25 CHECK (tax_rate_pct BETWEEN 0 AND 100),
  working_capital_days integer NOT NULL DEFAULT 30 CHECK (working_capital_days BETWEEN 0 AND 365),
  scenarios            jsonb NOT NULL,
  status               text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'submitted', 'approved', 'rejected', 'archived')),
  owner_user_id        uuid NOT NULL REFERENCES app_user(id),
  created_by           uuid NOT NULL REFERENCES app_user(id),
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  submitted_at         timestamptz,
  decided_at           timestamptz,
  -- The base case as it was approved, so a later look can compare the plan with what happened.
  approved_summary     jsonb,
  UNIQUE (tenant_id, number)
);
CREATE TABLE proforma_line (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenant(id),
  proforma_id  uuid NOT NULL REFERENCES proforma(id) ON DELETE CASCADE,
  seq          integer NOT NULL,
  section      text NOT NULL CHECK (section IN ('revenue', 'cost_of_sales', 'operating', 'capital')),
  label        text NOT NULL CHECK (length(trim(label)) >= 1),
  method       text NOT NULL CHECK (method IN ('units_price', 'fixed_monthly', 'pct_of_revenue', 'headcount', 'one_time')),
  amount       numeric(16, 4) NOT NULL CHECK (amount >= 0),
  qty          numeric(14, 4) CHECK (qty >= 0),
  growth_pct   numeric(7, 2) CHECK (growth_pct BETWEEN -100 AND 1000),
  start_month  integer NOT NULL DEFAULT 0 CHECK (start_month >= 0),
  end_month    integer CHECK (end_month > start_month),
  ramp_months  integer CHECK (ramp_months BETWEEN 0 AND 120),
  life_years   numeric(5, 2) CHECK (life_years > 0 AND life_years <= 100),
  note         text,
  UNIQUE (proforma_id, seq)
);
-- Lines are frozen once the pro forma is submitted; editing means reopening it as a new revision.
CREATE FUNCTION proforma_line_frozen() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE st text;
BEGIN
  SELECT status INTO st FROM proforma WHERE id = coalesce(NEW.proforma_id, OLD.proforma_id);
  IF st IS NOT NULL AND st <> 'draft' THEN RAISE EXCEPTION 'the pro forma is %; reopen it to change its lines', st; END IF;
  RETURN coalesce(NEW, OLD);
END $$;
CREATE TRIGGER proforma_line_frozen BEFORE INSERT OR UPDATE OR DELETE ON proforma_line FOR EACH ROW EXECUTE FUNCTION proforma_line_frozen();

ALTER TABLE proforma ENABLE ROW LEVEL SECURITY;
ALTER TABLE proforma_line ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_facility ON proforma USING (tenant_id = app_tenant_id() AND (facility_id IS NULL OR app_can_see_facility(facility_id)))
  WITH CHECK (tenant_id = app_tenant_id() AND (facility_id IS NULL OR app_can_see_facility(facility_id)));
CREATE POLICY via_parent ON proforma_line USING (tenant_id = app_tenant_id() AND EXISTS (SELECT 1 FROM proforma p WHERE p.id = proforma_id))
  WITH CHECK (tenant_id = app_tenant_id() AND EXISTS (SELECT 1 FROM proforma p WHERE p.id = proforma_id));
GRANT SELECT, INSERT, UPDATE ON proforma TO erp_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON proforma_line TO erp_app;
CREATE INDEX proforma_line_parent ON proforma_line (proforma_id, seq);

-- Finance and operations build business cases; executives read them.
UPDATE role SET permissions = (SELECT array_agg(DISTINCT p) FROM unnest(permissions || ARRAY['proforma.view', 'proforma.manage']) p)
WHERE key IN ('admin', 'finance_approver', 'operations_manager', 'property_manager');
UPDATE role SET permissions = (SELECT array_agg(DISTINCT p) FROM unnest(permissions || ARRAY['proforma.view']) p)
WHERE key IN ('executive', 'district_manager');
