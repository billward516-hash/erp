-- 0090 People and access (D-183A): custom roles, API token bookkeeping.
-- Starter roles stay what they were (copies of the code templates, read-only through the API); a company's own roles are
-- rows with custom = true and a key that starts with "custom_", so a template key and a custom key can never collide.
ALTER TABLE role ADD COLUMN custom boolean NOT NULL DEFAULT false;
ALTER TABLE role ADD COLUMN description text;
ALTER TABLE role ADD COLUMN created_by uuid REFERENCES app_user(id);
ALTER TABLE role ADD COLUMN updated_at timestamptz;
ALTER TABLE role ADD CONSTRAINT role_custom_key CHECK (custom = (key LIKE 'custom\_%'));
GRANT DELETE ON role TO erp_app;

-- Tokens: who issued and who revoked, and when one was last used (to the minute).
ALTER TABLE api_token ADD COLUMN last_used_at timestamptz;
ALTER TABLE api_token ADD COLUMN created_by uuid REFERENCES app_user(id);
ALTER TABLE api_token ADD COLUMN revoked_by uuid REFERENCES app_user(id);
CREATE INDEX api_token_tenant_kind ON api_token (tenant_id, kind, created_at DESC);

-- Same rules as before (not revoked, not expired, user active, API tokens allowed by the company's sign-in settings),
-- now also noting use. The write happens at most once a minute per token so authentication stays a read in practice.
CREATE OR REPLACE FUNCTION auth_resolve_token(p_hash bytea)
RETURNS TABLE (user_id uuid, tenant_id uuid)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public AS $$
#variable_conflict use_column
DECLARE r record;
BEGIN
  SELECT t.id AS token_id, t.user_id AS uid, t.tenant_id AS tid, t.last_used_at AS used
    INTO r
  FROM api_token t JOIN app_user u ON u.id = t.user_id
  LEFT JOIN tenant_sso s ON s.tenant_id = t.tenant_id AND s.enabled
  WHERE t.token_hash = p_hash
    AND t.revoked_at IS NULL
    AND (t.expires_at IS NULL OR t.expires_at > now())
    AND u.status = 'active'
    AND (t.kind = 'session' OR s.tenant_id IS NULL OR s.allow_tokens);
  IF NOT FOUND THEN RETURN; END IF;
  IF r.used IS NULL OR r.used < now() - interval '1 minute' THEN
    UPDATE api_token SET last_used_at = now() WHERE id = r.token_id;
  END IF;
  RETURN QUERY SELECT r.uid, r.tid;
END $$;
