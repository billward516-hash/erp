-- S17d Expense reports (D-131, D-132). Employees claim business expenses with receipts; the expense policy rules
-- (0036) are checked on submit; approval routes by site, department and amount through the shared approval engine,
-- whose steps may now be addressed to a person (the department head) as well as a role. Approved reports leave for
-- accounting through the outbox like supplier bills; finance records the reimbursement.

-- Approval steps addressed to a named person (or, while a delegation is active, their delegate).
ALTER TABLE approval_step ADD COLUMN assignee_user_id uuid REFERENCES app_user(id);

ALTER TABLE department ADD COLUMN head_user_id uuid REFERENCES app_user(id);

CREATE TABLE expense_approval_rule (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenant(id),
  facility_id    uuid REFERENCES facility(id),            -- NULL = every site
  department_id  uuid REFERENCES department(id),          -- NULL = every department
  min_amount     numeric(14, 2) NOT NULL DEFAULT 0 CHECK (min_amount >= 0),
  stage          integer NOT NULL CHECK (stage BETWEEN 1 AND 9),
  approver       text NOT NULL CHECK (approver IN ('department_head', 'role')),
  role_key       text NOT NULL,                          -- the role; for department_head, who signs when there is no head (or the head is claiming)
  label          text NOT NULL,
  active         boolean NOT NULL DEFAULT true
);

CREATE TABLE expense_report (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid NOT NULL REFERENCES tenant(id),
  facility_id        uuid NOT NULL REFERENCES facility(id),
  department_id      uuid REFERENCES department(id),
  number             text NOT NULL,
  user_id            uuid NOT NULL REFERENCES app_user(id),      -- the claimant
  employee_id        uuid REFERENCES employee(id),
  title              text NOT NULL,
  purpose            text,                                       -- business purpose (trip, project, customer)
  status             text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'submitted', 'approved', 'rejected', 'paid', 'cancelled')),
  revision           integer NOT NULL DEFAULT 1,
  total              numeric(14, 2) NOT NULL DEFAULT 0,
  currency           text NOT NULL DEFAULT 'USD',
  submitted_at       timestamptz,
  approved_at        timestamptz,
  approved_total     numeric(14, 2),
  paid_on            date,
  paid_by            uuid REFERENCES app_user(id),
  payment_method     text CHECK (payment_method IN ('payroll', 'direct_deposit', 'check', 'other')),
  payment_reference  text,
  cancel_reason      text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, number),
  CHECK (status <> 'paid' OR (paid_on IS NOT NULL AND paid_by IS NOT NULL AND payment_method IS NOT NULL))
);
CREATE INDEX expense_report_user ON expense_report (user_id, created_at DESC);

CREATE TABLE expense_line (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenant(id),
  report_id        uuid NOT NULL REFERENCES expense_report(id),
  line_no          integer NOT NULL,
  spent_on         date NOT NULL,
  category_id      uuid NOT NULL REFERENCES expense_category(id),
  merchant         text,
  description      text,
  amount           numeric(12, 2) NOT NULL CHECK (amount >= 0),  -- mileage: miles × rate, set when saved
  miles            numeric(10, 1) CHECK (miles > 0),
  rate             numeric(8, 4),
  attendees        text,                                         -- business meals: who attended and why
  explanation      text,                                         -- answers the policy exceptions on this line
  receipt_blob_key text,
  receipt_name     text,
  receipt_mime     text,
  receipt_sha256   text,
  UNIQUE (report_id, line_no)
);

-- Only a draft's lines change; a submitted, approved or paid claim is what was signed.
CREATE FUNCTION expense_line_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE st text;
BEGIN
  SELECT status INTO st FROM expense_report WHERE id = coalesce(NEW.report_id, OLD.report_id);
  IF st <> 'draft' THEN RAISE EXCEPTION 'expense lines can change only while the report is a draft (it is %)', st; END IF;
  RETURN coalesce(NEW, OLD);
END $$;
CREATE TRIGGER expense_line_guard BEFORE INSERT OR UPDATE OR DELETE ON expense_line FOR EACH ROW EXECUTE FUNCTION expense_line_guard();

DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['expense_report'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_facility ON %I USING (tenant_id = app_tenant_id() AND app_can_see_facility(facility_id)) WITH CHECK (tenant_id = app_tenant_id() AND app_can_see_facility(facility_id))', t);
  END LOOP;
  FOREACH t IN ARRAY ARRAY['expense_line', 'expense_approval_rule'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id())', t);
  END LOOP;
END $$;
GRANT SELECT, INSERT, UPDATE ON expense_report, expense_line, expense_approval_rule TO erp_app;
GRANT DELETE ON expense_line, expense_approval_rule TO erp_app;

-- Starter routing: the department head signs every report; finance from $500; an executive from $5,000.
INSERT INTO expense_approval_rule (tenant_id, min_amount, stage, approver, role_key, label)
SELECT t.id, r.min, r.stage, r.approver, r.role_key, r.label FROM tenant t CROSS JOIN (VALUES
  (0, 1, 'department_head', 'operations_manager', 'Manager approval'), (500, 2, 'role', 'finance_approver', 'Finance review'), (5000, 3, 'role', 'executive', 'Executive approval')
) AS r(min, stage, approver, role_key, label)
WHERE NOT EXISTS (SELECT 1 FROM expense_approval_rule x WHERE x.tenant_id = t.id);

UPDATE role SET permissions = (SELECT array_agg(DISTINCT p) FROM unnest(permissions || ARRAY['expenses.submit']) p);
UPDATE role SET permissions = (SELECT array_agg(DISTINCT p) FROM unnest(permissions || ARRAY['expenses.view_all', 'expenses.manage']) p) WHERE key IN ('admin', 'finance_approver', 'ap_clerk');
