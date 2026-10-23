-- S29 Justification presentation on changes (D-159). A change carries the deck that argues for it: uploaded (PowerPoint
-- or PDF, kept as attachments with purpose 'justification_presentation', every version retained) or linked (a deck kept
-- in SharePoint, OneDrive or Google Slides). It can change only while the change is a draft, so approvals always refer
-- to the deck reviewers saw.
ALTER TABLE attachment ADD COLUMN purpose text CHECK (purpose IN ('justification_presentation'));
ALTER TABLE attachment DROP CONSTRAINT attachment_subject_type_check;
ALTER TABLE attachment ADD CONSTRAINT attachment_subject_type_check CHECK (subject_type IN ('nonconformance', 'corrective_action', 'safety_incident', 'calibration_record',
  'quality_audit', 'fmea', 'continuity_plan', 'continuity_exercise', 'moc_change'));
ALTER TABLE attachment ADD CONSTRAINT attachment_moc_purpose CHECK (subject_type <> 'moc_change' OR purpose = 'justification_presentation');
ALTER TABLE moc_change ADD COLUMN justification_link text CHECK (justification_link ~ '^https://');
