-- SC-005 A Request for quote (buyer side): one request to several suppliers, their replies per line, a comparison, an award that
-- becomes a purchase request. The losing bids and the reason for not taking the lowest are kept.
CREATE TABLE rfq (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenant(id),
  facility_id     uuid NOT NULL REFERENCES facility(id),
  number          text NOT NULL,
  title           text NOT NULL,
  status          text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'sent', 'awarded', 'cancelled')),
  needed_by       date,
  respond_by      date,
  notes           text,
  source_request_id uuid REFERENCES purchase_request(id),
  award_request_id  uuid REFERENCES purchase_request(id),
  cancel_reason   text,
  created_by      uuid NOT NULL REFERENCES app_user(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  sent_at         timestamptz,
  awarded_at      timestamptz,
  UNIQUE (tenant_id, number)
);
CREATE TABLE rfq_line (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenant(id),
  rfq_id        uuid NOT NULL REFERENCES rfq(id),
  line_no       integer NOT NULL,
  part_id       uuid REFERENCES part(id),
  description   text NOT NULL,
  qty           numeric NOT NULL CHECK (qty > 0),
  uom           text,
  target_price  numeric CHECK (target_price >= 0),
  awarded_invite_id uuid,
  award_reason  text,
  UNIQUE (rfq_id, line_no)
);
CREATE TABLE rfq_invite (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenant(id),
  rfq_id        uuid NOT NULL REFERENCES rfq(id),
  supplier_id   uuid NOT NULL REFERENCES supplier(id),
  status        text NOT NULL DEFAULT 'invited' CHECK (status IN ('invited', 'responded', 'declined')),
  invited_at    timestamptz NOT NULL DEFAULT now(),
  responded_at  timestamptz,
  freight       numeric NOT NULL DEFAULT 0 CHECK (freight >= 0),
  payment_terms text,
  note          text,
  decline_reason text,
  recorded_by   uuid REFERENCES app_user(id),
  UNIQUE (rfq_id, supplier_id)
);
ALTER TABLE rfq_line ADD CONSTRAINT rfq_line_awarded_fk FOREIGN KEY (awarded_invite_id) REFERENCES rfq_invite(id);
CREATE TABLE rfq_response_line (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenant(id),
  invite_id     uuid NOT NULL REFERENCES rfq_invite(id),
  rfq_line_id   uuid NOT NULL REFERENCES rfq_line(id),
  unit_price    numeric NOT NULL CHECK (unit_price >= 0),
  lead_time_days integer CHECK (lead_time_days >= 0),
  min_qty       numeric CHECK (min_qty >= 0),
  valid_until   date,
  note          text,
  UNIQUE (invite_id, rfq_line_id)
);
CREATE INDEX ix_rfq_facility ON rfq (facility_id);
CREATE INDEX ix_rfq_line_rfq ON rfq_line (rfq_id);
CREATE INDEX ix_rfq_invite_rfq ON rfq_invite (rfq_id);
CREATE INDEX ix_rfq_invite_supplier ON rfq_invite (supplier_id);
CREATE INDEX ix_rfq_response_invite ON rfq_response_line (invite_id);
CREATE INDEX ix_rfq_response_line ON rfq_response_line (rfq_line_id);
CREATE INDEX ix_rfq_source_request ON rfq (source_request_id) WHERE source_request_id IS NOT NULL;
CREATE INDEX ix_rfq_award_request ON rfq (award_request_id) WHERE award_request_id IS NOT NULL;
CREATE INDEX ix_rfq_line_part ON rfq_line (part_id) WHERE part_id IS NOT NULL;
CREATE INDEX ix_rfq_line_awarded ON rfq_line (awarded_invite_id) WHERE awarded_invite_id IS NOT NULL;

ALTER TABLE rfq ENABLE ROW LEVEL SECURITY; ALTER TABLE rfq_line ENABLE ROW LEVEL SECURITY; ALTER TABLE rfq_invite ENABLE ROW LEVEL SECURITY; ALTER TABLE rfq_response_line ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_facility ON rfq USING (tenant_id = app_tenant_id() AND app_can_see_facility(facility_id)) WITH CHECK (tenant_id = app_tenant_id() AND app_can_see_facility(facility_id));
CREATE POLICY via_parent ON rfq_line USING (tenant_id = app_tenant_id() AND EXISTS (SELECT 1 FROM rfq r WHERE r.id = rfq_id)) WITH CHECK (tenant_id = app_tenant_id());
CREATE POLICY via_parent ON rfq_invite USING (tenant_id = app_tenant_id() AND EXISTS (SELECT 1 FROM rfq r WHERE r.id = rfq_id)) WITH CHECK (tenant_id = app_tenant_id());
CREATE POLICY via_parent ON rfq_response_line USING (tenant_id = app_tenant_id() AND EXISTS (SELECT 1 FROM rfq_invite i WHERE i.id = invite_id)) WITH CHECK (tenant_id = app_tenant_id());
GRANT SELECT, INSERT, UPDATE, DELETE ON rfq, rfq_line, rfq_invite, rfq_response_line TO erp_app;
