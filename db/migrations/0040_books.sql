-- S17f Lite edition and built-in books (D-135 to D-138).
--
-- Founder decision (2026-10-22): a Lite edition (~$50/month) for very small companies with basic bookkeeping, which
-- connects to the larger feature set when the company is ready. This changes the brief's boundary (§12.7: no native
-- general ledger) for bookkeeping at small-business depth only: chart of accounts, journal, bank feeds and
-- reconciliation, invoices, bills, expenses and payments posted from the operational records, and the standard
-- statements. Still out of scope: payroll processing, tax filing, multi-currency, consolidation, fixed-asset registers.
--
-- The books are an accounting connection like the others (provider 'native_books'): the same outbox events that go to
-- an external system post journal entries here, immediately and in the same transaction.

-- Edition and limits (control plane only). Lite: one active site and five active users. Single-person approval lets a
-- company with one possible approver approve their own claims and bills (audited), when nobody else could.
ALTER TABLE tenant_license ADD COLUMN edition text NOT NULL DEFAULT 'standard' CHECK (edition IN ('lite', 'standard'));
ALTER TABLE tenant_license ADD COLUMN user_cap integer CHECK (user_cap > 0);
ALTER TABLE tenant_license ADD COLUMN site_cap integer CHECK (site_cap > 0);
ALTER TABLE tenant_license ADD COLUMN single_person_approval boolean NOT NULL DEFAULT false;

CREATE FUNCTION licence_user_cap() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE lic tenant_license%ROWTYPE; used integer;
BEGIN
  IF NEW.status <> 'active' THEN RETURN NEW; END IF;
  IF TG_OP = 'UPDATE' AND OLD.status = 'active' THEN RETURN NEW; END IF;
  SELECT * INTO lic FROM tenant_license WHERE tenant_id = NEW.tenant_id FOR UPDATE;
  IF lic.user_cap IS NULL THEN RETURN NEW; END IF;
  SELECT count(*) INTO used FROM app_user WHERE tenant_id = NEW.tenant_id AND status = 'active' AND id <> NEW.id;
  IF used + 1 > lic.user_cap THEN
    RAISE EXCEPTION 'licence: % of % users are active, the most the % edition includes; disable a user or upgrade', used, lic.user_cap, lic.edition USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER app_user_licence_cap BEFORE INSERT OR UPDATE OF status ON app_user FOR EACH ROW EXECUTE FUNCTION licence_user_cap();

CREATE FUNCTION licence_site_cap() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE lic tenant_license%ROWTYPE; used integer;
BEGIN
  IF NOT NEW.active THEN RETURN NEW; END IF;
  IF TG_OP = 'UPDATE' AND OLD.active THEN RETURN NEW; END IF;
  SELECT * INTO lic FROM tenant_license WHERE tenant_id = NEW.tenant_id FOR UPDATE;
  IF lic.site_cap IS NULL THEN RETURN NEW; END IF;
  SELECT count(*) INTO used FROM facility WHERE tenant_id = NEW.tenant_id AND active AND id <> NEW.id;
  IF used + 1 > lic.site_cap THEN
    RAISE EXCEPTION 'licence: the % edition includes % site%; upgrade to add more', lic.edition, lic.site_cap, CASE WHEN lic.site_cap = 1 THEN '' ELSE 's' END USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER facility_licence_site_cap BEFORE INSERT OR UPDATE OF active ON facility FOR EACH ROW EXECUTE FUNCTION licence_site_cap();

CREATE OR REPLACE FUNCTION tenant_edition() RETURNS TABLE (edition text, user_cap integer, site_cap integer, single_person_approval boolean,
  users_active integer, sites_active integer)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT coalesce(l.edition, 'standard'), l.user_cap, l.site_cap, coalesce(l.single_person_approval, false),
    (SELECT count(*)::int FROM app_user u WHERE u.tenant_id = app_tenant_id() AND u.status = 'active'),
    (SELECT count(*)::int FROM facility f WHERE f.tenant_id = app_tenant_id() AND f.active)
  FROM (SELECT 1) x LEFT JOIN tenant_license l ON l.tenant_id = app_tenant_id()
$$;
REVOKE ALL ON FUNCTION tenant_edition() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION tenant_edition() TO erp_app;

-- ---------------------------------------------------------------------------
-- The ledger
-- ---------------------------------------------------------------------------
CREATE TABLE ledger_account (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenant(id),
  code         text NOT NULL,
  name         text NOT NULL,
  type         text NOT NULL CHECK (type IN ('asset', 'liability', 'equity', 'income', 'expense')),
  subtype      text NOT NULL CHECK (subtype IN ('bank', 'credit_card', 'accounts_receivable', 'current_asset', 'inventory', 'fixed_asset', 'accounts_payable',
                 'current_liability', 'long_term_liability', 'equity', 'retained_earnings', 'income', 'other_income', 'cost_of_goods', 'expense', 'other_expense')),
  account_key  text,                                  -- the platform account key that posts here (one account per key)
  system       boolean NOT NULL DEFAULT false,        -- receivables, payables, retained earnings: cannot be deactivated
  active       boolean NOT NULL DEFAULT true,
  bank_last4   text,
  description  text,
  UNIQUE (tenant_id, code)
);
CREATE UNIQUE INDEX ledger_account_key ON ledger_account (tenant_id, account_key) WHERE account_key IS NOT NULL;

CREATE TABLE books_settings (
  tenant_id                uuid PRIMARY KEY REFERENCES tenant(id),
  fiscal_year_start_month  integer NOT NULL DEFAULT 1 CHECK (fiscal_year_start_month BETWEEN 1 AND 12),
  closed_through           date,                     -- no entries on or before this date (period lock)
  default_bank_account_id  uuid REFERENCES ledger_account(id),
  started_on               date NOT NULL DEFAULT current_date,
  updated_by               uuid REFERENCES app_user(id),
  updated_at               timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE journal_entry (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenant(id),
  number        text NOT NULL,
  entry_date    date NOT NULL,
  memo          text NOT NULL,
  source        text NOT NULL CHECK (source IN ('manual', 'opening', 'ar_invoice', 'ar_payment', 'ap_bill', 'ap_payment', 'expense_report', 'expense_payment', 'bank', 'reversal')),
  source_id     uuid,                                -- the invoice, bill, report or bank line it came from
  idempotency_key text,                              -- outbox key: an event posts once
  reverses_id   uuid REFERENCES journal_entry(id),
  reversed_by_id uuid REFERENCES journal_entry(id),
  posted_by     uuid NOT NULL REFERENCES app_user(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, number),
  UNIQUE (tenant_id, idempotency_key)
);
CREATE INDEX journal_entry_date ON journal_entry (tenant_id, entry_date);
CREATE INDEX journal_entry_source ON journal_entry (tenant_id, source, source_id);

CREATE TABLE journal_line (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenant(id),
  entry_id       uuid NOT NULL REFERENCES journal_entry(id),
  line_no        integer NOT NULL,
  account_id     uuid NOT NULL REFERENCES ledger_account(id),
  debit          numeric(14, 2) NOT NULL DEFAULT 0 CHECK (debit >= 0),
  credit         numeric(14, 2) NOT NULL DEFAULT 0 CHECK (credit >= 0),
  memo           text,
  party          text,                               -- customer, supplier or employee name, as posted
  facility_id    uuid REFERENCES facility(id),
  reconciliation_id uuid,                            -- set when a bank line is cleared in a reconciliation
  UNIQUE (entry_id, line_no),
  CHECK ((debit > 0) <> (credit > 0))
);
CREATE INDEX journal_line_account ON journal_line (account_id);

-- Entries balance (checked at commit, after all lines are in), never change once posted (correct by reversal), and
-- never fall in a closed period.
CREATE FUNCTION journal_entry_balanced() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE d numeric; c numeric; n integer;
BEGIN
  SELECT coalesce(sum(debit), 0), coalesce(sum(credit), 0), count(*) INTO d, c, n FROM journal_line WHERE entry_id = NEW.entry_id;
  IF n < 2 OR d <> c THEN RAISE EXCEPTION 'journal entry does not balance: debits % and credits % over % lines', d, c, n; END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER journal_line_balanced AFTER INSERT ON journal_line DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION journal_entry_balanced();

-- The only changes allowed: linking an entry to its reversal, and marking a bank line cleared in a reconciliation.
CREATE FUNCTION journal_entry_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND (to_jsonb(NEW) - 'reversed_by_id') = (to_jsonb(OLD) - 'reversed_by_id') THEN RETURN NEW; END IF;
  RAISE EXCEPTION 'posted journal entries cannot be changed or deleted; post a reversal';
END $$;
CREATE FUNCTION journal_line_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND (to_jsonb(NEW) - 'reconciliation_id') = (to_jsonb(OLD) - 'reconciliation_id') THEN RETURN NEW; END IF;
  RAISE EXCEPTION 'posted journal entries cannot be changed or deleted; post a reversal';
END $$;
CREATE TRIGGER journal_entry_immutable BEFORE UPDATE OR DELETE ON journal_entry FOR EACH ROW EXECUTE FUNCTION journal_entry_immutable();
CREATE TRIGGER journal_line_immutable BEFORE UPDATE OR DELETE ON journal_line FOR EACH ROW EXECUTE FUNCTION journal_line_immutable();

CREATE FUNCTION journal_period_open() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE locked date;
BEGIN
  SELECT closed_through INTO locked FROM books_settings WHERE tenant_id = NEW.tenant_id;
  IF locked IS NOT NULL AND NEW.entry_date <= locked THEN
    RAISE EXCEPTION 'the books are closed through %; date the entry after it', locked USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER journal_entry_period BEFORE INSERT ON journal_entry FOR EACH ROW EXECUTE FUNCTION journal_period_open();

-- ---------------------------------------------------------------------------
-- Banking: statement lines in, matched to entries or categorized into new ones; rules; reconciliations
-- ---------------------------------------------------------------------------
CREATE TABLE bank_rule (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenant(id),
  contains        text NOT NULL CHECK (length(contains) >= 2),     -- matched in the description, case-insensitive
  direction       text NOT NULL DEFAULT 'any' CHECK (direction IN ('in', 'out', 'any')),
  account_id      uuid NOT NULL REFERENCES ledger_account(id),
  payee           text,
  priority        integer NOT NULL DEFAULT 100,
  created_by      uuid NOT NULL REFERENCES app_user(id)
);

CREATE TABLE bank_txn (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenant(id),
  bank_account_id uuid NOT NULL REFERENCES ledger_account(id),
  posted_on       date NOT NULL,
  description     text NOT NULL,
  amount          numeric(14, 2) NOT NULL CHECK (amount <> 0),       -- + money in, - money out
  reference       text,                                              -- check number, bank reference
  source_system   text NOT NULL,
  ref             text NOT NULL,                                     -- stable key from the file, for re-imports
  status          text NOT NULL DEFAULT 'unreviewed' CHECK (status IN ('unreviewed', 'matched', 'categorized', 'excluded')),
  journal_line_id uuid REFERENCES journal_line(id),                  -- the bank-side line it matched or created
  suggested_account_id uuid REFERENCES ledger_account(id),
  suggested_rule_id uuid REFERENCES bank_rule(id),
  reviewed_by     uuid REFERENCES app_user(id),
  reviewed_at     timestamptz,
  exclude_reason  text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, bank_account_id, source_system, ref)
);
CREATE UNIQUE INDEX bank_txn_one_line ON bank_txn (journal_line_id) WHERE journal_line_id IS NOT NULL;

CREATE TABLE bank_reconciliation (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES tenant(id),
  bank_account_id   uuid NOT NULL REFERENCES ledger_account(id),
  statement_date    date NOT NULL,
  statement_balance numeric(14, 2) NOT NULL,
  status            text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'finished')),
  finished_by       uuid REFERENCES app_user(id),
  finished_at       timestamptz,
  created_by        uuid NOT NULL REFERENCES app_user(id),
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX bank_reconciliation_one_open ON bank_reconciliation (bank_account_id) WHERE status = 'open';
ALTER TABLE journal_line ADD CONSTRAINT journal_line_reconciliation FOREIGN KEY (reconciliation_id) REFERENCES bank_reconciliation(id);

ALTER TABLE integration_connection DROP CONSTRAINT integration_connection_provider_check;
ALTER TABLE integration_connection ADD CONSTRAINT integration_connection_provider_check CHECK (provider IN ('file_export', 'mock_accounting', 'native_books'));

DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['ledger_account', 'books_settings', 'journal_entry', 'journal_line', 'bank_rule', 'bank_txn', 'bank_reconciliation'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id())', t);
  END LOOP;
END $$;
GRANT SELECT, INSERT, UPDATE ON ledger_account, books_settings, journal_entry, journal_line, bank_rule, bank_txn, bank_reconciliation TO erp_app;
GRANT DELETE ON bank_rule TO erp_app;
GRANT UPDATE (single_person_approval) ON tenant_license TO erp_app;

UPDATE role SET permissions = (SELECT array_agg(DISTINCT p) FROM unnest(permissions || ARRAY['books.view', 'books.manage']) p) WHERE key = 'admin';
UPDATE role SET permissions = (SELECT array_agg(DISTINCT p) FROM unnest(permissions || ARRAY['books.view']) p) WHERE key IN ('finance_approver', 'executive');
INSERT INTO role (tenant_id, key, name, permissions)
SELECT t.id, 'bookkeeper', 'Bookkeeper', ARRAY['org.view', 'reports.view', 'reports.export', 'imports.run', 'imports.commit', 'books.view', 'books.manage', 'ar.view', 'ar.manage', 'ap.view',
  'ap.manage', 'crm.view', 'crm.manage', 'sales.view', 'purchasing.view', 'purchasing.manage', 'expenses.view_all', 'expenses.manage', 'integrations.manage', 'improve.submit', 'expenses.submit']
FROM tenant t WHERE NOT EXISTS (SELECT 1 FROM role r WHERE r.tenant_id = t.id AND r.key = 'bookkeeper');
