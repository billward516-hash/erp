-- 0011 Notifications (shared Category 1 service): in-app notifications, a daily reminder sweep, and a
-- daily email digest queued for a mail adapter. No email provider is connected yet: the development
-- adapter writes .eml files locally; a hosted adapter (SES/SMTP) replaces it (D-045).

CREATE TABLE notification (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id     uuid NOT NULL REFERENCES tenant(id),
  user_id       uuid NOT NULL REFERENCES app_user(id),
  kind          text NOT NULL,                  -- approval.waiting, approval.decided, work_order.assigned, reminder.pm_due, ...
  title         text NOT NULL,
  body          text,
  link          text,                           -- in-app path, e.g. /purchasing/requests/<id>
  subject_type  text,
  subject_id    uuid,
  dedupe_key    text,                           -- the same reminder is not repeated (per user)
  created_at    timestamptz NOT NULL DEFAULT now(),
  read_at       timestamptz,
  emailed_at    timestamptz,
  UNIQUE (user_id, dedupe_key)
);
CREATE INDEX notification_unread ON notification (user_id, created_at DESC) WHERE read_at IS NULL;

CREATE TABLE notification_preference (
  tenant_id     uuid NOT NULL REFERENCES tenant(id),
  user_id       uuid PRIMARY KEY REFERENCES app_user(id),
  email_digest  boolean NOT NULL DEFAULT true,
  muted_kinds   text[] NOT NULL DEFAULT '{}'
);

CREATE TABLE email_message (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id   uuid NOT NULL REFERENCES tenant(id),
  user_id     uuid NOT NULL REFERENCES app_user(id),
  to_address  text NOT NULL,
  subject     text NOT NULL,
  body_text   text NOT NULL,
  kind        text NOT NULL DEFAULT 'digest',
  dedupe_key  text NOT NULL,
  status      text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'sent', 'failed')),
  attempts    integer NOT NULL DEFAULT 0,
  last_error  text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  sent_at     timestamptz,
  UNIQUE (tenant_id, dedupe_key)
);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['notification', 'notification_preference', 'email_message']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id())', t);
  END LOOP;
END $$;
GRANT SELECT, INSERT, UPDATE ON notification, notification_preference, email_message TO erp_app;
