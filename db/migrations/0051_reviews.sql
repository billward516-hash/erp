-- S25b Periodic reviews (D-154). Records that must be reviewed every so often (FMEAs, controlled documents, policies,
-- course content, suppliers, PM plans, spares lists, SPC characteristics, user access and others). The company sets
-- the frequency per kind (tenant_reminder rows keyed 'review:<kind>'); a record may have its own frequency
-- (review_interval). Reviews are recorded append-only; the next one counts from the latest.
ALTER TABLE tenant_reminder ADD COLUMN interval_months integer CHECK (interval_months BETWEEN 1 AND 120);
ALTER TABLE tenant_reminder ADD COLUMN escalate_days integer CHECK (escalate_days BETWEEN 1 AND 365);

CREATE TABLE record_review (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id    uuid NOT NULL REFERENCES tenant(id),
  review_type  text NOT NULL,
  subject_id   uuid NOT NULL,
  facility_id  uuid REFERENCES facility(id),
  reviewed_on  date NOT NULL,
  reviewed_by  uuid NOT NULL REFERENCES app_user(id),
  outcome      text NOT NULL CHECK (outcome IN ('no_change', 'changes_needed')),
  note         text,
  due_on       date,                                   -- when it was due (on time or late, for audits)
  created_at   timestamptz NOT NULL DEFAULT now(),
  CHECK (outcome = 'no_change' OR note IS NOT NULL)
);
CREATE INDEX record_review_subject ON record_review (tenant_id, review_type, subject_id, reviewed_on DESC);
ALTER TABLE record_review ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON record_review USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());
GRANT SELECT, INSERT ON record_review TO erp_app;

CREATE TABLE review_interval (
  tenant_id        uuid NOT NULL REFERENCES tenant(id),
  review_type      text NOT NULL,
  subject_id       uuid NOT NULL,
  interval_months  integer NOT NULL CHECK (interval_months BETWEEN 1 AND 120),
  set_by           uuid NOT NULL REFERENCES app_user(id),
  set_at           timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, review_type, subject_id)
);
ALTER TABLE review_interval ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON review_interval USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());
GRANT SELECT, INSERT, UPDATE, DELETE ON review_interval TO erp_app;
