-- Verification fixes (D-161), quality. Every effectiveness check is kept: a failed check sends the corrective action
-- back to actions and it may later close as effective, so "how often fixes held" cannot be read from the CAPA's own
-- final state (it always read 100%). Existing checks are recovered from the audit trail.
CREATE TABLE capa_effectiveness_check (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenant(id),
  facility_id uuid NOT NULL REFERENCES facility(id),
  capa_id     uuid NOT NULL REFERENCES corrective_action(id),
  effective   boolean NOT NULL,
  note        text NOT NULL,
  checked_by  uuid REFERENCES app_user(id),
  checked_at  timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE capa_effectiveness_check ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_facility ON capa_effectiveness_check USING (tenant_id = app_tenant_id() AND app_can_see_facility(facility_id))
  WITH CHECK (tenant_id = app_tenant_id() AND app_can_see_facility(facility_id));
GRANT SELECT, INSERT ON capa_effectiveness_check TO erp_app;
CREATE INDEX capa_effectiveness_check_capa ON capa_effectiveness_check (capa_id);
CREATE INDEX capa_effectiveness_check_when ON capa_effectiveness_check (tenant_id, checked_at);

INSERT INTO capa_effectiveness_check (tenant_id, facility_id, capa_id, effective, note, checked_by, checked_at)
SELECT c.tenant_id, c.facility_id, c.id, e.action = 'capa.verified_effective', coalesce(e.data->>'note', ''), e.actor_user_id, e.occurred_at
FROM audit_event e JOIN corrective_action c ON c.id = e.entity_id
WHERE e.entity_type = 'corrective_action' AND e.action IN ('capa.verified_effective', 'capa.verified_not_effective');

-- A revised change rebuilds its pre-startup checklist from the current answers (a change made temporary gains the
-- restore question, one made permanent loses it); the unanswered checklist is replaced when startup is requested.
GRANT DELETE ON moc_pssr_item TO erp_app;

-- Hardening: a single sign-on session is issued only for an active user of that company. The app passes ids it has
-- just resolved, but the function runs with the owner's rights and so checks for itself.
CREATE OR REPLACE FUNCTION sso_issue_session(p_tenant uuid, p_user uuid, p_token_hash bytea, p_hours integer)
RETURNS void LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM app_user WHERE id = p_user AND tenant_id = p_tenant AND status = 'active') THEN
    RAISE EXCEPTION 'not an active user of this company' USING ERRCODE = '42501';
  END IF;
  IF p_hours IS NULL OR p_hours < 1 OR p_hours > 24 * 30 THEN
    RAISE EXCEPTION 'session length out of range' USING ERRCODE = '22023';
  END IF;
  INSERT INTO api_token (tenant_id, user_id, token_hash, label, kind, expires_at)
  VALUES (p_tenant, p_user, p_token_hash, 'Single sign-on session', 'session', now() + make_interval(hours => p_hours));
END $$;
