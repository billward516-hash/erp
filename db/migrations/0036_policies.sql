-- S17b Policies and the employee handbook (D-128, D-129). Policies are versioned text: a draft is edited, published
-- (refused while template placeholders remain), and superseded by the next published version. Published versions that
-- require it are acknowledged by employees; a minor revision can keep earlier acknowledgements.
--
-- The expense policy also has rules the expense module enforces (categories, limits, receipts, mileage, deadlines),
-- kept as settings so the policy text and the checks never disagree: the text shows them live.

CREATE TABLE policy (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                 uuid NOT NULL REFERENCES tenant(id),
  facility_id               uuid REFERENCES facility(id),          -- NULL = company-wide
  number                    text NOT NULL,
  title                     text NOT NULL,
  category                  text NOT NULL CHECK (category IN ('handbook', 'expense', 'hr', 'it', 'safety', 'quality', 'finance', 'other')),
  handbook_order            integer,                              -- position in the employee handbook (handbook category)
  template_key              text,                                 -- the template it started from, if any
  requires_acknowledgement  boolean NOT NULL DEFAULT true,
  owner_user_id             uuid REFERENCES app_user(id),
  current_version_id        uuid,                                 -- latest PUBLISHED version
  archived_at               timestamptz,
  created_by                uuid NOT NULL REFERENCES app_user(id),
  created_at                timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, number),
  UNIQUE (tenant_id, template_key)
);

CREATE TABLE policy_version (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenant(id),
  policy_id        uuid NOT NULL REFERENCES policy(id),
  revision         integer NOT NULL,
  body             text NOT NULL,                                 -- Markdown subset; [[...]] marks a placeholder to complete
  status           text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'superseded')),
  change_summary   text,
  requires_reack   boolean NOT NULL DEFAULT true,                 -- false: a minor revision keeps earlier acknowledgements
  effective_on     date,
  created_by       uuid NOT NULL REFERENCES app_user(id),
  created_at       timestamptz NOT NULL DEFAULT now(),
  published_by     uuid REFERENCES app_user(id),
  published_at     timestamptz,
  UNIQUE (policy_id, revision),
  CHECK (status = 'draft' OR (published_by IS NOT NULL AND published_at IS NOT NULL AND effective_on IS NOT NULL))
);
ALTER TABLE policy ADD CONSTRAINT policy_current_version FOREIGN KEY (current_version_id) REFERENCES policy_version(id);
CREATE UNIQUE INDEX policy_one_draft ON policy_version (policy_id) WHERE status = 'draft';

-- Published text is the record of what people agreed to: it never changes.
CREATE FUNCTION policy_version_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status <> 'draft' THEN RAISE EXCEPTION 'published policy versions cannot be deleted'; END IF;
    RETURN OLD;
  END IF;
  IF OLD.status <> 'draft' AND (NEW.body <> OLD.body OR NEW.revision <> OLD.revision OR NEW.effective_on IS DISTINCT FROM OLD.effective_on) THEN
    RAISE EXCEPTION 'a published policy version cannot be edited; write a new revision';
  END IF;
  IF OLD.status = 'superseded' AND NEW.status <> 'superseded' THEN RAISE EXCEPTION 'a superseded policy version stays superseded'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER policy_version_guard BEFORE UPDATE OR DELETE ON policy_version FOR EACH ROW EXECUTE FUNCTION policy_version_guard();

CREATE TABLE policy_acknowledgement (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenant(id),
  version_id       uuid NOT NULL REFERENCES policy_version(id),
  user_id          uuid NOT NULL REFERENCES app_user(id),
  acknowledged_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (version_id, user_id)
);
CREATE FUNCTION policy_ack_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'acknowledgements are a record and cannot be changed'; END $$;
CREATE TRIGGER policy_ack_immutable BEFORE UPDATE OR DELETE ON policy_acknowledgement FOR EACH ROW EXECUTE FUNCTION policy_ack_immutable();

-- Expense policy rules (enforced by expense reports). A limit left empty means no limit applies.
CREATE TABLE expense_category (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id              uuid NOT NULL REFERENCES tenant(id),
  code                   text NOT NULL,
  name                   text NOT NULL,
  kind                   text NOT NULL DEFAULT 'amount' CHECK (kind IN ('amount', 'mileage')),
  limit_per_item         numeric(12, 2) CHECK (limit_per_item > 0),
  limit_per_day          numeric(12, 2) CHECK (limit_per_day > 0),
  receipt_required_over  numeric(12, 2) CHECK (receipt_required_over >= 0),  -- NULL: the policy-wide threshold
  needs_attendees        boolean NOT NULL DEFAULT false,                       -- business meals: who attended and why
  account_key            text NOT NULL DEFAULT 'travel_expense',
  active                 boolean NOT NULL DEFAULT true,
  sort_order             integer NOT NULL DEFAULT 100,
  UNIQUE (tenant_id, code)
);

CREATE TABLE expense_policy (
  tenant_id               uuid PRIMARY KEY REFERENCES tenant(id),
  receipt_required_over   numeric(12, 2) NOT NULL DEFAULT 25 CHECK (receipt_required_over >= 0),
  mileage_rate            numeric(8, 4) CHECK (mileage_rate > 0),               -- per mile; NULL until the company sets it
  submit_within_days      integer CHECK (submit_within_days > 0),               -- expenses older than this are flagged
  currency                text NOT NULL DEFAULT 'USD',
  notes                   text,
  updated_by              uuid REFERENCES app_user(id),
  updated_at              timestamptz NOT NULL DEFAULT now()
);

DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['policy', 'policy_version', 'policy_acknowledgement', 'expense_category', 'expense_policy'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id())', t);
  END LOOP;
END $$;
GRANT SELECT, INSERT, UPDATE ON policy, policy_version, policy_acknowledgement, expense_category, expense_policy TO erp_app;
GRANT DELETE ON policy_version TO erp_app;

-- Starter expense categories for existing tenants (new tenants get them at provisioning); limits are left for the company to set.
INSERT INTO expense_policy (tenant_id) SELECT id FROM tenant ON CONFLICT DO NOTHING;
INSERT INTO expense_category (tenant_id, code, name, kind, needs_attendees, account_key, sort_order)
SELECT t.id, c.code, c.name, c.kind, c.att, c.acct, c.ord FROM tenant t CROSS JOIN (VALUES
  ('AIR', 'Airfare', 'amount', false, 'travel_expense', 10), ('LODGING', 'Lodging', 'amount', false, 'travel_expense', 20),
  ('MEALS', 'Meals while traveling', 'amount', false, 'travel_expense', 30), ('BIZMEAL', 'Business meals with guests', 'amount', true, 'meals_entertainment', 40),
  ('GROUND', 'Taxi, rideshare, rental car', 'amount', false, 'travel_expense', 50), ('MILEAGE', 'Mileage (personal vehicle)', 'mileage', false, 'travel_expense', 60),
  ('PARKING', 'Parking and tolls', 'amount', false, 'travel_expense', 70), ('SUPPLIES', 'Office and shop supplies', 'amount', false, 'supplies_expense', 80),
  ('TRAINING', 'Training and conferences', 'amount', false, 'training_expense', 90), ('PHONE', 'Phone and internet', 'amount', false, 'telecom_expense', 100),
  ('TOOLS', 'Tools and small equipment', 'amount', false, 'maintenance_expense', 110), ('OTHER', 'Other (explain)', 'amount', false, 'other_expense', 200)
) AS c(code, name, kind, att, acct, ord) ON CONFLICT DO NOTHING;

-- HR (handbook owners) manage policies; administrators already hold every permission through their role update below.
UPDATE role SET permissions = (SELECT array_agg(DISTINCT p) FROM unnest(permissions || ARRAY['policies.manage']) p) WHERE key IN ('admin', 'payroll_admin');
INSERT INTO role (tenant_id, key, name, permissions)
SELECT t.id, 'hr_manager', 'HR Manager', ARRAY['org.view', 'employees.view', 'employees.manage', 'reports.view', 'reports.export', 'learning.view', 'learning.assign',
  'learning.view_records', 'qualifications.view', 'time.view_all', 'policies.manage', 'improve.submit']
FROM tenant t WHERE NOT EXISTS (SELECT 1 FROM role r WHERE r.tenant_id = t.id AND r.key = 'hr_manager');
