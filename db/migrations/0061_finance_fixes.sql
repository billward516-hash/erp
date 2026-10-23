-- Verification fixes, finance (D-161). A supplier's invoice number is unique across the company, but the duplicate
-- check ran under site row-level security, so a clerk at one site could not see the same invoice captured at another
-- and the insert failed on the unique index instead. This answers for the whole company and returns only yes or no.
CREATE FUNCTION supplier_invoice_number_taken(p_supplier uuid, p_number text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (SELECT 1 FROM supplier_invoice WHERE tenant_id = app_tenant_id() AND supplier_id = p_supplier AND lower(invoice_number) = lower(p_number) AND status <> 'void')
$$;
REVOKE ALL ON FUNCTION supplier_invoice_number_taken(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION supplier_invoice_number_taken(uuid, text) TO erp_app;
