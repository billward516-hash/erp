-- Idempotency keys for requests that clients may send more than once (the technician app replays its offline queue;
-- a lost response must not post labor twice). The first successful response is stored and replayed for the same key.
-- Written and read by the platform outside row-level security; purged after 7 days.
CREATE TABLE idempotency_record (
  tenant_id     uuid NOT NULL REFERENCES tenant(id),
  user_id       uuid NOT NULL REFERENCES app_user(id),
  key           text NOT NULL CHECK (length(key) BETWEEN 8 AND 100),
  method        text NOT NULL,
  path          text NOT NULL,
  status        integer NOT NULL,
  content_type  text,
  body          text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, user_id, key)
);
CREATE INDEX idempotency_record_age ON idempotency_record (created_at);
