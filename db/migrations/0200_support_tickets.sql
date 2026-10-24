-- SC-009 P4: support tickets with service levels (feature key `tickets`).
-- Tickets belong to a site and a customer. Service levels set first-response and resolution targets in business hours by priority
-- (optionally per customer); a business-hours calendar and holiday list per site decide when the clock runs. The clock runs while a
-- ticket is new, open or reopened, pauses while it waits on the customer or a third party, and stops at resolution. Due times are
-- computed and stored whenever the clock changes (status, priority), so the queue filters them in SQL.

-- Business hours per site. `days` maps ISO weekday (1 = Monday ... 7 = Sunday) to ["HH:MM", "HH:MM"] (end may be "24:00") or null (closed).
CREATE TABLE ticket_calendar (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenant(id),
  facility_id  uuid NOT NULL REFERENCES facility(id),
  time_zone    text NOT NULL,
  days         jsonb NOT NULL,
  updated_by   uuid NOT NULL REFERENCES app_user(id),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (facility_id)
);

-- Days the business is closed. facility_id null = every site.
CREATE TABLE ticket_holiday (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenant(id),
  facility_id  uuid REFERENCES facility(id),
  day          date NOT NULL,
  name         text NOT NULL,
  created_by   uuid NOT NULL REFERENCES app_user(id),
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ticket_holiday_facility ON ticket_holiday (facility_id);
CREATE UNIQUE INDEX ticket_holiday_day ON ticket_holiday (tenant_id, coalesce(facility_id, '00000000-0000-0000-0000-000000000000'::uuid), day);

-- Targets in business minutes, by priority; a row naming a customer overrides the company-wide row for that customer.
CREATE TABLE ticket_service_level (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id               uuid NOT NULL REFERENCES tenant(id),
  name                    text NOT NULL,
  priority                text NOT NULL CHECK (priority IN ('urgent', 'high', 'normal', 'low')),
  customer_id             uuid REFERENCES customer(id),
  first_response_minutes  integer CHECK (first_response_minutes > 0),
  resolution_minutes      integer CHECK (resolution_minutes > 0),
  at_risk_pct             smallint NOT NULL DEFAULT 80 CHECK (at_risk_pct BETWEEN 1 AND 99),
  active                  boolean NOT NULL DEFAULT true,
  created_by              uuid NOT NULL REFERENCES app_user(id),
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ticket_service_level_customer ON ticket_service_level (customer_id);
CREATE UNIQUE INDEX ticket_service_level_one ON ticket_service_level (tenant_id, priority, coalesce(customer_id, '00000000-0000-0000-0000-000000000000'::uuid)) WHERE active;

CREATE TABLE ticket_category (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL REFERENCES tenant(id),
  name       text NOT NULL,
  sort_no    integer NOT NULL DEFAULT 0,
  active     boolean NOT NULL DEFAULT true,
  UNIQUE (tenant_id, name)
);

CREATE TABLE ticket_canned_reply (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL REFERENCES tenant(id),
  title      text NOT NULL,
  body       text NOT NULL,
  active     boolean NOT NULL DEFAULT true,
  UNIQUE (tenant_id, title)
);

-- A per-customer link for that customer's staff to raise a ticket without signing in (token stored as a hash, like the site request links).
CREATE TABLE ticket_intake_link (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenant(id),
  facility_id  uuid NOT NULL REFERENCES facility(id),
  customer_id  uuid NOT NULL REFERENCES customer(id),
  token_hash   bytea NOT NULL UNIQUE,
  label        text NOT NULL,
  active       boolean NOT NULL DEFAULT true,
  created_by   uuid NOT NULL REFERENCES app_user(id),
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ticket_intake_link_facility ON ticket_intake_link (facility_id);
CREATE INDEX ticket_intake_link_customer ON ticket_intake_link (customer_id);

CREATE TABLE ticket (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                   uuid NOT NULL REFERENCES tenant(id),
  facility_id                 uuid NOT NULL REFERENCES facility(id),
  number                      text NOT NULL,
  customer_id                 uuid NOT NULL REFERENCES customer(id),
  contact_id                  uuid REFERENCES contact(id),
  requester_name              text,
  requester_contact           text,
  subject                     text NOT NULL,
  description                 text,
  priority                    text NOT NULL DEFAULT 'normal' CHECK (priority IN ('urgent', 'high', 'normal', 'low')),
  category_id                 uuid REFERENCES ticket_category(id),
  channel                     text NOT NULL DEFAULT 'email' CHECK (channel IN ('phone', 'email', 'portal', 'in_person', 'public_form')),
  status                      text NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'open', 'waiting_customer', 'waiting_third_party', 'resolved', 'closed', 'reopened')),
  assignee_user_id            uuid REFERENCES app_user(id),
  project_id                  uuid REFERENCES project(id),
  asset_id                    uuid REFERENCES asset(id),
  work_order_id               uuid REFERENCES work_order(id),
  service_visit_id            uuid REFERENCES service_visit(id),
  retainer_covered            boolean NOT NULL DEFAULT false,   -- a flag only; billing logic belongs to the retainer slice
  intake_link_id              uuid REFERENCES ticket_intake_link(id),
  service_level_id            uuid REFERENCES ticket_service_level(id),
  -- Service-level clock. Elapsed counts business minutes while running; the targets are copied from the policy when the ticket is
  -- created and when its priority changes, so editing a policy never moves a promise already made.
  first_response_target_min   integer,
  resolution_target_min       integer,
  at_risk_pct                 smallint NOT NULL DEFAULT 80,
  sla_running_since           timestamptz,
  sla_elapsed_minutes         double precision NOT NULL DEFAULT 0,
  resolution_base_minutes     double precision NOT NULL DEFAULT 0,
  first_response_due_at       timestamptz,
  first_response_risk_at      timestamptz,
  resolution_due_at           timestamptz,
  resolution_risk_at          timestamptz,
  first_responded_at          timestamptz,
  first_response_missed       boolean,
  resolved_at                 timestamptz,
  resolution_missed           boolean,
  closed_at                   timestamptz,
  reopened_count              integer NOT NULL DEFAULT 0,
  status_changed_at           timestamptz NOT NULL DEFAULT now(),
  created_by                  uuid REFERENCES app_user(id),     -- null when raised through a public link
  created_at                  timestamptz NOT NULL DEFAULT now(),
  updated_at                  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, number),
  CHECK (created_by IS NOT NULL OR intake_link_id IS NOT NULL)
);
CREATE INDEX ticket_facility ON ticket (facility_id, status);
CREATE INDEX ticket_customer ON ticket (customer_id);
CREATE INDEX ticket_contact ON ticket (contact_id);
CREATE INDEX ticket_ix_category ON ticket (category_id);
CREATE INDEX ticket_assignee ON ticket (assignee_user_id);
CREATE INDEX ticket_created_by ON ticket (created_by);
CREATE INDEX ticket_project ON ticket (project_id);
CREATE INDEX ticket_asset ON ticket (asset_id);
CREATE INDEX ticket_work_order ON ticket (work_order_id);
CREATE INDEX ticket_service_visit ON ticket (service_visit_id);
CREATE INDEX ticket_ix_intake_link ON ticket (intake_link_id);
CREATE INDEX ticket_ix_service_level ON ticket (service_level_id);

-- The conversation, append-only. A reply is what the customer sees; a note stays inside; an event records what changed and who did it.
CREATE TABLE ticket_entry (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  seq               bigint GENERATED ALWAYS AS IDENTITY,   -- order of arrival, even for entries written in one transaction
  tenant_id         uuid NOT NULL REFERENCES tenant(id),
  ticket_id         uuid NOT NULL REFERENCES ticket(id),
  kind              text NOT NULL CHECK (kind IN ('reply', 'customer_reply', 'note', 'event')),
  customer_visible  boolean NOT NULL,
  author_user_id    uuid REFERENCES app_user(id),
  author_name       text NOT NULL,
  body              text NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (customer_visible = (kind IN ('reply', 'customer_reply')))
);
CREATE INDEX ticket_entry_ticket ON ticket_entry (ticket_id, seq);
CREATE INDEX ticket_entry_author ON ticket_entry (author_user_id);

-- Hours logged on a ticket; each is a time_entry on the person's timesheet for that week.
CREATE TABLE ticket_time (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             uuid NOT NULL REFERENCES tenant(id),
  ticket_id             uuid NOT NULL REFERENCES ticket(id),
  time_entry_id         uuid NOT NULL UNIQUE REFERENCES time_entry(id) ON DELETE CASCADE,
  user_id               uuid NOT NULL REFERENCES app_user(id),
  work_date             date NOT NULL,
  hours                 numeric(6, 2) NOT NULL CHECK (hours > 0 AND hours <= 24),
  billable              boolean NOT NULL DEFAULT false,
  covered_by_retainer   boolean NOT NULL DEFAULT false,
  note                  text,
  created_at            timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ticket_time_ticket ON ticket_time (ticket_id);
CREATE INDEX ticket_time_user ON ticket_time (user_id);

-- Row-level security: everything is the company's; tickets and their calendars also follow the site grants.
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['ticket', 'ticket_calendar', 'ticket_intake_link'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_facility ON %I USING (tenant_id = app_tenant_id() AND app_can_see_facility(facility_id)) WITH CHECK (tenant_id = app_tenant_id() AND app_can_see_facility(facility_id))', t);
  END LOOP;
  FOREACH t IN ARRAY ARRAY['ticket_service_level', 'ticket_category', 'ticket_canned_reply'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id())', t);
  END LOOP;
END $$;
ALTER TABLE ticket_holiday ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_facility ON ticket_holiday USING (tenant_id = app_tenant_id() AND (facility_id IS NULL OR app_can_see_facility(facility_id)))
  WITH CHECK (tenant_id = app_tenant_id() AND (facility_id IS NULL OR app_can_see_facility(facility_id)));
ALTER TABLE ticket_entry ENABLE ROW LEVEL SECURITY;
CREATE POLICY via_parent ON ticket_entry USING (tenant_id = app_tenant_id() AND EXISTS (SELECT 1 FROM ticket t WHERE t.id = ticket_id))
  WITH CHECK (tenant_id = app_tenant_id() AND EXISTS (SELECT 1 FROM ticket t WHERE t.id = ticket_id));
ALTER TABLE ticket_time ENABLE ROW LEVEL SECURITY;
CREATE POLICY via_parent ON ticket_time USING (tenant_id = app_tenant_id() AND EXISTS (SELECT 1 FROM ticket t WHERE t.id = ticket_id))
  WITH CHECK (tenant_id = app_tenant_id() AND EXISTS (SELECT 1 FROM ticket t WHERE t.id = ticket_id));

GRANT SELECT, INSERT, UPDATE ON ticket, ticket_calendar, ticket_service_level, ticket_category, ticket_canned_reply, ticket_intake_link TO erp_app;
GRANT SELECT, INSERT, DELETE ON ticket_holiday, ticket_time TO erp_app;
GRANT SELECT, INSERT ON ticket_entry TO erp_app;   -- append-only: no update, no delete

-- A public link resolves to its tenant, site and customer before any tenant context exists (a definer function that reveals only the ids).
CREATE FUNCTION ticket_intake_resolve(p_hash bytea) RETURNS TABLE (tenant_id uuid, facility_id uuid, customer_id uuid, link_id uuid)
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  SELECT l.tenant_id, l.facility_id, l.customer_id, l.id FROM ticket_intake_link l JOIN facility f ON f.id = l.facility_id JOIN customer c ON c.id = l.customer_id
  WHERE l.token_hash = p_hash AND l.active AND f.active AND c.active
$$;
REVOKE ALL ON FUNCTION ticket_intake_resolve(bytea) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ticket_intake_resolve(bytea) TO erp_app;

-- Files on a ticket use the shared attachment table. The allowed subject list is read from the live constraint and extended, so this
-- migration does not overwrite subjects other changes have added.
DO $$ DECLARE vals text[]; def text; BEGIN
  SELECT pg_get_constraintdef(c.oid) INTO def FROM pg_constraint c WHERE c.conname = 'attachment_subject_type_check' AND c.conrelid = 'attachment'::regclass;
  IF def ~ '\{' THEN
    -- written as ANY ('{a,b,c}'::text[])
    vals := string_to_array(substring(def from '\{([^}]*)\}'), ',');
  ELSE
    -- written as IN ('a', 'b', 'c')
    SELECT array_agg(m[1]) INTO vals FROM regexp_matches(def, '''([a-z_]+)''', 'g') AS m;
  END IF;
  IF NOT ('ticket' = ANY (vals)) THEN vals := vals || 'ticket'::text; END IF;
  ALTER TABLE attachment DROP CONSTRAINT attachment_subject_type_check;
  EXECUTE format('ALTER TABLE attachment ADD CONSTRAINT attachment_subject_type_check CHECK (subject_type = ANY (%L::text[]))', vals);
END $$;

-- Permissions for companies that already exist (new companies get them from the role templates in code).
UPDATE role SET permissions = (SELECT array_agg(DISTINCT p) FROM unnest(permissions || ARRAY['tickets.view', 'tickets.work', 'tickets.manage']) p) WHERE key IN ('admin', 'operations_manager');
UPDATE role SET permissions = (SELECT array_agg(DISTINCT p) FROM unnest(permissions || ARRAY['tickets.view', 'tickets.work']) p) WHERE key = 'service_dispatcher';
UPDATE role SET permissions = (SELECT array_agg(DISTINCT p) FROM unnest(permissions || ARRAY['tickets.view']) p) WHERE key = 'executive';
INSERT INTO role (tenant_id, key, name, permissions)
SELECT t.id, 'support_agent', 'Support Agent', ARRAY['org.view', 'crm.view', 'reports.view', 'documents.view', 'tickets.view', 'tickets.work', 'expenses.submit', 'improve.submit']
FROM tenant t ON CONFLICT (tenant_id, key) DO NOTHING;
INSERT INTO role (tenant_id, key, name, permissions)
SELECT t.id, 'support_manager', 'Support Manager', ARRAY['org.view', 'crm.view', 'reports.view', 'reports.export', 'documents.view', 'tickets.view', 'tickets.work', 'tickets.manage', 'time.approve', 'expenses.submit', 'improve.submit']
FROM tenant t ON CONFLICT (tenant_id, key) DO NOTHING;
