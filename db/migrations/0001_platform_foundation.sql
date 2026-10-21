-- 0001 Platform foundation: tenancy hierarchy, identity, RBAC, entitlements, audit.
-- Tenant isolation is enforced by PostgreSQL row-level security (RLS). The runtime
-- role (erp_app) is not the table owner and has no BYPASSRLS, so every query —
-- API request or background job — must run inside a transaction that sets
-- app.tenant_id (and facility scope) via set_config(..., true).

CREATE EXTENSION IF NOT EXISTS btree_gist;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'erp_app') THEN
    CREATE ROLE erp_app LOGIN PASSWORD 'erp_app_dev' NOSUPERUSER NOBYPASSRLS;
  END IF;
END $$;

GRANT USAGE ON SCHEMA public TO erp_app;

-- ---------------------------------------------------------------------------
-- Session context helpers (read settings set by the application per transaction)
-- ---------------------------------------------------------------------------
CREATE FUNCTION app_tenant_id() RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT nullif(current_setting('app.tenant_id', true), '')::uuid
$$;

CREATE FUNCTION app_user_id() RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT nullif(current_setting('app.user_id', true), '')::uuid
$$;

CREATE FUNCTION app_all_facilities() RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT coalesce(current_setting('app.all_facilities', true), '') = 'on'
$$;

CREATE FUNCTION app_facility_ids() RETURNS uuid[] LANGUAGE sql STABLE AS $$
  SELECT coalesce(nullif(current_setting('app.facility_ids', true), '')::uuid[], '{}'::uuid[])
$$;

-- NULL facility = tenant-wide record (e.g. part master), visible to any tenant user.
CREATE FUNCTION app_can_see_facility(f uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT f IS NULL OR app_all_facilities() OR f = ANY (app_facility_ids())
$$;

CREATE FUNCTION touch_updated_at() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END $$;

-- ---------------------------------------------------------------------------
-- Tenancy hierarchy: tenant -> legal entity -> facility -> department
-- ---------------------------------------------------------------------------
CREATE TABLE tenant (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug        text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9-]{2,63}$'),
  name        text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE legal_entity (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenant(id),
  name        text NOT NULL,
  country     text NOT NULL DEFAULT 'US',
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, name)
);

CREATE TABLE facility (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenant(id),
  legal_entity_id  uuid NOT NULL REFERENCES legal_entity(id),
  code             text NOT NULL,
  name             text NOT NULL,
  timezone         text NOT NULL DEFAULT 'America/New_York',
  address          jsonb NOT NULL DEFAULT '{}',
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, code)
);

CREATE TABLE department (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenant(id),
  facility_id  uuid REFERENCES facility(id),
  code         text NOT NULL,
  name         text NOT NULL,
  UNIQUE (tenant_id, code)
);

-- Module entitlements are per facility (base subscription covers one licensed facility).
CREATE TABLE facility_entitlement (
  tenant_id    uuid NOT NULL REFERENCES tenant(id),
  facility_id  uuid NOT NULL REFERENCES facility(id),
  module_key   text NOT NULL,
  active_from  date NOT NULL DEFAULT current_date,
  active_to    date,
  PRIMARY KEY (facility_id, module_key)
);

-- ---------------------------------------------------------------------------
-- Workforce identity (minimal; sensitive HR/pay data will live in separate tables)
-- ---------------------------------------------------------------------------
CREATE TABLE employee (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenant(id),
  facility_id      uuid REFERENCES facility(id),
  department_id    uuid REFERENCES department(id),
  employee_number  text NOT NULL,
  first_name       text NOT NULL,
  last_name        text NOT NULL,
  job_title        text,
  email            text,
  status           text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive', 'terminated')),
  hire_date        date,
  custom_fields    jsonb NOT NULL DEFAULT '{}',
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, employee_number)
);
CREATE TRIGGER employee_touch BEFORE UPDATE ON employee FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

CREATE TABLE app_user (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenant(id),
  email         text NOT NULL,
  display_name  text NOT NULL,
  employee_id   uuid REFERENCES employee(id),
  status        text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, email)
);

-- Roles are tenant-owned bundles of permission keys (see src/platform/auth/permissions.ts).
CREATE TABLE role (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenant(id),
  key          text NOT NULL,
  name         text NOT NULL,
  permissions  text[] NOT NULL DEFAULT '{}',
  UNIQUE (tenant_id, key)
);

-- facility_id NULL = role applies at every facility (corporate / consolidated access).
CREATE TABLE user_role_assignment (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenant(id),
  user_id      uuid NOT NULL REFERENCES app_user(id),
  role_id      uuid NOT NULL REFERENCES role(id),
  facility_id  uuid REFERENCES facility(id),
  UNIQUE NULLS NOT DISTINCT (user_id, role_id, facility_id)
);

CREATE TABLE api_token (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenant(id),
  user_id     uuid NOT NULL REFERENCES app_user(id),
  token_hash  bytea NOT NULL UNIQUE,
  label       text NOT NULL,
  expires_at  timestamptz,
  revoked_at  timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- Authentication happens before tenant context exists, so token resolution runs as
-- the owner through a narrow SECURITY DEFINER function rather than relaxing RLS.
CREATE FUNCTION auth_resolve_token(p_hash bytea)
RETURNS TABLE (user_id uuid, tenant_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT t.user_id, t.tenant_id
  FROM api_token t JOIN app_user u ON u.id = t.user_id
  WHERE t.token_hash = p_hash
    AND t.revoked_at IS NULL
    AND (t.expires_at IS NULL OR t.expires_at > now())
    AND u.status = 'active'
$$;
REVOKE ALL ON FUNCTION auth_resolve_token(bytea) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION auth_resolve_token(bytea) TO erp_app;

-- Per-tenant human-readable sequences (WO-000123 etc.).
CREATE TABLE tenant_sequence (
  tenant_id   uuid NOT NULL REFERENCES tenant(id),
  key         text NOT NULL,
  next_value  bigint NOT NULL DEFAULT 1,
  PRIMARY KEY (tenant_id, key)
);

-- ---------------------------------------------------------------------------
-- Audit: append-only, hash-chained per tenant (tamper-evident)
-- ---------------------------------------------------------------------------
CREATE TABLE audit_event (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id      uuid NOT NULL REFERENCES tenant(id),
  facility_id    uuid REFERENCES facility(id),
  occurred_at    timestamptz NOT NULL DEFAULT clock_timestamp(),
  actor_user_id  uuid,
  action         text NOT NULL,
  entity_type    text NOT NULL,
  entity_id      uuid,
  data           jsonb NOT NULL DEFAULT '{}',
  prev_hash      bytea,
  hash           bytea NOT NULL
);
CREATE INDEX audit_event_entity ON audit_event (tenant_id, entity_type, entity_id, id);

-- Timestamp is hashed as epoch microseconds so verification is independent of session TimeZone.
CREATE FUNCTION audit_event_hash(p_prev bytea, p_tenant uuid, p_facility uuid, p_at timestamptz,
                                 p_actor uuid, p_action text, p_type text, p_entity uuid, p_data jsonb)
RETURNS bytea LANGUAGE sql IMMUTABLE AS $$
  SELECT sha256(coalesce(p_prev, '\x'::bytea) ||
    convert_to(concat_ws('|', p_tenant, p_facility, (extract(epoch FROM p_at) * 1000000)::bigint,
                         p_actor, p_action, p_type, p_entity, p_data::text), 'UTF8'))
$$;

CREATE FUNCTION audit_event_chain() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  -- Serialize appends per tenant so the chain is linear.
  PERFORM pg_advisory_xact_lock(hashtextextended('audit:' || NEW.tenant_id::text, 0));
  SELECT hash INTO NEW.prev_hash FROM audit_event
   WHERE tenant_id = NEW.tenant_id ORDER BY id DESC LIMIT 1;
  NEW.hash := audit_event_hash(NEW.prev_hash, NEW.tenant_id, NEW.facility_id, NEW.occurred_at,
                               NEW.actor_user_id, NEW.action, NEW.entity_type, NEW.entity_id, NEW.data);
  RETURN NEW;
END $$;
CREATE TRIGGER audit_event_chain BEFORE INSERT ON audit_event FOR EACH ROW EXECUTE FUNCTION audit_event_chain();

CREATE FUNCTION audit_event_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit_event is append-only';
END $$;
-- Returns the first event id whose stored hash does not match a recomputation, or NULL if intact.
CREATE FUNCTION audit_verify_chain() RETURNS bigint LANGUAGE sql STABLE AS $$
  WITH ordered AS (
    SELECT e.*, lag(hash) OVER (ORDER BY id) AS expected_prev
    FROM audit_event e WHERE tenant_id = app_tenant_id()
  )
  SELECT min(id) FROM ordered
  WHERE prev_hash IS DISTINCT FROM expected_prev
     OR hash <> audit_event_hash(prev_hash, tenant_id, facility_id, occurred_at, actor_user_id,
                                 action, entity_type, entity_id, data)
$$;

CREATE TRIGGER audit_event_no_update BEFORE UPDATE OR DELETE ON audit_event
  FOR EACH ROW EXECUTE FUNCTION audit_event_immutable();
CREATE TRIGGER audit_event_no_truncate BEFORE TRUNCATE ON audit_event
  FOR EACH STATEMENT EXECUTE FUNCTION audit_event_immutable();

-- ---------------------------------------------------------------------------
-- Row-level security
-- ---------------------------------------------------------------------------
ALTER TABLE tenant ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON tenant USING (id = app_tenant_id());

DO $$
DECLARE t text;
BEGIN
  -- Tenant-scoped tables without a facility dimension.
  FOREACH t IN ARRAY ARRAY['legal_entity', 'facility_entitlement', 'app_user', 'role',
                           'user_role_assignment', 'api_token', 'tenant_sequence', 'audit_event']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id())', t);
  END LOOP;
END $$;

-- Facility-scoped: tenant AND facility visibility.
ALTER TABLE facility ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_facility ON facility
  USING (tenant_id = app_tenant_id() AND app_can_see_facility(id))
  WITH CHECK (tenant_id = app_tenant_id());

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['department', 'employee']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_facility ON %I USING (tenant_id = app_tenant_id() AND app_can_see_facility(facility_id)) WITH CHECK (tenant_id = app_tenant_id() AND app_can_see_facility(facility_id))', t);
  END LOOP;
END $$;

-- Runtime privileges. audit_event: insert + select only.
GRANT SELECT, INSERT, UPDATE ON tenant, legal_entity, facility, department, facility_entitlement,
  employee, app_user, role, user_role_assignment, api_token, tenant_sequence TO erp_app;
GRANT DELETE ON user_role_assignment, facility_entitlement TO erp_app;
GRANT SELECT, INSERT ON audit_event TO erp_app;
