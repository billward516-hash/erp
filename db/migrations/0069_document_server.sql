-- S37 Document server (D-168): the controlled-document repository for SOPs, work instructions, methods and procedures,
-- technical requirements, customer specifications and standards, with folders and read access, review and approval
-- through the approval engine, and an effective date separate from approval.

-- More kinds of controlled document, internal or external (issued by a customer, supplier or standards body).
ALTER TABLE document DROP CONSTRAINT document_doc_type_check;
ALTER TABLE document ADD CONSTRAINT document_doc_type_check CHECK (doc_type IN (
  'sop', 'work_instruction', 'procedure', 'method', 'technical_requirement', 'customer_spec', 'industry_standard', 'form', 'drawing',
  'manual', 'troubleshooting_guide', 'repair_procedure', 'service_bulletin', 'training_material', 'photo', 'video', 'contract', 'other'));
ALTER TABLE document ADD COLUMN origin text NOT NULL DEFAULT 'internal' CHECK (origin IN ('internal', 'external'));
ALTER TABLE document ADD COLUMN issuer text;                          -- external: the customer, supplier or body that owns it
ALTER TABLE document ADD COLUMN issuer_doc_number text;               -- external: their number for it
ALTER TABLE document ADD COLUMN description text;
ALTER TABLE document ADD COLUMN folder_id uuid;
ALTER TABLE document ADD COLUMN read_roles text[] NOT NULL DEFAULT '{}';  -- empty: everyone who may see documents at its site
ALTER TABLE document ADD COLUMN status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'obsolete'));
ALTER TABLE document ADD COLUMN obsoleted_at timestamptz;
ALTER TABLE document ADD COLUMN obsolete_reason text;
-- An approved version that takes effect on a later date waits here; the current version stays in force until then.
ALTER TABLE document ADD COLUMN pending_version_id uuid REFERENCES document_version(id);
ALTER TABLE document ADD CONSTRAINT document_external_issuer CHECK (origin = 'internal' OR issuer IS NOT NULL);

CREATE TABLE document_folder (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenant(id),
  parent_id   uuid REFERENCES document_folder(id),
  name        text NOT NULL CHECK (length(trim(name)) >= 1),
  read_roles  text[] NOT NULL DEFAULT '{}',   -- empty: inherits its parent's (or everyone's)
  created_by  uuid NOT NULL REFERENCES app_user(id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE NULLS NOT DISTINCT (tenant_id, parent_id, name)
);
ALTER TABLE document ADD CONSTRAINT document_folder_fk FOREIGN KEY (folder_id) REFERENCES document_folder(id);
ALTER TABLE document_folder ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON document_folder USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());
GRANT SELECT, INSERT, UPDATE ON document_folder TO erp_app;

ALTER TABLE document_version ADD COLUMN effective_on date;
ALTER TABLE document_version ADD COLUMN issuer_revision text;          -- external: the issuer's revision label
ALTER TABLE document_version ADD COLUMN received_on date;              -- external: when we received this revision
ALTER TABLE document_version ADD COLUMN submitted_by uuid REFERENCES app_user(id);
ALTER TABLE document_version ADD COLUMN submitted_at timestamptz;

-- The released content of a version, and when it takes effect, never change once approved.
CREATE OR REPLACE FUNCTION document_version_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status IN ('approved', 'superseded', 'obsolete') THEN
    IF NEW.storage_key <> OLD.storage_key OR NEW.sha256 <> OLD.sha256 OR NEW.revision <> OLD.revision
       OR NEW.document_id <> OLD.document_id OR NEW.approved_by IS DISTINCT FROM OLD.approved_by
       OR NEW.effective_on IS DISTINCT FROM OLD.effective_on OR NEW.change_summary IS DISTINCT FROM OLD.change_summary THEN
      RAISE EXCEPTION 'released document versions are immutable';
    END IF;
    IF NOT (NEW.status = OLD.status
            OR (OLD.status = 'approved' AND NEW.status IN ('superseded', 'obsolete'))
            OR (OLD.status = 'superseded' AND NEW.status = 'obsolete')) THEN
      RAISE EXCEPTION 'invalid released status transition % -> %', OLD.status, NEW.status;
    END IF;
  END IF;
  RETURN NEW;
END $$;
-- Versions are never deleted: the history is the record.
CREATE FUNCTION document_version_no_delete() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'document versions are a record and cannot be deleted'; END $$;
CREATE TRIGGER document_version_no_delete BEFORE DELETE ON document_version FOR EACH ROW EXECUTE FUNCTION document_version_no_delete();

-- Approved versions whose effective date has come take over from the version in force (run on read and daily).
CREATE FUNCTION document_promote_due() RETURNS integer LANGUAGE plpgsql AS $$
DECLARE n integer := 0; r record;
BEGIN
  FOR r IN SELECT d.id, d.current_version_id, d.pending_version_id FROM document d JOIN document_version p ON p.id = d.pending_version_id
           WHERE d.tenant_id = app_tenant_id() AND p.effective_on <= current_date FOR UPDATE OF d LOOP
    IF r.current_version_id IS NOT NULL THEN UPDATE document_version SET status = 'superseded' WHERE id = r.current_version_id AND status = 'approved'; END IF;
    UPDATE document SET current_version_id = r.pending_version_id, pending_version_id = NULL WHERE id = r.id;
    n := n + 1;
  END LOOP;
  RETURN n;
END $$;
GRANT EXECUTE ON FUNCTION document_promote_due() TO erp_app;
