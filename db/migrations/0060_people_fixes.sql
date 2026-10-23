-- Verification fixes (D-161). A reminder set to repeat "once" is kept from repeating by its notification's dedupe key,
-- but retention deletes old notifications, after which the reminder went out again. Before deleting, retention now
-- copies the keys of once-only reminders here, and notify() skips a key already sent to that user.
CREATE TABLE notification_sent_key (
  tenant_id   uuid NOT NULL REFERENCES tenant(id),
  user_id     uuid NOT NULL REFERENCES app_user(id),
  dedupe_key  text NOT NULL,
  sent_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, dedupe_key)
);
ALTER TABLE notification_sent_key ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON notification_sent_key USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());
GRANT SELECT ON notification_sent_key TO erp_app;
