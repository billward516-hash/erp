-- SC-006 A: barcodes for parts, count schedule and blind counts.
CREATE TABLE part_barcode (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenant(id),
  part_id       uuid NOT NULL REFERENCES part(id),
  code          text NOT NULL,
  kind          text NOT NULL DEFAULT 'supplier' CHECK (kind IN ('upc', 'ean', 'carton', 'supplier', 'internal')),
  qty_per_scan  numeric(14, 3) NOT NULL DEFAULT 1 CHECK (qty_per_scan > 0),
  created_by    uuid NOT NULL REFERENCES app_user(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, code)
);
CREATE INDEX ix_part_barcode_part ON part_barcode (part_id);
CREATE INDEX ix_part_barcode_created_by ON part_barcode (created_by);
ALTER TABLE part_barcode ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_only ON part_barcode USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());
GRANT SELECT, INSERT, DELETE ON part_barcode TO erp_app;

ALTER TABLE inventory_balance ADD COLUMN cycle_count_days integer CHECK (cycle_count_days > 0), ADD COLUMN last_counted_at timestamptz;
ALTER TABLE inventory_count ADD COLUMN blind boolean NOT NULL DEFAULT false;

-- SC-006 B: change notices (ECN and similar) with a tracked distribution list.
CREATE TABLE change_notice (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenant(id),
  facility_id    uuid NOT NULL REFERENCES facility(id),
  number         text NOT NULL,
  kind           text NOT NULL CHECK (kind IN ('ecn', 'pcn', 'supplier_change', 'deviation', 'waiver', 'bulletin', 'other')),
  title          text NOT NULL,
  summary        text NOT NULL,
  what_changed   text,
  effective_on   date,
  ack_due_on     date,
  change_id      uuid REFERENCES moc_change(id),
  document_id    uuid REFERENCES document(id),
  part_id        uuid REFERENCES part(id),
  status         text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'issued', 'closed', 'cancelled')),
  owner_user_id  uuid NOT NULL REFERENCES app_user(id),
  issued_at      timestamptz,
  closed_at      timestamptz,
  close_note     text,
  created_by     uuid NOT NULL REFERENCES app_user(id),
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, number)
);
CREATE INDEX ix_change_notice_facility ON change_notice (facility_id);
CREATE INDEX ix_change_notice_change ON change_notice (change_id) WHERE change_id IS NOT NULL;
CREATE INDEX ix_change_notice_document ON change_notice (document_id) WHERE document_id IS NOT NULL;
CREATE INDEX ix_change_notice_part ON change_notice (part_id) WHERE part_id IS NOT NULL;
CREATE INDEX ix_change_notice_owner ON change_notice (owner_user_id);
CREATE INDEX ix_change_notice_created_by ON change_notice (created_by);
ALTER TABLE change_notice ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_facility ON change_notice USING (tenant_id = app_tenant_id() AND app_can_see_facility(facility_id)) WITH CHECK (tenant_id = app_tenant_id() AND app_can_see_facility(facility_id));
GRANT SELECT, INSERT, UPDATE ON change_notice TO erp_app;

CREATE TABLE change_notice_recipient (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenant(id),
  notice_id      uuid NOT NULL REFERENCES change_notice(id),
  party_type     text NOT NULL CHECK (party_type IN ('user', 'customer', 'supplier', 'other')),
  user_id        uuid REFERENCES app_user(id),
  customer_id    uuid REFERENCES customer(id),
  supplier_id    uuid REFERENCES supplier(id),
  name           text NOT NULL,
  email          text,
  requires_ack   boolean NOT NULL DEFAULT true,
  sent_on        date,
  sent_by        uuid REFERENCES app_user(id),
  ack_on         date,
  ack_by_name    text,
  ack_method     text CHECK (ack_method IN ('in_app', 'email', 'phone', 'signed', 'other')),
  ack_note       text,
  recorded_by    uuid REFERENCES app_user(id),
  UNIQUE (notice_id, name)
);
CREATE INDEX ix_cnr_user ON change_notice_recipient (user_id) WHERE user_id IS NOT NULL;
CREATE INDEX ix_cnr_customer ON change_notice_recipient (customer_id) WHERE customer_id IS NOT NULL;
CREATE INDEX ix_cnr_supplier ON change_notice_recipient (supplier_id) WHERE supplier_id IS NOT NULL;
CREATE INDEX ix_cnr_sent_by ON change_notice_recipient (sent_by) WHERE sent_by IS NOT NULL;
CREATE INDEX ix_cnr_recorded_by ON change_notice_recipient (recorded_by) WHERE recorded_by IS NOT NULL;
ALTER TABLE change_notice_recipient ENABLE ROW LEVEL SECURITY;
CREATE POLICY via_parent ON change_notice_recipient USING (tenant_id = app_tenant_id() AND EXISTS (SELECT 1 FROM change_notice n WHERE n.id = notice_id)) WITH CHECK (tenant_id = app_tenant_id());
GRANT SELECT, INSERT, UPDATE, DELETE ON change_notice_recipient TO erp_app;

ALTER TABLE document_settings ADD COLUMN temp_change_max_days integer NOT NULL DEFAULT 90 CHECK (temp_change_max_days BETWEEN 1 AND 365);

-- SC-006 C: temporary changes to a procedure, with an expiry timer.
CREATE TABLE temporary_change (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL REFERENCES tenant(id),
  facility_id         uuid NOT NULL REFERENCES facility(id),
  number              text NOT NULL,
  document_id         uuid NOT NULL REFERENCES document(id),
  base_version_id     uuid REFERENCES document_version(id),
  title               text NOT NULL,
  what_changes        text NOT NULL,
  reason              text NOT NULL,
  starts_on           date NOT NULL,
  expires_on          date NOT NULL,
  original_expires_on date NOT NULL,
  status              text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'pending_approval', 'approved', 'active', 'expired', 'permanent_pending', 'reverted', 'made_permanent', 'cancelled', 'rejected')),
  owner_user_id       uuid NOT NULL REFERENCES app_user(id),
  change_id           uuid REFERENCES moc_change(id),
  revision            integer NOT NULL DEFAULT 1,
  approver_user_id    uuid REFERENCES app_user(id),
  pending_expires_on  date,
  pending_reason      text,
  extension_count     integer NOT NULL DEFAULT 0,
  activated_at        timestamptz,
  closed_at           timestamptz,
  closed_by           uuid REFERENCES app_user(id),
  close_note          text,
  created_by          uuid NOT NULL REFERENCES app_user(id),
  created_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, number),
  CHECK (expires_on >= starts_on)
);
CREATE INDEX ix_tempchange_facility ON temporary_change (facility_id);
CREATE INDEX ix_tempchange_document ON temporary_change (document_id);
CREATE INDEX ix_tempchange_base_version ON temporary_change (base_version_id) WHERE base_version_id IS NOT NULL;
CREATE INDEX ix_tempchange_owner ON temporary_change (owner_user_id);
CREATE INDEX ix_tempchange_change ON temporary_change (change_id) WHERE change_id IS NOT NULL;
CREATE INDEX ix_tempchange_closed_by ON temporary_change (closed_by) WHERE closed_by IS NOT NULL;
CREATE INDEX ix_tempchange_created_by ON temporary_change (created_by);
CREATE INDEX ix_tempchange_approver ON temporary_change (approver_user_id) WHERE approver_user_id IS NOT NULL;
CREATE INDEX ix_tempchange_live ON temporary_change (tenant_id, expires_on) WHERE status IN ('approved', 'active', 'expired', 'permanent_pending');
ALTER TABLE temporary_change ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_facility ON temporary_change USING (tenant_id = app_tenant_id() AND app_can_see_facility(facility_id)) WITH CHECK (tenant_id = app_tenant_id() AND app_can_see_facility(facility_id));
GRANT SELECT, INSERT, UPDATE ON temporary_change TO erp_app;

CREATE TABLE temporary_change_event (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL REFERENCES tenant(id),
  temporary_change_id uuid NOT NULL REFERENCES temporary_change(id),
  kind                text NOT NULL CHECK (kind IN ('activated', 'extension_requested', 'extended', 'extension_rejected', 'reverted', 'made_permanent', 'cancelled')),
  from_date           date,
  to_date             date,
  reason              text,
  by_user             uuid NOT NULL REFERENCES app_user(id),
  at                  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_tempchange_event_tc ON temporary_change_event (temporary_change_id);
CREATE INDEX ix_tempchange_event_by ON temporary_change_event (by_user);
ALTER TABLE temporary_change_event ENABLE ROW LEVEL SECURITY;
CREATE POLICY via_parent ON temporary_change_event USING (tenant_id = app_tenant_id() AND EXISTS (SELECT 1 FROM temporary_change t WHERE t.id = temporary_change_id)) WITH CHECK (tenant_id = app_tenant_id());
GRANT SELECT, INSERT ON temporary_change_event TO erp_app;

ALTER TABLE attachment DROP CONSTRAINT attachment_subject_type_check;
ALTER TABLE attachment ADD CONSTRAINT attachment_subject_type_check CHECK (subject_type IN ('nonconformance', 'corrective_action', 'safety_incident', 'calibration_record', 'quality_audit', 'fmea', 'continuity_plan', 'continuity_exercise', 'moc_change', 'inbound_rfq', 'quote', 'change_notice', 'temporary_change'));
