-- SC-002 F1 Field service: customer sites, customer-owned equipment, technicians and vehicles, service agreements with covered units,
-- and the visits generated from them.
CREATE TABLE field_service_settings (
  tenant_id            uuid PRIMARY KEY REFERENCES tenant(id),
  road_factor          numeric(4, 2) NOT NULL DEFAULT 1.30 CHECK (road_factor BETWEEN 1 AND 3),
  avg_speed_mph        numeric(5, 1) NOT NULL DEFAULT 35 CHECK (avg_speed_mph BETWEEN 5 AND 80),
  horizon_days         integer NOT NULL DEFAULT 30 CHECK (horizon_days BETWEEN 1 AND 365),
  default_visit_minutes integer NOT NULL DEFAULT 60 CHECK (default_visit_minutes BETWEEN 5 AND 960),
  updated_by           uuid NOT NULL REFERENCES app_user(id),
  updated_at           timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_fs_settings_updated_by ON field_service_settings (updated_by);
ALTER TABLE field_service_settings ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_only ON field_service_settings USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());
GRANT SELECT, INSERT, UPDATE ON field_service_settings TO erp_app;

CREATE TABLE customer_site (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenant(id),
  customer_id   uuid NOT NULL REFERENCES customer(id),
  name          text NOT NULL,
  address       jsonb NOT NULL DEFAULT '{}',
  lat           numeric(9, 6) CHECK (lat BETWEEN -90 AND 90),
  lon           numeric(9, 6) CHECK (lon BETWEEN -180 AND 180),
  access_notes  text,
  contact_id    uuid REFERENCES contact(id),
  active        boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (customer_id, name)
);
CREATE INDEX ix_customer_site_tenant ON customer_site (tenant_id);
CREATE INDEX ix_customer_site_contact ON customer_site (contact_id) WHERE contact_id IS NOT NULL;
ALTER TABLE customer_site ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_only ON customer_site USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());
GRANT SELECT, INSERT, UPDATE ON customer_site TO erp_app;

-- Equipment that belongs to a customer and sits at their site (the asset record is the same one used for our own equipment).
ALTER TABLE asset ADD COLUMN customer_id uuid REFERENCES customer(id), ADD COLUMN customer_site_id uuid REFERENCES customer_site(id);
CREATE INDEX ix_asset_customer ON asset (customer_id) WHERE customer_id IS NOT NULL;
CREATE INDEX ix_asset_customer_site ON asset (customer_site_id) WHERE customer_site_id IS NOT NULL;

CREATE TABLE technician_profile (
  employee_id   uuid PRIMARY KEY REFERENCES employee(id),
  tenant_id     uuid NOT NULL REFERENCES tenant(id),
  home_lat      numeric(9, 6) CHECK (home_lat BETWEEN -90 AND 90),
  home_lon      numeric(9, 6) CHECK (home_lon BETWEEN -180 AND 180),
  skills        text[] NOT NULL DEFAULT '{}',
  day_start     time NOT NULL DEFAULT '08:00',
  day_end       time NOT NULL DEFAULT '17:00',
  work_days     integer[] NOT NULL DEFAULT '{1,2,3,4,5}',
  vehicle_id    uuid REFERENCES asset(id),
  active        boolean NOT NULL DEFAULT true,
  CHECK (day_end > day_start)
);
CREATE INDEX ix_techprofile_tenant ON technician_profile (tenant_id);
CREATE INDEX ix_techprofile_vehicle ON technician_profile (vehicle_id) WHERE vehicle_id IS NOT NULL;
ALTER TABLE technician_profile ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_only ON technician_profile USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());
GRANT SELECT, INSERT, UPDATE ON technician_profile TO erp_app;

CREATE TABLE technician_time_off (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenant(id),
  employee_id   uuid NOT NULL REFERENCES employee(id),
  from_date     date NOT NULL,
  to_date       date NOT NULL,
  reason        text,
  created_by    uuid NOT NULL REFERENCES app_user(id),
  CHECK (to_date >= from_date)
);
CREATE INDEX ix_techoff_employee ON technician_time_off (employee_id, from_date);
CREATE INDEX ix_techoff_tenant ON technician_time_off (tenant_id);
CREATE INDEX ix_techoff_created_by ON technician_time_off (created_by);
ALTER TABLE technician_time_off ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_only ON technician_time_off USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());
GRANT SELECT, INSERT, DELETE ON technician_time_off TO erp_app;

CREATE TABLE vehicle_profile (
  asset_id             uuid PRIMARY KEY REFERENCES asset(id),
  tenant_id            uuid NOT NULL REFERENCES tenant(id),
  plate                text,
  vin                  text,
  home_lat             numeric(9, 6) CHECK (home_lat BETWEEN -90 AND 90),
  home_lon             numeric(9, 6) CHECK (home_lon BETWEEN -180 AND 180),
  assigned_employee_id uuid REFERENCES employee(id)
);
CREATE INDEX ix_vehicle_tenant ON vehicle_profile (tenant_id);
CREATE INDEX ix_vehicle_employee ON vehicle_profile (assigned_employee_id) WHERE assigned_employee_id IS NOT NULL;
ALTER TABLE vehicle_profile ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_only ON vehicle_profile USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());
GRANT SELECT, INSERT, UPDATE ON vehicle_profile TO erp_app;

CREATE TABLE service_agreement (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenant(id),
  facility_id     uuid NOT NULL REFERENCES facility(id),
  number          text NOT NULL,
  customer_id     uuid NOT NULL REFERENCES customer(id),
  status          text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'active', 'suspended', 'ended', 'cancelled')),
  starts_on       date NOT NULL,
  ends_on         date,
  billing_model   text NOT NULL DEFAULT 'per_visit' CHECK (billing_model IN ('per_visit', 'monthly')),
  monthly_fee     numeric(14, 2) CHECK (monthly_fee >= 0),
  per_visit_fee   numeric(14, 2) CHECK (per_visit_fee >= 0),
  response_hours  integer CHECK (response_hours > 0),
  auto_renew      boolean NOT NULL DEFAULT false,
  payment_terms   text,
  terms           text,
  owner_user_id   uuid NOT NULL REFERENCES app_user(id),
  created_by      uuid NOT NULL REFERENCES app_user(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, number),
  CHECK (ends_on IS NULL OR ends_on >= starts_on),
  CHECK (billing_model <> 'monthly' OR monthly_fee IS NOT NULL)
);
CREATE INDEX ix_sa_facility ON service_agreement (facility_id);
CREATE INDEX ix_sa_customer ON service_agreement (customer_id);
CREATE INDEX ix_sa_owner ON service_agreement (owner_user_id);
CREATE INDEX ix_sa_created_by ON service_agreement (created_by);
ALTER TABLE service_agreement ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_facility ON service_agreement USING (tenant_id = app_tenant_id() AND app_can_see_facility(facility_id)) WITH CHECK (tenant_id = app_tenant_id() AND app_can_see_facility(facility_id));
GRANT SELECT, INSERT, UPDATE ON service_agreement TO erp_app;

-- A covered unit: the customer's equipment, how often it is serviced, and what a visit involves.
CREATE TABLE service_plan (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenant(id),
  agreement_id     uuid NOT NULL REFERENCES service_agreement(id),
  asset_id         uuid NOT NULL REFERENCES asset(id),
  title            text NOT NULL,
  every_n          integer NOT NULL CHECK (every_n BETWEEN 1 AND 60),
  unit             text NOT NULL CHECK (unit IN ('week', 'month', 'year')),
  next_due_on      date NOT NULL,
  estimated_minutes integer CHECK (estimated_minutes BETWEEN 5 AND 960),
  required_skill   text,
  checklist        jsonb NOT NULL DEFAULT '[]',
  per_visit_fee    numeric(14, 2) CHECK (per_visit_fee >= 0),
  active           boolean NOT NULL DEFAULT true,
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (agreement_id, asset_id, title)
);
CREATE INDEX ix_splan_tenant ON service_plan (tenant_id);
CREATE INDEX ix_splan_asset ON service_plan (asset_id);
CREATE INDEX ix_splan_due ON service_plan (next_due_on) WHERE active;
ALTER TABLE service_plan ENABLE ROW LEVEL SECURITY;
CREATE POLICY via_parent ON service_plan USING (tenant_id = app_tenant_id() AND EXISTS (SELECT 1 FROM service_agreement a WHERE a.id = agreement_id)) WITH CHECK (tenant_id = app_tenant_id());
GRANT SELECT, INSERT, UPDATE ON service_plan TO erp_app;

CREATE TABLE service_visit (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid NOT NULL REFERENCES tenant(id),
  facility_id        uuid NOT NULL REFERENCES facility(id),
  number             text NOT NULL,
  agreement_id       uuid REFERENCES service_agreement(id),
  plan_id            uuid REFERENCES service_plan(id),
  customer_id        uuid NOT NULL REFERENCES customer(id),
  site_id            uuid REFERENCES customer_site(id),
  asset_id           uuid REFERENCES asset(id),
  kind               text NOT NULL DEFAULT 'scheduled' CHECK (kind IN ('scheduled', 'callout')),
  title              text NOT NULL,
  priority           smallint NOT NULL DEFAULT 3 CHECK (priority BETWEEN 1 AND 4),
  due_on             date NOT NULL,
  status             text NOT NULL DEFAULT 'planned' CHECK (status IN ('planned', 'scheduled', 'dispatched', 'in_progress', 'completed', 'cancelled')),
  scheduled_on       date,
  scheduled_start    time,
  technician_id      uuid REFERENCES employee(id),
  vehicle_id         uuid REFERENCES asset(id),
  estimated_minutes  integer NOT NULL DEFAULT 60 CHECK (estimated_minutes BETWEEN 5 AND 960),
  required_skill     text,
  work_order_id      uuid REFERENCES work_order(id),
  started_at         timestamptz,
  completed_at       timestamptz,
  cancel_reason      text,
  notes              text,
  created_by         uuid REFERENCES app_user(id),
  created_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, number),
  CHECK (status NOT IN ('scheduled', 'dispatched', 'in_progress') OR (scheduled_on IS NOT NULL AND technician_id IS NOT NULL))
);
CREATE UNIQUE INDEX ux_visit_plan_due ON service_visit (plan_id, due_on) WHERE plan_id IS NOT NULL;
CREATE INDEX ix_visit_facility ON service_visit (facility_id);
CREATE INDEX ix_visit_agreement ON service_visit (agreement_id) WHERE agreement_id IS NOT NULL;
CREATE INDEX ix_visit_customer ON service_visit (customer_id);
CREATE INDEX ix_visit_site ON service_visit (site_id) WHERE site_id IS NOT NULL;
CREATE INDEX ix_visit_asset ON service_visit (asset_id) WHERE asset_id IS NOT NULL;
CREATE INDEX ix_visit_tech_day ON service_visit (technician_id, scheduled_on) WHERE technician_id IS NOT NULL;
CREATE INDEX ix_visit_vehicle ON service_visit (vehicle_id) WHERE vehicle_id IS NOT NULL;
CREATE INDEX ix_visit_wo ON service_visit (work_order_id) WHERE work_order_id IS NOT NULL;
CREATE INDEX ix_visit_created_by ON service_visit (created_by) WHERE created_by IS NOT NULL;
CREATE INDEX ix_visit_open_due ON service_visit (tenant_id, due_on) WHERE status IN ('planned', 'scheduled', 'dispatched', 'in_progress');
ALTER TABLE service_visit ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_facility ON service_visit USING (tenant_id = app_tenant_id() AND app_can_see_facility(facility_id)) WITH CHECK (tenant_id = app_tenant_id() AND app_can_see_facility(facility_id));
GRANT SELECT, INSERT, UPDATE ON service_visit TO erp_app;
