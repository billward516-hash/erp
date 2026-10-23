-- 0020 Multi-site portfolios and contractors (S10a), for landlords and retail chains as much as plants.
-- Facilities get a kind and can be grouped (portfolio, region, district); a role can be granted on a group and is
-- expanded to its member facilities at sign-in, so row-level security is unchanged. Spaces (units, suites,
-- common areas, sales floors) become assets so they get work orders, QR codes and history. Work orders can be
-- dispatched to a contractor (a supplier) with a not-to-exceed amount; contractor invoices tie to the work order.
-- Service-level targets per priority. Requests can come from people without a login through a per-site link.

ALTER TABLE facility ADD COLUMN kind text NOT NULL DEFAULT 'plant' CHECK (kind IN ('plant', 'property', 'store', 'warehouse', 'office', 'other'));
ALTER TABLE facility ADD COLUMN active boolean NOT NULL DEFAULT true;

CREATE TABLE facility_group (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenant(id),
  code        text NOT NULL,
  name        text NOT NULL,
  kind        text NOT NULL DEFAULT 'portfolio' CHECK (kind IN ('portfolio', 'region', 'district', 'other')),
  UNIQUE (tenant_id, code)
);
CREATE TABLE facility_group_member (
  tenant_id    uuid NOT NULL REFERENCES tenant(id),
  group_id     uuid NOT NULL REFERENCES facility_group(id) ON DELETE CASCADE,
  facility_id  uuid NOT NULL REFERENCES facility(id),
  PRIMARY KEY (group_id, facility_id)
);

-- A role is granted tenant-wide (both NULL), on one facility, or on a group of facilities.
ALTER TABLE user_role_assignment ADD COLUMN facility_group_id uuid REFERENCES facility_group(id) ON DELETE CASCADE;
ALTER TABLE user_role_assignment ADD CONSTRAINT user_role_assignment_one_scope CHECK (facility_id IS NULL OR facility_group_id IS NULL);
ALTER TABLE user_role_assignment DROP CONSTRAINT user_role_assignment_user_id_role_id_facility_id_key;
ALTER TABLE user_role_assignment ADD CONSTRAINT user_role_assignment_scope_key UNIQUE NULLS NOT DISTINCT (user_id, role_id, facility_id, facility_group_id);

ALTER TABLE asset DROP CONSTRAINT asset_asset_class_check;
ALTER TABLE asset ADD CONSTRAINT asset_asset_class_check CHECK (asset_class IN ('equipment', 'component', 'tool', 'vehicle', 'facility_system', 'it', 'space'));

-- Contractor dispatch on the work order. The work is the contractor's; staff record what the contractor reports.
ALTER TABLE work_order ADD COLUMN vendor_supplier_id uuid REFERENCES supplier(id);
ALTER TABLE work_order ADD COLUMN nte_amount numeric(14, 2) CHECK (nte_amount > 0);
ALTER TABLE work_order ADD COLUMN vendor_status text CHECK (vendor_status IN ('dispatched', 'accepted', 'on_site', 'completed'));
ALTER TABLE work_order ADD COLUMN vendor_reference text;
ALTER TABLE work_order ADD COLUMN dispatched_at timestamptz;
ALTER TABLE work_order ADD COLUMN vendor_accepted_at timestamptz;
ALTER TABLE work_order ADD COLUMN responded_at timestamptz;   -- first response: work started, or the contractor accepted
ALTER TABLE work_order ADD CONSTRAINT work_order_vendor_status CHECK ((vendor_supplier_id IS NULL) = (vendor_status IS NULL));
UPDATE work_order SET responded_at = started_at WHERE started_at IS NOT NULL;

ALTER TABLE supplier_invoice ADD COLUMN work_order_id uuid REFERENCES work_order(id);
CREATE INDEX supplier_invoice_work_order ON supplier_invoice (work_order_id) WHERE work_order_id IS NOT NULL;

ALTER TABLE email_message ADD COLUMN supplier_id uuid REFERENCES supplier(id);

-- Response and completion targets by priority (1 = emergency). NULL = no target.
CREATE TABLE service_level (
  tenant_id       uuid NOT NULL REFERENCES tenant(id),
  priority        smallint NOT NULL CHECK (priority BETWEEN 1 AND 4),
  respond_hours   numeric(8, 1) CHECK (respond_hours > 0),
  complete_hours  numeric(8, 1) CHECK (complete_hours > 0),
  PRIMARY KEY (tenant_id, priority)
);
INSERT INTO service_level (tenant_id, priority, respond_hours, complete_hours)
SELECT t.id, p.priority, p.respond, p.complete FROM tenant t CROSS JOIN (VALUES (1, 4, 24), (2, 24, 72), (3, 72, 240), (4, NULL::numeric, NULL::numeric)) AS p(priority, respond, complete);

-- Requests from people without a login (renters, store staff) through a per-site link.
ALTER TABLE maintenance_request ADD COLUMN source text NOT NULL DEFAULT 'user' CHECK (source IN ('user', 'public'));
ALTER TABLE maintenance_request ADD COLUMN requester_name text;
ALTER TABLE maintenance_request ADD COLUMN requester_contact text;
ALTER TABLE maintenance_request ADD COLUMN entry_permission boolean;
ALTER TABLE maintenance_request ADD CONSTRAINT maintenance_request_source CHECK (source = 'user' OR requester_name IS NOT NULL);
CREATE TABLE public_request_link (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenant(id),
  facility_id  uuid NOT NULL REFERENCES facility(id),
  token_hash   bytea NOT NULL UNIQUE,
  label        text NOT NULL,
  active       boolean NOT NULL DEFAULT true,
  created_by   uuid NOT NULL REFERENCES app_user(id),
  created_at   timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE facility_group ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON facility_group USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());
ALTER TABLE facility_group_member ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON facility_group_member USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());
ALTER TABLE service_level ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON service_level USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());
ALTER TABLE public_request_link ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_facility ON public_request_link USING (tenant_id = app_tenant_id() AND app_can_see_facility(facility_id))
  WITH CHECK (tenant_id = app_tenant_id() AND app_can_see_facility(facility_id));
GRANT SELECT, INSERT, UPDATE, DELETE ON facility_group, facility_group_member, service_level TO erp_app;
GRANT SELECT, INSERT, UPDATE ON public_request_link TO erp_app;
GRANT INSERT, UPDATE ON facility TO erp_app;

-- The public intake resolves a link token to its tenant and facility before any tenant context exists
-- (like auth_resolve_token for API tokens): a definer function that reveals nothing but the ids.
CREATE FUNCTION public_request_resolve(p_hash bytea) RETURNS TABLE (tenant_id uuid, facility_id uuid, link_id uuid)
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  SELECT l.tenant_id, l.facility_id, l.id FROM public_request_link l JOIN facility f ON f.id = l.facility_id WHERE l.token_hash = p_hash AND l.active AND f.active
$$;
REVOKE ALL ON FUNCTION public_request_resolve(bytea) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public_request_resolve(bytea) TO erp_app;

-- Role grants with group grants expanded to their member facilities: what "holds a role at a facility" means
-- everywhere (notifications, approvers, assignable owners). security_invoker keeps row-level security.
CREATE VIEW user_role_scope WITH (security_invoker = true) AS
  SELECT a.tenant_id, a.user_id, a.role_id, a.facility_id FROM user_role_assignment a WHERE a.facility_group_id IS NULL
  UNION ALL
  SELECT a.tenant_id, a.user_id, a.role_id, m.facility_id FROM user_role_assignment a JOIN facility_group_member m ON m.group_id = a.facility_group_id;
GRANT SELECT ON user_role_scope TO erp_app;

-- Contractors are suppliers with trades and a certificate of insurance; dispatch is refused once it has lapsed.
ALTER TABLE supplier ADD COLUMN trades text[] NOT NULL DEFAULT '{}';
ALTER TABLE supplier ADD COLUMN insurance_expires_on date;

ALTER TABLE maintenance_request ADD COLUMN decision_note text;
ALTER TABLE maintenance_request ADD COLUMN decided_by uuid REFERENCES app_user(id);

-- Stock roles for sites run mostly through contractors (existing tenants; new tenants get them from the templates).
INSERT INTO role (tenant_id, key, name, permissions)
SELECT t.id, r.key, r.name, r.permissions FROM tenant t CROSS JOIN (VALUES
  ('property_manager', 'Property / Facilities Manager', ARRAY['org.view', 'employees.view', 'assets.view', 'assets.manage', 'assets.record_state', 'documents.view',
     'documents.view_draft', 'documents.manage', 'parts.view', 'work_orders.view', 'work_orders.request', 'work_orders.manage', 'work_orders.execute', 'work_orders.verify',
     'imports.run', 'imports.commit', 'reports.view', 'reports.export', 'learning.view', 'inventory.view', 'purchasing.view', 'purchasing.request', 'ap.view', 'crm.view',
     'safety.report', 'safety.view', 'continuity.view']),
  ('store_manager', 'Store / Site Manager', ARRAY['org.view', 'assets.view', 'assets.record_state', 'documents.view', 'work_orders.view', 'work_orders.request',
     'work_orders.verify', 'reports.view', 'learning.view', 'safety.report', 'quality.report'])
) AS r(key, name, permissions)
WHERE NOT EXISTS (SELECT 1 FROM role x WHERE x.tenant_id = t.id AND x.key = r.key);
