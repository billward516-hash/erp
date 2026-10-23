-- Store licence (O-7, founder 2026-10-23, D-157): a cap of 5 active stores per company, like the property cap (D-127).
-- Stored per tenant (control plane only); may be lower for a smaller plan, never above 5. Inactive stores do not count.
ALTER TABLE tenant_license ADD COLUMN store_cap integer NOT NULL DEFAULT 5 CHECK (store_cap BETWEEN 0 AND 5);

CREATE OR REPLACE FUNCTION facility_store_licence() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  lic tenant_license%ROWTYPE;
  used integer;
BEGIN
  IF NEW.kind <> 'store' OR NOT NEW.active THEN RETURN NEW; END IF;
  IF TG_OP = 'UPDATE' AND OLD.kind = 'store' AND OLD.active THEN RETURN NEW; END IF;
  INSERT INTO tenant_license (tenant_id) VALUES (NEW.tenant_id) ON CONFLICT DO NOTHING;
  SELECT * INTO lic FROM tenant_license WHERE tenant_id = NEW.tenant_id FOR UPDATE;
  SELECT count(*) INTO used FROM facility WHERE tenant_id = NEW.tenant_id AND kind = 'store' AND active AND id <> NEW.id;
  IF used + 1 > lic.store_cap THEN
    RAISE EXCEPTION 'store licence: % of % stores are in use, the most the plan covers; deactivate a store you no longer run to add another',
      used, lic.store_cap USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER facility_store_licence BEFORE INSERT OR UPDATE OF kind, active ON facility FOR EACH ROW EXECUTE FUNCTION facility_store_licence();

CREATE FUNCTION store_licence_usage() RETURNS TABLE (used integer, cap integer)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT (SELECT count(*)::int FROM facility f WHERE f.tenant_id = app_tenant_id() AND f.kind = 'store' AND f.active), coalesce(l.store_cap, 5)
  FROM (SELECT 1) x LEFT JOIN tenant_license l ON l.tenant_id = app_tenant_id()
$$;
REVOKE ALL ON FUNCTION store_licence_usage() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION store_licence_usage() TO erp_app;
