-- S30 CAPA and 8D module (D-160). Corrective actions answer a problem that happened; preventive actions answer one that
-- has not (a risk, an FMEA, a trend, an audit observation). Both run through the same steps and effectiveness check;
-- 8D is for corrective actions only. More sources, each linked back to the record it came from.
ALTER TABLE corrective_action ADD COLUMN action_type text NOT NULL DEFAULT 'corrective' CHECK (action_type IN ('corrective', 'preventive'));
ALTER TABLE corrective_action ADD CONSTRAINT corrective_action_8d_corrective CHECK (action_type = 'corrective' OR format = 'standard');
ALTER TABLE corrective_action DROP CONSTRAINT corrective_action_source_check;
ALTER TABLE corrective_action ADD CONSTRAINT corrective_action_source_check CHECK (source IN ('nonconformance', 'incident', 'customer_complaint', 'audit', 'internal', 'fmea',
  'supplier', 'spc', 'change', 'management_review', 'risk'));
ALTER TABLE corrective_action ADD COLUMN origin_type text CHECK (origin_type IN ('spc_signal', 'moc_change', 'fmea', 'quality_audit'));
ALTER TABLE corrective_action ADD COLUMN origin_id uuid;
ALTER TABLE corrective_action ADD CONSTRAINT corrective_action_origin_pair CHECK ((origin_type IS NULL) = (origin_id IS NULL));
CREATE INDEX corrective_action_origin ON corrective_action (origin_type, origin_id) WHERE origin_id IS NOT NULL;
