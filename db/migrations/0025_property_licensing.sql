-- Property management licensing (D-086, founder decision 2026-10-22): properties are licensed in bands of up to
-- 100, not per facility. Active property-kind sites may not exceed bands × band size. The licence is set by the
-- control plane (provisioning, support); tenants read it but cannot change it. Other site kinds are not counted here.

CREATE TABLE tenant_license (
  tenant_id           uuid PRIMARY KEY REFERENCES tenant(id),
  property_band_size  integer NOT NULL DEFAULT 100 CHECK (property_band_size > 0),
  property_bands      integer NOT NULL DEFAULT 1 CHECK (property_bands >= 0),
  notes               text,
  updated_at          timestamptz NOT NULL DEFAULT now()
);
INSERT INTO tenant_license (tenant_id) SELECT id FROM tenant;

ALTER TABLE tenant_license ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON tenant_license USING (tenant_id = app_tenant_id());
GRANT SELECT ON tenant_license TO erp_app;

-- Backstop for every path that creates or reactivates a property (screens, imports, provisioning). Runs as owner so
-- it counts all of the tenant's sites, not only those the user can see, and locks the licence row so two concurrent
-- additions cannot both take the last place.
CREATE FUNCTION facility_property_licence() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  lic tenant_license%ROWTYPE;
  licensed integer;
  used integer;
BEGIN
  IF NEW.kind <> 'property' OR NOT NEW.active THEN RETURN NEW; END IF;
  IF TG_OP = 'UPDATE' AND OLD.kind = 'property' AND OLD.active THEN RETURN NEW; END IF;
  INSERT INTO tenant_license (tenant_id) VALUES (NEW.tenant_id) ON CONFLICT DO NOTHING;
  SELECT * INTO lic FROM tenant_license WHERE tenant_id = NEW.tenant_id FOR UPDATE;
  licensed := lic.property_bands * lic.property_band_size;
  SELECT count(*) INTO used FROM facility WHERE tenant_id = NEW.tenant_id AND kind = 'property' AND active AND id <> NEW.id;
  IF used + 1 > licensed THEN
    RAISE EXCEPTION 'property licence: % of % licensed properties are in use; add a band of % to add more, or deactivate a property you no longer manage',
      used, licensed, lic.property_band_size USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER facility_property_licence BEFORE INSERT OR UPDATE OF kind, active ON facility FOR EACH ROW EXECUTE FUNCTION facility_property_licence();

-- Licence usage for the current tenant, counted over all its sites whatever the reader can see.
CREATE FUNCTION property_licence_usage() RETURNS TABLE (used integer, bands integer, band_size integer)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT (SELECT count(*)::int FROM facility f WHERE f.tenant_id = app_tenant_id() AND f.kind = 'property' AND f.active),
    coalesce(l.property_bands, 1), coalesce(l.property_band_size, 100)
  FROM (SELECT 1) x LEFT JOIN tenant_license l ON l.tenant_id = app_tenant_id()
$$;
REVOKE ALL ON FUNCTION property_licence_usage() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION property_licence_usage() TO erp_app;
