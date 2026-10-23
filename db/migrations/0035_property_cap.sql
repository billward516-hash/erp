-- Property licence (D-086 revised by the founder 2026-10-22, D-127): a single cap of 100 active properties per tenant,
-- replacing bands. The cap is stored per tenant (control plane only) and can be lower for a smaller plan, never above 100.
ALTER TABLE tenant_license ADD COLUMN property_cap integer NOT NULL DEFAULT 100 CHECK (property_cap BETWEEN 0 AND 100);
UPDATE tenant_license SET property_cap = least(100, property_bands * property_band_size);
ALTER TABLE tenant_license DROP COLUMN property_bands, DROP COLUMN property_band_size;

CREATE OR REPLACE FUNCTION facility_property_licence() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  lic tenant_license%ROWTYPE;
  used integer;
BEGIN
  IF NEW.kind <> 'property' OR NOT NEW.active THEN RETURN NEW; END IF;
  IF TG_OP = 'UPDATE' AND OLD.kind = 'property' AND OLD.active THEN RETURN NEW; END IF;
  INSERT INTO tenant_license (tenant_id) VALUES (NEW.tenant_id) ON CONFLICT DO NOTHING;
  SELECT * INTO lic FROM tenant_license WHERE tenant_id = NEW.tenant_id FOR UPDATE;
  SELECT count(*) INTO used FROM facility WHERE tenant_id = NEW.tenant_id AND kind = 'property' AND active AND id <> NEW.id;
  IF used + 1 > lic.property_cap THEN
    RAISE EXCEPTION 'property licence: % of % properties are in use, the most the plan covers; deactivate a property you no longer manage to add another',
      used, lic.property_cap USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;

DROP FUNCTION property_licence_usage();
CREATE FUNCTION property_licence_usage() RETURNS TABLE (used integer, cap integer)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT (SELECT count(*)::int FROM facility f WHERE f.tenant_id = app_tenant_id() AND f.kind = 'property' AND f.active), coalesce(l.property_cap, 100)
  FROM (SELECT 1) x LEFT JOIN tenant_license l ON l.tenant_id = app_tenant_id()
$$;
REVOKE ALL ON FUNCTION property_licence_usage() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION property_licence_usage() TO erp_app;
