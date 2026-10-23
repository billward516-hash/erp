-- Quote builder: fuller customer-facing content, recorded acceptance, and tracked validity with extensions.
ALTER TABLE quote
  ADD COLUMN lead_time          text,
  ADD COLUMN delivery_terms     text,
  ADD COLUMN inclusions         text,
  ADD COLUMN exclusions         text,
  ADD COLUMN valid_until_original date,
  ADD COLUMN accepted_by_name   text,
  ADD COLUMN accepted_by_title  text,
  ADD COLUMN accepted_on        date,
  ADD COLUMN accepted_method    text CHECK (accepted_method IN ('purchase_order', 'signed_quote', 'email', 'verbal', 'portal')),
  ADD COLUMN accepted_revision  integer,
  ADD COLUMN accepted_total     numeric(14, 2),
  ADD COLUMN acceptance_note    text;
UPDATE quote SET valid_until_original = valid_until;

CREATE TABLE quote_validity_change (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenant(id),
  quote_id    uuid NOT NULL REFERENCES quote(id),
  revision    integer NOT NULL,
  from_date   date,
  to_date     date NOT NULL,
  reason      text NOT NULL,
  changed_by  uuid NOT NULL REFERENCES app_user(id),
  changed_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_quote_validity_quote ON quote_validity_change (quote_id);
CREATE INDEX ix_quote_validity_changed_by ON quote_validity_change (changed_by);
ALTER TABLE quote_validity_change ENABLE ROW LEVEL SECURITY;
CREATE POLICY via_parent ON quote_validity_change USING (tenant_id = app_tenant_id() AND EXISTS (SELECT 1 FROM quote q WHERE q.id = quote_id)) WITH CHECK (tenant_id = app_tenant_id());
GRANT SELECT, INSERT ON quote_validity_change TO erp_app;

-- A signed quote or the customer's purchase order can be filed on the quote.
ALTER TABLE attachment DROP CONSTRAINT attachment_subject_type_check;
ALTER TABLE attachment ADD CONSTRAINT attachment_subject_type_check CHECK (subject_type IN ('nonconformance', 'corrective_action', 'safety_incident', 'calibration_record', 'quality_audit', 'fmea', 'continuity_plan', 'continuity_exercise', 'moc_change', 'inbound_rfq', 'quote'));
