-- S18b Single sign-on through the company's own identity provider (OpenID Connect, D-140). Provider-independent: any
-- issuer with discovery, an authorization-code flow with PKCE, and signed ID tokens. Sign-in happens before a tenant
-- context exists, so the steps that need data run through narrow SECURITY DEFINER functions, as token resolution does.
CREATE TABLE tenant_sso (
  tenant_id          uuid PRIMARY KEY REFERENCES tenant(id),
  issuer             text NOT NULL CHECK (issuer ~ '^https?://'),
  client_id          text NOT NULL,
  client_secret_enc  bytea,                                  -- AES-256-GCM with the server key; NULL for a public client
  email_domains      text[] NOT NULL DEFAULT '{}',           -- lower-case; finds the company from a work email
  link_by_email      boolean NOT NULL DEFAULT true,          -- first sign-in links an existing user with that verified email
  enabled            boolean NOT NULL DEFAULT false,
  allow_tokens       boolean NOT NULL DEFAULT true,          -- API tokens keep working (integrations, scripts)
  updated_by         uuid NOT NULL REFERENCES app_user(id),
  updated_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX tenant_sso_domains ON tenant_sso USING gin (email_domains);

-- A work-email domain belongs to one company (checked across tenants, so the check runs as the owner).
CREATE FUNCTION tenant_sso_domains_unique() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE d text;
BEGIN
  SELECT x INTO d FROM unnest(NEW.email_domains) x WHERE EXISTS (SELECT 1 FROM tenant_sso o WHERE o.tenant_id <> NEW.tenant_id AND x = ANY (o.email_domains)) LIMIT 1;
  IF d IS NOT NULL THEN RAISE EXCEPTION 'the email domain % is already used by another company', d USING ERRCODE = '23505'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER tenant_sso_domains_unique BEFORE INSERT OR UPDATE ON tenant_sso FOR EACH ROW EXECUTE FUNCTION tenant_sso_domains_unique();

ALTER TABLE app_user ADD COLUMN sso_issuer text;
ALTER TABLE app_user ADD COLUMN sso_subject text;
CREATE UNIQUE INDEX app_user_sso ON app_user (sso_issuer, sso_subject) WHERE sso_subject IS NOT NULL;
ALTER TABLE api_token ADD COLUMN kind text NOT NULL DEFAULT 'api' CHECK (kind IN ('api', 'session'));

-- A sign-in in progress: single use, ten minutes. Only the hash of the state is stored.
CREATE TABLE sso_login (
  state_hash   bytea PRIMARY KEY,
  tenant_id    uuid NOT NULL REFERENCES tenant(id),
  verifier     text NOT NULL,                                -- PKCE code verifier
  nonce        text NOT NULL,
  return_to    text NOT NULL DEFAULT '/' CHECK (return_to ~ '^/[^/\\]'  OR return_to = '/'),
  expires_at   timestamptz NOT NULL DEFAULT now() + interval '10 minutes'
);

ALTER TABLE tenant_sso ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON tenant_sso USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());
GRANT SELECT, INSERT, UPDATE ON tenant_sso TO erp_app;
-- sso_login is reached only through the functions below.
ALTER TABLE sso_login ENABLE ROW LEVEL SECURITY;

-- The provider settings for a company, found by its slug, a work-email domain or its id (enabled only).
CREATE FUNCTION sso_config(p_slug text, p_domain text, p_tenant uuid DEFAULT NULL)
RETURNS TABLE (tenant_id uuid, slug text, tenant_name text, issuer text, client_id text, client_secret_enc bytea)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT t.id, t.slug, t.name, s.issuer, s.client_id, s.client_secret_enc
  FROM tenant_sso s JOIN tenant t ON t.id = s.tenant_id
  WHERE s.enabled AND ((p_slug IS NOT NULL AND t.slug = p_slug) OR (p_domain IS NOT NULL AND lower(p_domain) = ANY (s.email_domains)) OR t.id = p_tenant)
  LIMIT 1
$$;

CREATE FUNCTION sso_begin(p_state_hash bytea, p_tenant uuid, p_verifier text, p_nonce text, p_return_to text)
RETURNS void LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = public AS $$
  DELETE FROM sso_login WHERE expires_at < now();
  INSERT INTO sso_login (state_hash, tenant_id, verifier, nonce, return_to) VALUES (p_state_hash, p_tenant, p_verifier, p_nonce, p_return_to);
$$;

-- Takes (and deletes) a sign-in in progress: a state works once.
CREATE FUNCTION sso_take(p_state_hash bytea)
RETURNS TABLE (tenant_id uuid, verifier text, nonce text, return_to text)
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = public AS $$
  DELETE FROM sso_login l WHERE l.state_hash = p_state_hash AND l.expires_at > now() RETURNING l.tenant_id, l.verifier, l.nonce, l.return_to
$$;

-- The active user for a verified identity: by issuer and subject, else (first sign-in) by a verified email when the
-- company allows linking, recording the identity. No user is ever created here: people are added by an administrator.
CREATE FUNCTION sso_resolve_user(p_tenant uuid, p_issuer text, p_subject text, p_email text, p_email_verified boolean)
RETURNS TABLE (user_id uuid, how text)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public AS $$
DECLARE u record;
BEGIN
  SELECT id, status INTO u FROM app_user WHERE tenant_id = p_tenant AND sso_issuer = p_issuer AND sso_subject = p_subject;
  IF FOUND THEN
    IF u.status = 'active' THEN RETURN QUERY SELECT u.id, 'subject'::text; END IF;
    RETURN;
  END IF;
  IF p_email IS NULL OR NOT p_email_verified OR NOT (SELECT link_by_email FROM tenant_sso WHERE tenant_id = p_tenant) THEN RETURN; END IF;
  SELECT id, status INTO u FROM app_user WHERE tenant_id = p_tenant AND lower(email) = lower(p_email) AND sso_subject IS NULL;
  IF NOT FOUND OR u.status <> 'active' THEN RETURN; END IF;
  UPDATE app_user SET sso_issuer = p_issuer, sso_subject = p_subject WHERE id = u.id;
  RETURN QUERY SELECT u.id, 'email'::text;
END $$;

CREATE FUNCTION sso_issue_session(p_tenant uuid, p_user uuid, p_token_hash bytea, p_hours integer)
RETURNS void LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = public AS $$
  INSERT INTO api_token (tenant_id, user_id, token_hash, label, kind, expires_at)
  VALUES (p_tenant, p_user, p_token_hash, 'Single sign-on session', 'session', now() + make_interval(hours => p_hours));
$$;

-- Token resolution now also refuses API tokens when the company has turned them off for single sign-on.
CREATE OR REPLACE FUNCTION auth_resolve_token(p_hash bytea)
RETURNS TABLE (user_id uuid, tenant_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT t.user_id, t.tenant_id
  FROM api_token t JOIN app_user u ON u.id = t.user_id
  LEFT JOIN tenant_sso s ON s.tenant_id = t.tenant_id AND s.enabled
  WHERE t.token_hash = p_hash
    AND t.revoked_at IS NULL
    AND (t.expires_at IS NULL OR t.expires_at > now())
    AND u.status = 'active'
    AND (t.kind = 'session' OR s.tenant_id IS NULL OR s.allow_tokens)
$$;

-- Signing out ends the session token that made the request (API tokens are revoked by an administrator).
CREATE FUNCTION auth_revoke_token(p_hash bytea)
RETURNS void LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = public AS $$
  UPDATE api_token SET revoked_at = now() WHERE token_hash = p_hash AND kind = 'session' AND revoked_at IS NULL;
$$;

DO $$ DECLARE f text; BEGIN
  FOREACH f IN ARRAY ARRAY['sso_config(text, text, uuid)', 'sso_begin(bytea, uuid, text, text, text)', 'sso_take(bytea)', 'sso_resolve_user(uuid, text, text, text, boolean)',
    'sso_issue_session(uuid, uuid, bytea, integer)', 'auth_revoke_token(bytea)'] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO erp_app', f);
  END LOOP;
END $$;
