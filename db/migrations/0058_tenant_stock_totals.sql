-- Verification fixes (D-161). Some figures are company-wide but were computed from tables that row-level security
-- filters by site, so they depended on which sites the user could see: the moving average part cost, whether a part
-- has stock (switching lot or serial tracking on or off), and whether a serial number is already in stock somewhere.
-- These functions answer for the whole company (app_tenant_id()) and return only quantities and storeroom codes.
CREATE FUNCTION part_stock_total(p_part uuid) RETURNS numeric
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT coalesce(sum(b.qty_on_hand), 0) FROM inventory_balance b WHERE b.tenant_id = app_tenant_id() AND b.part_id = p_part
$$;
CREATE FUNCTION part_stock_locations(p_part uuid) RETURNS TABLE (location_id uuid, facility_id uuid, code text, facility_code text, qty numeric)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT b.location_id, b.facility_id, l.code, f.code, b.qty_on_hand FROM inventory_balance b JOIN stock_location l ON l.id = b.location_id JOIN facility f ON f.id = b.facility_id
  WHERE b.tenant_id = app_tenant_id() AND b.part_id = p_part AND b.qty_on_hand > 0
$$;
CREATE FUNCTION lot_stock_total(p_lot uuid) RETURNS numeric
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT coalesce(sum(b.qty), 0) FROM lot_balance b WHERE b.tenant_id = app_tenant_id() AND b.lot_id = p_lot
$$;
REVOKE ALL ON FUNCTION part_stock_total(uuid), part_stock_locations(uuid), lot_stock_total(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION part_stock_total(uuid), part_stock_locations(uuid), lot_stock_total(uuid) TO erp_app;
