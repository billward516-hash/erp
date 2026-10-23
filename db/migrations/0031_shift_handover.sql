-- S14a Shift passdown: a handover per site (or area) and shift. Facts are compiled from the records for the shift window
-- and frozen when handed over; items carry into the next handover until resolved; the incoming lead acknowledges.
CREATE TABLE shift_handover (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenant(id),
  facility_id      uuid NOT NULL REFERENCES facility(id),
  area             text NOT NULL DEFAULT 'Whole site',
  shift_label      text NOT NULL,
  period_start     timestamptz NOT NULL,
  period_end       timestamptz NOT NULL,
  notes            text,
  safety_notes     text,
  facts            jsonb NOT NULL DEFAULT '{}',
  status           text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'handed_over', 'acknowledged')),
  written_by       uuid NOT NULL REFERENCES app_user(id),
  handed_over_at   timestamptz,
  acknowledged_by  uuid REFERENCES app_user(id),
  acknowledged_at  timestamptz,
  ack_note         text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  CHECK (period_end > period_start),
  CHECK (acknowledged_by IS NULL OR acknowledged_by <> written_by)
);
CREATE INDEX shift_handover_site ON shift_handover (facility_id, area, period_end DESC);

CREATE TABLE shift_handover_item (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             uuid NOT NULL REFERENCES tenant(id),
  handover_id           uuid NOT NULL REFERENCES shift_handover(id),
  category              text NOT NULL CHECK (category IN ('equipment', 'quality', 'safety', 'production', 'people', 'other')),
  text                  text NOT NULL,
  asset_id              uuid REFERENCES asset(id),
  work_order_id         uuid REFERENCES work_order(id),
  resolved              boolean NOT NULL DEFAULT false,
  resolved_note         text,
  carried_from_item_id  uuid REFERENCES shift_handover_item(id),
  created_by            uuid NOT NULL REFERENCES app_user(id),
  created_at            timestamptz NOT NULL DEFAULT now()
);

-- Once handed over, the handover's words and facts are the record; only acknowledgement changes it.
CREATE FUNCTION shift_handover_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status <> 'draft' AND (NEW.notes IS DISTINCT FROM OLD.notes OR NEW.safety_notes IS DISTINCT FROM OLD.safety_notes OR NEW.facts IS DISTINCT FROM OLD.facts
      OR NEW.period_start IS DISTINCT FROM OLD.period_start OR NEW.period_end IS DISTINCT FROM OLD.period_end) THEN
    RAISE EXCEPTION 'a handed-over shift log cannot be changed';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER shift_handover_guard BEFORE UPDATE ON shift_handover FOR EACH ROW EXECUTE FUNCTION shift_handover_guard();

ALTER TABLE shift_handover ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_facility ON shift_handover USING (tenant_id = app_tenant_id() AND app_can_see_facility(facility_id)) WITH CHECK (tenant_id = app_tenant_id() AND app_can_see_facility(facility_id));
ALTER TABLE shift_handover_item ENABLE ROW LEVEL SECURITY;
CREATE POLICY via_parent ON shift_handover_item USING (tenant_id = app_tenant_id() AND EXISTS (SELECT 1 FROM shift_handover h WHERE h.id = handover_id))
  WITH CHECK (tenant_id = app_tenant_id() AND EXISTS (SELECT 1 FROM shift_handover h WHERE h.id = handover_id));
GRANT SELECT, INSERT, UPDATE ON shift_handover, shift_handover_item TO erp_app;
