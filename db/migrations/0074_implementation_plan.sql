-- SC-003 Implementation planner: one plan per company, a step per kind of data or connection, owned by a stakeholder role.
-- Progress for data steps is read from the company's committed import batches; the rest is signed off by a person.
CREATE TABLE implementation_plan (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL UNIQUE REFERENCES tenant(id),
  depth           text NOT NULL DEFAULT 'standard' CHECK (depth IN ('guided', 'standard', 'full')),
  target_go_live  date,
  went_live_on    date,
  created_by      uuid NOT NULL REFERENCES app_user(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE implementation_step (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenant(id),
  plan_id          uuid NOT NULL REFERENCES implementation_plan(id),
  step_key         text NOT NULL,
  position         integer NOT NULL,
  status           text NOT NULL DEFAULT 'todo' CHECK (status IN ('todo', 'in_progress', 'loaded', 'verified', 'skipped')),
  assignee_user_id uuid REFERENCES app_user(id),
  expected_count   integer CHECK (expected_count >= 0),
  note             text,
  override_reason  text,
  override_by      uuid REFERENCES app_user(id),
  skipped_reason   text,
  completed_by     uuid REFERENCES app_user(id),
  completed_at     timestamptz,
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (plan_id, step_key)
);
CREATE INDEX ix_implementation_step_plan ON implementation_step (plan_id);
CREATE INDEX ix_implementation_step_assignee ON implementation_step (assignee_user_id) WHERE assignee_user_id IS NOT NULL;

ALTER TABLE implementation_plan ENABLE ROW LEVEL SECURITY;
ALTER TABLE implementation_step ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON implementation_plan USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());
CREATE POLICY tenant_isolation ON implementation_step USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());
GRANT SELECT, INSERT, UPDATE, DELETE ON implementation_plan, implementation_step TO erp_app;
