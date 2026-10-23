-- S39 (D-170): read and understood per revision, photos for in-app work instructions, and optional e-signatures.

-- Read and understood: a document can require its audience to read and acknowledge each revision.
ALTER TABLE document ADD COLUMN ack_required boolean NOT NULL DEFAULT false;
ALTER TABLE document ADD COLUMN ack_roles text[] NOT NULL DEFAULT '{}';      -- empty: everyone who may read it at its site
ALTER TABLE document_settings ADD COLUMN ack_days integer NOT NULL DEFAULT 7 CHECK (ack_days BETWEEN 1 AND 90);
ALTER TABLE document_settings ADD COLUMN esign_types text[] NOT NULL DEFAULT '{}';   -- kinds whose approvals need an e-signature

CREATE TABLE document_read_obligation (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenant(id),
  document_id      uuid NOT NULL REFERENCES document(id),
  version_id       uuid NOT NULL REFERENCES document_version(id),
  user_id          uuid NOT NULL REFERENCES app_user(id),
  due_on           date NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  acknowledged_at  timestamptz,
  superseded_at    timestamptz,            -- a newer revision was released before it was read
  UNIQUE (version_id, user_id)
);
CREATE INDEX document_read_open ON document_read_obligation (tenant_id, user_id) WHERE acknowledged_at IS NULL AND superseded_at IS NULL;
-- An acknowledgement is a record: it cannot be changed or removed.
CREATE FUNCTION document_read_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'read-and-understood records cannot be deleted'; END IF;
  IF OLD.acknowledged_at IS NOT NULL AND (NEW.acknowledged_at IS DISTINCT FROM OLD.acknowledged_at OR NEW.version_id <> OLD.version_id OR NEW.user_id <> OLD.user_id) THEN
    RAISE EXCEPTION 'an acknowledgement is a record and cannot be changed';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER document_read_guard BEFORE UPDATE OR DELETE ON document_read_obligation FOR EACH ROW EXECUTE FUNCTION document_read_guard();

-- Photos and drawings used by in-app work instructions; never changed or removed once added.
CREATE TABLE document_media (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenant(id),
  document_id  uuid NOT NULL REFERENCES document(id),
  storage_key  text NOT NULL,
  file_name    text NOT NULL,
  mime_type    text NOT NULL CHECK (mime_type LIKE 'image/%'),
  size_bytes   bigint NOT NULL,
  sha256       text NOT NULL,
  created_by   uuid NOT NULL REFERENCES app_user(id),
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX document_media_doc ON document_media (document_id);

-- Electronic signatures: who signed which exact file (by checksum), with what meaning, when.
CREATE TABLE document_signature (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenant(id),
  document_id     uuid NOT NULL REFERENCES document(id),
  version_id      uuid NOT NULL REFERENCES document_version(id),
  user_id         uuid NOT NULL REFERENCES app_user(id),
  signer_name     text NOT NULL,
  meaning         text NOT NULL CHECK (meaning IN ('reviewed', 'approved')),
  version_sha256  text NOT NULL,
  signed_at       timestamptz NOT NULL DEFAULT now(),
  signature_hash  text NOT NULL,            -- sha256 over document, revision, file checksum, signer, meaning and time
  UNIQUE (version_id, user_id, meaning)
);
CREATE FUNCTION document_record_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION '% is a record and cannot be changed or removed', TG_TABLE_NAME; END $$;
CREATE TRIGGER document_media_immutable BEFORE UPDATE OR DELETE ON document_media FOR EACH ROW EXECUTE FUNCTION document_record_immutable();
CREATE TRIGGER document_signature_immutable BEFORE UPDATE OR DELETE ON document_signature FOR EACH ROW EXECUTE FUNCTION document_record_immutable();

ALTER TABLE document_read_obligation ENABLE ROW LEVEL SECURITY;
ALTER TABLE document_media ENABLE ROW LEVEL SECURITY;
ALTER TABLE document_signature ENABLE ROW LEVEL SECURITY;
CREATE POLICY via_parent ON document_read_obligation USING (tenant_id = app_tenant_id() AND EXISTS (SELECT 1 FROM document d WHERE d.id = document_id))
  WITH CHECK (tenant_id = app_tenant_id() AND EXISTS (SELECT 1 FROM document d WHERE d.id = document_id));
CREATE POLICY via_parent ON document_media USING (tenant_id = app_tenant_id() AND EXISTS (SELECT 1 FROM document d WHERE d.id = document_id))
  WITH CHECK (tenant_id = app_tenant_id() AND EXISTS (SELECT 1 FROM document d WHERE d.id = document_id));
CREATE POLICY via_parent ON document_signature USING (tenant_id = app_tenant_id() AND EXISTS (SELECT 1 FROM document d WHERE d.id = document_id))
  WITH CHECK (tenant_id = app_tenant_id() AND EXISTS (SELECT 1 FROM document d WHERE d.id = document_id));
GRANT SELECT, INSERT, UPDATE ON document_read_obligation TO erp_app;
GRANT SELECT, INSERT ON document_media, document_signature TO erp_app;
