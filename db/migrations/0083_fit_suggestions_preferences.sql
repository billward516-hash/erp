-- SC-004: the fit interview, gentle suggestions and personal display settings.
CREATE TABLE fit_interview (
  tenant_id   uuid PRIMARY KEY REFERENCES tenant(id),
  version     integer NOT NULL,
  answers     jsonb NOT NULL DEFAULT '{}',
  result      jsonb,
  taken_by    uuid NOT NULL REFERENCES app_user(id),
  taken_at    timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_fit_taken_by ON fit_interview (taken_by);
ALTER TABLE fit_interview ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_only ON fit_interview USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());
GRANT SELECT, INSERT, UPDATE ON fit_interview TO erp_app;

CREATE TABLE suggestion_settings (
  tenant_id   uuid PRIMARY KEY REFERENCES tenant(id),
  enabled     boolean NOT NULL DEFAULT true,
  updated_by  uuid NOT NULL REFERENCES app_user(id),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_suggset_updated_by ON suggestion_settings (updated_by);
ALTER TABLE suggestion_settings ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_only ON suggestion_settings USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());
GRANT SELECT, INSERT, UPDATE ON suggestion_settings TO erp_app;

CREATE TABLE suggestion_log (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenant(id),
  user_id        uuid NOT NULL REFERENCES app_user(id),
  rule_key       text NOT NULL,
  evidence       text NOT NULL,
  shown_at       timestamptz NOT NULL DEFAULT now(),
  dismissed_at   timestamptz,
  snoozed_until  timestamptz,
  opened_at      timestamptz
);
CREATE INDEX ix_suglog_tenant ON suggestion_log (tenant_id);
CREATE INDEX ix_suglog_user ON suggestion_log (user_id, shown_at DESC);
ALTER TABLE suggestion_log ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_only ON suggestion_log USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());
GRANT SELECT, INSERT, UPDATE ON suggestion_log TO erp_app;

CREATE TABLE user_preference (
  user_id          uuid PRIMARY KEY REFERENCES app_user(id),
  tenant_id        uuid NOT NULL REFERENCES tenant(id),
  density          text NOT NULL DEFAULT 'normal' CHECK (density IN ('roomy', 'normal', 'compact')),
  text_size        text NOT NULL DEFAULT 'normal' CHECK (text_size IN ('normal', 'large', 'larger')),
  high_contrast    boolean NOT NULL DEFAULT false,
  reduced_motion   boolean NOT NULL DEFAULT false,
  default_view     text NOT NULL DEFAULT 'chart' CHECK (default_view IN ('chart', 'table')),
  suggestions      boolean NOT NULL DEFAULT true,
  updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_userpref_tenant ON user_preference (tenant_id);
ALTER TABLE user_preference ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_only ON user_preference USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());
GRANT SELECT, INSERT, UPDATE ON user_preference TO erp_app;
