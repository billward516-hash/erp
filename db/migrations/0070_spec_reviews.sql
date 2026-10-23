-- S38 Review of external document revisions (D-169). Every new revision of a customer specification or standard
-- opens an impact review, due a set number of working days after it was received (10 by default, IATF 16949
-- 7.5.3.2.2). The revision is not put in force until the review is done; "changes required" names our documents to
-- revise, and each follow-up closes itself when that document releases its next revision.
CREATE TABLE document_settings (
  tenant_id          uuid PRIMARY KEY REFERENCES tenant(id),
  spec_review_days   integer NOT NULL DEFAULT 10 CHECK (spec_review_days BETWEEN 1 AND 60),
  updated_by         uuid NOT NULL REFERENCES app_user(id),
  updated_at         timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE spec_review (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             uuid NOT NULL REFERENCES tenant(id),
  document_id           uuid NOT NULL REFERENCES document(id),
  version_id            uuid NOT NULL UNIQUE REFERENCES document_version(id),
  previous_version_id   uuid REFERENCES document_version(id),
  received_on           date NOT NULL,
  due_on                date NOT NULL,
  status                text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'no_impact', 'changes_required')),
  assigned_to           uuid REFERENCES app_user(id),
  what_changed          text,
  assessment            text,
  customer_due_on       date,               -- when the customer requires the change in place
  moc_change_id         uuid REFERENCES moc_change(id),
  assessed_by           uuid REFERENCES app_user(id),
  assessed_at           timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now(),
  CHECK (status = 'open' OR (assessed_by IS NOT NULL AND assessed_at IS NOT NULL AND length(trim(coalesce(assessment, ''))) >= 5))
);
CREATE INDEX spec_review_open ON spec_review (tenant_id, due_on) WHERE status = 'open';

CREATE TABLE spec_review_followup (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenant(id),
  review_id        uuid NOT NULL REFERENCES spec_review(id),
  document_id      uuid NOT NULL REFERENCES document(id),     -- our document to revise
  owner_user_id    uuid NOT NULL REFERENCES app_user(id),
  due_on           date NOT NULL,
  note             text,
  status           text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'done')),
  done_version_id  uuid REFERENCES document_version(id),
  done_at          timestamptz,
  UNIQUE (review_id, document_id)
);

-- A decided review is a record: its outcome and assessment do not change afterwards.
CREATE FUNCTION spec_review_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status <> 'open' AND (NEW.status <> OLD.status OR NEW.assessment IS DISTINCT FROM OLD.assessment OR NEW.what_changed IS DISTINCT FROM OLD.what_changed
     OR NEW.assessed_by IS DISTINCT FROM OLD.assessed_by) THEN
    RAISE EXCEPTION 'a decided specification review is a record and cannot be changed';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER spec_review_guard BEFORE UPDATE ON spec_review FOR EACH ROW EXECUTE FUNCTION spec_review_guard();

ALTER TABLE document_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE spec_review ENABLE ROW LEVEL SECURITY;
ALTER TABLE spec_review_followup ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON document_settings USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());
CREATE POLICY via_parent ON spec_review USING (tenant_id = app_tenant_id() AND EXISTS (SELECT 1 FROM document d WHERE d.id = document_id))
  WITH CHECK (tenant_id = app_tenant_id() AND EXISTS (SELECT 1 FROM document d WHERE d.id = document_id));
CREATE POLICY via_parent ON spec_review_followup USING (tenant_id = app_tenant_id() AND EXISTS (SELECT 1 FROM spec_review r WHERE r.id = review_id))
  WITH CHECK (tenant_id = app_tenant_id() AND EXISTS (SELECT 1 FROM spec_review r WHERE r.id = review_id));
GRANT SELECT, INSERT, UPDATE ON document_settings, spec_review, spec_review_followup TO erp_app;
