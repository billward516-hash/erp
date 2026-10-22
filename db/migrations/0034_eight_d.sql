-- S16a 8D problem solving (D-126): the eight disciplines as a format of the corrective action, not a separate record.
-- Leader = the corrective action's owner; champion and team members are named; the problem is described as is / is not;
-- containment is verified; the root cause is split into why it happened (occurrence) and why it was not caught
-- (escape), each verified; actions are tagged containment, corrective or preventive; read-across asks where else the
-- same cause could act; recognition closes the 8D for the team.
ALTER TABLE corrective_action ADD COLUMN format text NOT NULL DEFAULT 'standard' CHECK (format IN ('standard', 'eight_d'));
ALTER TABLE corrective_action ADD COLUMN champion_user_id uuid REFERENCES app_user(id);
ALTER TABLE corrective_action ADD COLUMN is_is_not jsonb;                 -- { what|where|when|extent: { is, isNot } }
ALTER TABLE corrective_action ADD COLUMN containment_verification text;  -- D3: how we know containment works (sort results, ...)
ALTER TABLE corrective_action ADD COLUMN escape_point text;              -- D4: where it should have been caught
ALTER TABLE corrective_action ADD COLUMN escape_root_cause text;         -- D4: why it was not caught there
ALTER TABLE corrective_action ADD COLUMN root_cause_verification text;   -- D4: how the causes were confirmed (turned on and off, ...)
ALTER TABLE corrective_action ADD COLUMN prevention_note text;           -- D7: systemic changes (FMEA, control plan, procedures) or why none
ALTER TABLE corrective_action ADD COLUMN recognition_note text;          -- D8
ALTER TABLE corrective_action ADD COLUMN recognized_at timestamptz;
ALTER TABLE corrective_action ADD CONSTRAINT corrective_action_champion_not_owner CHECK (champion_user_id IS NULL OR champion_user_id <> owner_user_id);

CREATE TABLE capa_team_member (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenant(id),
  facility_id uuid NOT NULL REFERENCES facility(id),
  capa_id     uuid NOT NULL REFERENCES corrective_action(id),
  user_id     uuid NOT NULL REFERENCES app_user(id),
  expertise   text,                                    -- "process engineer", "operator, line 2"
  added_by    uuid NOT NULL REFERENCES app_user(id),
  added_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (capa_id, user_id)
);

-- D7 read-across: other lines, parts, processes or sites where the same cause could act, each decided.
CREATE TABLE capa_read_across (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenant(id),
  facility_id uuid NOT NULL REFERENCES facility(id),
  capa_id     uuid NOT NULL REFERENCES corrective_action(id),
  scope       text NOT NULL,                           -- "VMC line at Plant 2", "HSG-200 family"
  applies     boolean,                                 -- null until decided
  note        text,
  decided_by  uuid REFERENCES app_user(id),
  decided_at  timestamptz,
  created_by  uuid NOT NULL REFERENCES app_user(id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  CHECK (applies IS NULL OR (note IS NOT NULL AND decided_by IS NOT NULL))
);

ALTER TABLE action_item ADD COLUMN discipline text CHECK (discipline IN ('containment', 'corrective', 'preventive'));

DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['capa_team_member', 'capa_read_across'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_facility ON %I USING (tenant_id = app_tenant_id() AND app_can_see_facility(facility_id)) WITH CHECK (tenant_id = app_tenant_id() AND app_can_see_facility(facility_id))', t);
  END LOOP;
END $$;
GRANT SELECT, INSERT, UPDATE, DELETE ON capa_team_member TO erp_app;
GRANT SELECT, INSERT, UPDATE ON capa_read_across TO erp_app;
CREATE INDEX capa_team_member_user ON capa_team_member (user_id);
