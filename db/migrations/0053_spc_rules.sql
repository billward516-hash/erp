-- S27 SPC rule selection and daily alarm summary (D-156). Each company chooses which control-chart rules raise alarms
-- (four optional Western Electric / Nelson rules added, off by default), and each characteristic may use its own set.
-- No settings row: the default rules, and an instant notification for every alarm.
ALTER TABLE spc_signal DROP CONSTRAINT spc_signal_rule_check;
ALTER TABLE spc_signal ADD CONSTRAINT spc_signal_rule_check CHECK (rule IN ('beyond_limits', 'run_of_9', 'trend_of_6', 'two_of_three', 'range_beyond', 'out_of_spec',
  'four_of_five', 'eight_beyond_1', 'fifteen_in_c', 'alternating_14'));

ALTER TABLE spc_characteristic ADD COLUMN rules text[];   -- NULL: the company's rules

CREATE TABLE spc_settings (
  tenant_id          uuid PRIMARY KEY REFERENCES tenant(id),
  rules              text[] NOT NULL,
  notify_each_alarm  boolean NOT NULL DEFAULT true,
  updated_by         uuid NOT NULL REFERENCES app_user(id),
  updated_at         timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE spc_settings ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON spc_settings USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());
GRANT SELECT, INSERT, UPDATE ON spc_settings TO erp_app;
