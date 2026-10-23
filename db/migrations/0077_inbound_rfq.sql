-- SC-005 B Requests for quote received from customers: due date, owner, bid or no-bid, the quote that answers it, and the outcome.
CREATE TABLE inbound_rfq (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenant(id),
  facility_id      uuid NOT NULL REFERENCES facility(id),
  number           text NOT NULL,
  customer_id      uuid NOT NULL REFERENCES customer(id),
  contact_id       uuid REFERENCES contact(id),
  customer_ref     text,
  subject          text NOT NULL,
  scope            text,
  source           text NOT NULL DEFAULT 'email' CHECK (source IN ('email', 'portal', 'phone', 'meeting', 'other')),
  received_on      date NOT NULL,
  response_due     date NOT NULL,
  status           text NOT NULL DEFAULT 'received' CHECK (status IN ('received', 'bid', 'no_bid', 'quoted', 'won', 'lost', 'cancelled')),
  owner_user_id    uuid NOT NULL REFERENCES app_user(id),
  decision_reason  text,
  decided_by       uuid REFERENCES app_user(id),
  decided_at       timestamptz,
  quote_id         uuid REFERENCES quote(id),
  opportunity_id   uuid REFERENCES opportunity(id),
  quoted_at        timestamptz,
  outcome_reason   text,
  created_by       uuid NOT NULL REFERENCES app_user(id),
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, number),
  CHECK (response_due >= received_on),
  CHECK (status <> 'no_bid' OR length(trim(coalesce(decision_reason, ''))) >= 3)
);
CREATE INDEX ix_inbound_rfq_facility ON inbound_rfq (facility_id);
CREATE INDEX ix_inbound_rfq_customer ON inbound_rfq (customer_id);
CREATE INDEX ix_inbound_rfq_owner ON inbound_rfq (owner_user_id);
CREATE INDEX ix_inbound_rfq_contact ON inbound_rfq (contact_id) WHERE contact_id IS NOT NULL;
CREATE INDEX ix_inbound_rfq_opportunity ON inbound_rfq (opportunity_id) WHERE opportunity_id IS NOT NULL;
CREATE INDEX ix_inbound_rfq_decided_by ON inbound_rfq (decided_by) WHERE decided_by IS NOT NULL;
CREATE INDEX ix_inbound_rfq_created_by ON inbound_rfq (created_by);
CREATE INDEX ix_inbound_rfq_quote ON inbound_rfq (quote_id) WHERE quote_id IS NOT NULL;
CREATE INDEX ix_inbound_rfq_open_due ON inbound_rfq (tenant_id, response_due) WHERE status IN ('received', 'bid');
ALTER TABLE inbound_rfq ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_facility ON inbound_rfq USING (tenant_id = app_tenant_id() AND app_can_see_facility(facility_id)) WITH CHECK (tenant_id = app_tenant_id() AND app_can_see_facility(facility_id));
GRANT SELECT, INSERT, UPDATE ON inbound_rfq TO erp_app;

-- Files that came with the request (drawings, specifications, spreadsheets).
ALTER TABLE attachment DROP CONSTRAINT attachment_subject_type_check;
ALTER TABLE attachment ADD CONSTRAINT attachment_subject_type_check CHECK (subject_type IN ('nonconformance', 'corrective_action', 'safety_incident', 'calibration_record', 'quality_audit', 'fmea', 'continuity_plan', 'continuity_exercise', 'moc_change', 'inbound_rfq'));
