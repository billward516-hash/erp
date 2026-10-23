-- S28 Change management to ISO 9001:2015 (D-158). The change record carries the planning ISO 9001 6.3 asks for
-- (purpose and consequences, integrity of the QMS, resources, responsibilities), says whether the change was planned,
-- an emergency or unintended (8.1), and its effect on customers (8.2.4, 8.5.6), and closes with a verified outcome
-- (6.3 a, 9.1). Reviewers' results are recorded with each authorization (8.5.6); the approval engine enforces it.
ALTER TABLE moc_change ADD COLUMN origin text NOT NULL DEFAULT 'planned' CHECK (origin IN ('planned', 'emergency', 'unintended'));
ALTER TABLE moc_change ADD COLUMN consequences text;          -- 6.3 a: potential consequences, intended and unintended
ALTER TABLE moc_change ADD COLUMN qms_impact text;            -- 6.3 b: processes, documents and records of the QMS affected
ALTER TABLE moc_change ADD COLUMN resources text;             -- 6.3 c: people, equipment, budget, time; available?
ALTER TABLE moc_change ADD COLUMN responsibilities text;      -- 6.3 d: who is responsible and authorized, and what moves
ALTER TABLE moc_change ADD COLUMN customer_impact text NOT NULL DEFAULT 'none' CHECK (customer_impact IN ('none', 'notify', 'approval'));
ALTER TABLE moc_change ADD COLUMN customer_note text;         -- which customers, and what they must be told or approve
ALTER TABLE moc_change ADD COLUMN outcome_achieved boolean;   -- at closure: did the change achieve its purpose?
ALTER TABLE moc_change ADD COLUMN effectiveness_note text;    -- the evidence
-- New closures record their outcome; changes closed before this rule are left as they are (NOT VALID).
ALTER TABLE moc_change ADD CONSTRAINT moc_closed_outcome CHECK (status <> 'closed' OR outcome_achieved IS NOT NULL) NOT VALID;

ALTER TABLE moc_action DROP CONSTRAINT moc_action_kind_check;
ALTER TABLE moc_action ADD CONSTRAINT moc_action_kind_check CHECK (kind IN ('document_update', 'training', 'work_order', 'hazard_review', 'inspection', 'communication',
  'restore', 'customer', 'consequence_review', 'other'));
