-- S17e Budgeting (D-133, D-134): spend categories over the platform's account keys, spend history imported from the
-- previous system, and budgets built bottom-up (department lines by month) and top-down (targets), reconciled and then
-- approved and frozen. Actual spend comes from the records (D-133) and the imported history.

CREATE TABLE spend_category (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenant(id),
  code          text NOT NULL,
  name          text NOT NULL,
  account_keys  text[] NOT NULL DEFAULT '{}',     -- platform account keys whose spend lands here
  sort_order    integer NOT NULL DEFAULT 100,
  active        boolean NOT NULL DEFAULT true,
  UNIQUE (tenant_id, code)
);
-- An account key belongs to at most one category (otherwise spend would count twice).
CREATE FUNCTION spend_category_keys_unique() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE k text; other text;
BEGIN
  FOREACH k IN ARRAY NEW.account_keys LOOP
    SELECT code INTO other FROM spend_category WHERE tenant_id = NEW.tenant_id AND id <> NEW.id AND k = ANY (account_keys);
    IF other IS NOT NULL THEN RAISE EXCEPTION 'account % already belongs to spend category %', k, other USING ERRCODE = 'P0001'; END IF;
  END LOOP;
  RETURN NEW;
END $$;
CREATE TRIGGER spend_category_keys_unique BEFORE INSERT OR UPDATE ON spend_category FOR EACH ROW EXECUTE FUNCTION spend_category_keys_unique();

-- Monthly spend from the previous system (GL detail or trial balance by month), classified into spend categories.
CREATE TABLE spend_history (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid NOT NULL REFERENCES tenant(id),
  facility_id        uuid NOT NULL REFERENCES facility(id),
  department_id      uuid REFERENCES department(id),
  spend_category_id  uuid NOT NULL REFERENCES spend_category(id),
  month              date NOT NULL CHECK (extract(day FROM month) = 1),
  amount             numeric(14, 2) NOT NULL,
  account_code       text,                         -- their account number, as it came
  description        text,
  source_system      text NOT NULL,
  ref                text NOT NULL,                -- stable key so a re-import updates instead of duplicating
  created_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, source_system, ref)
);
CREATE INDEX spend_history_month ON spend_history (tenant_id, month);

CREATE TABLE budget (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenant(id),
  fiscal_year   integer NOT NULL CHECK (fiscal_year BETWEEN 2000 AND 2100),
  name          text NOT NULL,
  start_month   integer NOT NULL DEFAULT 1 CHECK (start_month BETWEEN 1 AND 12),   -- fiscal year starts in this calendar month
  status        text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'approved', 'closed')),
  notes         text,
  created_by    uuid NOT NULL REFERENCES app_user(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  approved_by   uuid REFERENCES app_user(id),
  approved_at   timestamptz,
  UNIQUE (tenant_id, fiscal_year, name)
);
-- One approved budget per fiscal year is the one actuals are compared with.
CREATE UNIQUE INDEX budget_one_approved ON budget (tenant_id, fiscal_year) WHERE status = 'approved';

CREATE TABLE budget_target (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid NOT NULL REFERENCES tenant(id),
  budget_id          uuid NOT NULL REFERENCES budget(id),
  facility_id        uuid REFERENCES facility(id),              -- NULL: all sites
  department_id      uuid REFERENCES department(id),            -- NULL: all departments
  spend_category_id  uuid REFERENCES spend_category(id),        -- NULL: all categories
  amount             numeric(14, 2) NOT NULL CHECK (amount >= 0),
  note               text,
  set_by             uuid NOT NULL REFERENCES app_user(id),
  set_at             timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX budget_target_cell ON budget_target (budget_id, coalesce(facility_id, '00000000-0000-0000-0000-000000000000'),
  coalesce(department_id, '00000000-0000-0000-0000-000000000000'), coalesce(spend_category_id, '00000000-0000-0000-0000-000000000000'));

CREATE TABLE budget_line (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid NOT NULL REFERENCES tenant(id),
  budget_id          uuid NOT NULL REFERENCES budget(id),
  facility_id        uuid NOT NULL REFERENCES facility(id),
  department_id      uuid REFERENCES department(id),
  spend_category_id  uuid NOT NULL REFERENCES spend_category(id),
  amounts            numeric(14, 2)[] NOT NULL CHECK (array_length(amounts, 1) = 12),   -- fiscal months 1..12
  basis              text NOT NULL DEFAULT 'manual' CHECK (basis IN ('manual', 'history', 'spread', 'allocated')),
  note               text,
  updated_by         uuid NOT NULL REFERENCES app_user(id),
  updated_at         timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX budget_line_cell ON budget_line (budget_id, facility_id, coalesce(department_id, '00000000-0000-0000-0000-000000000000'), spend_category_id);

-- A site or department's bottom-up budget: drafted by its owner, submitted, accepted or returned by finance.
CREATE TABLE budget_submission (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenant(id),
  budget_id      uuid NOT NULL REFERENCES budget(id),
  facility_id    uuid NOT NULL REFERENCES facility(id),
  department_id  uuid REFERENCES department(id),
  status         text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'submitted', 'accepted', 'returned')),
  note           text,
  submitted_by   uuid REFERENCES app_user(id),
  submitted_at   timestamptz,
  decided_by     uuid REFERENCES app_user(id),
  decided_at     timestamptz,
  decision_note  text
);
CREATE UNIQUE INDEX budget_submission_cell ON budget_submission (budget_id, facility_id, coalesce(department_id, '00000000-0000-0000-0000-000000000000'));

-- An approved (or closed) budget is the record: its lines and targets do not change.
CREATE FUNCTION budget_frozen() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE st text;
BEGIN
  SELECT status INTO st FROM budget WHERE id = coalesce(NEW.budget_id, OLD.budget_id);
  IF st <> 'draft' THEN RAISE EXCEPTION 'the budget is % and cannot change; copy it to a new version', st; END IF;
  RETURN coalesce(NEW, OLD);
END $$;
CREATE TRIGGER budget_line_frozen BEFORE INSERT OR UPDATE OR DELETE ON budget_line FOR EACH ROW EXECUTE FUNCTION budget_frozen();
CREATE TRIGGER budget_target_frozen BEFORE INSERT OR UPDATE OR DELETE ON budget_target FOR EACH ROW EXECUTE FUNCTION budget_frozen();

DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['spend_category', 'budget', 'budget_target'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id())', t);
  END LOOP;
  FOREACH t IN ARRAY ARRAY['spend_history', 'budget_line', 'budget_submission'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_facility ON %I USING (tenant_id = app_tenant_id() AND app_can_see_facility(facility_id)) WITH CHECK (tenant_id = app_tenant_id() AND app_can_see_facility(facility_id))', t);
  END LOOP;
END $$;
GRANT SELECT, INSERT, UPDATE ON spend_category, spend_history, budget, budget_target, budget_line, budget_submission TO erp_app;
GRANT DELETE ON budget_target, budget_line TO erp_app;

-- Starter spend categories for existing tenants (new tenants get them at provisioning).
INSERT INTO spend_category (tenant_id, code, name, account_keys, sort_order)
SELECT t.id, c.code, c.name, c.keys, c.ord FROM tenant t CROSS JOIN (VALUES
  ('MAINT', 'Maintenance and repairs', ARRAY['maintenance_expense'], 10), ('PRODMAT', 'Production materials', ARRAY['production_materials'], 20),
  ('CAPEX', 'Capital equipment and projects', ARRAY['capital_projects'], 30), ('FREIGHT', 'Freight', ARRAY['freight'], 40),
  ('TRAVEL', 'Travel', ARRAY['travel_expense'], 50), ('MEALS', 'Meals and entertainment', ARRAY['meals_entertainment'], 60),
  ('SUPPLIES', 'Supplies', ARRAY['supplies_expense'], 70), ('TRAINING', 'Training', ARRAY['training_expense'], 80),
  ('TELECOM', 'Phone and internet', ARRAY['telecom_expense'], 90), ('UTIL', 'Utilities', ARRAY['utilities_expense'], 100),
  ('SERVICES', 'Contract and professional services', ARRAY['contract_services'], 110), ('OTHER', 'Other', ARRAY['other_expense', 'sales_tax'], 200)
) AS c(code, name, keys, ord) ON CONFLICT DO NOTHING;

UPDATE role SET permissions = (SELECT array_agg(DISTINCT p) FROM unnest(permissions || ARRAY['budgets.view']) p)
  WHERE key IN ('maintenance_manager', 'operations_manager', 'production_supervisor', 'quality_manager', 'executive', 'buyer', 'property_manager', 'sales_manager', 'hr_manager');
UPDATE role SET permissions = (SELECT array_agg(DISTINCT p) FROM unnest(permissions || ARRAY['budgets.view', 'budgets.manage']) p) WHERE key IN ('admin', 'finance_approver');
-- Finance loads spend history from the previous accounting system.
UPDATE role SET permissions = (SELECT array_agg(DISTINCT p) FROM unnest(permissions || ARRAY['imports.run', 'imports.commit']) p) WHERE key = 'finance_approver';
