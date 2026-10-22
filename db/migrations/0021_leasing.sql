-- 0021 Leasing for landlords (S10b). A rental unit is the leasing record of a space asset (D-088); a lease ties a
-- unit to a renter (a customer) with rent and recurring charges. Rent is billed as ordinary customer invoices, so
-- payments, aging, collections and the accounting sync are the ones already in place. Unit turns group the
-- make-ready work orders between one lease and the next. The accounting system keeps the books, deposits included.

ALTER TABLE customer ADD COLUMN party_type text NOT NULL DEFAULT 'organization' CHECK (party_type IN ('organization', 'individual'));
ALTER TABLE customer ADD COLUMN email text;

CREATE TABLE rental_unit (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenant(id),
  facility_id   uuid NOT NULL REFERENCES facility(id),
  asset_id      uuid NOT NULL UNIQUE REFERENCES asset(id),      -- the space
  unit_type     text NOT NULL DEFAULT 'residential' CHECK (unit_type IN ('residential', 'commercial', 'storage', 'parking', 'other')),
  bedrooms      numeric(3, 1) CHECK (bedrooms >= 0),
  bathrooms     numeric(3, 1) CHECK (bathrooms >= 0),
  area_sqft     integer CHECK (area_sqft > 0),
  market_rent   numeric(12, 2) CHECK (market_rent >= 0),
  offline       boolean NOT NULL DEFAULT false,                  -- down for renovation, model unit, office: not rentable
  offline_reason text,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE lease (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL REFERENCES tenant(id),
  facility_id         uuid NOT NULL REFERENCES facility(id),
  number              text NOT NULL,
  unit_id             uuid NOT NULL REFERENCES rental_unit(id),
  customer_id         uuid NOT NULL REFERENCES customer(id),   -- the renter (person or company)
  start_date          date NOT NULL,
  end_date            date,                                     -- NULL = month to month
  rent_amount         numeric(12, 2) NOT NULL CHECK (rent_amount >= 0),
  deposit_amount      numeric(12, 2) NOT NULL DEFAULT 0 CHECK (deposit_amount >= 0),
  deposit_received_on date,
  grace_days          integer NOT NULL DEFAULT 5 CHECK (grace_days BETWEEN 0 AND 31),
  status              text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'active', 'notice', 'ended', 'cancelled')),
  notice_given_on     date,
  move_out_on         date,                                     -- expected (notice) or actual (ended)
  ended_reason        text,
  renewed_from_id     uuid REFERENCES lease(id),
  source              text NOT NULL DEFAULT 'native' CHECK (source IN ('native', 'import')),
  created_by          uuid NOT NULL REFERENCES app_user(id),
  created_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, number),
  CHECK (end_date IS NULL OR end_date >= start_date),
  CHECK (move_out_on IS NULL OR move_out_on >= start_date),
  CHECK (status <> 'ended' OR move_out_on IS NOT NULL),
  -- One lease in force per unit at any time (drafts and cancelled leases do not count). A lease is in force until
  -- the renter moves out, not until its end date: past the end date it holds over month to month.
  EXCLUDE USING gist (unit_id WITH =, daterange(start_date, move_out_on, '[]') WITH &&) WHERE (status IN ('active', 'notice', 'ended'))
);
CREATE INDEX lease_unit ON lease (unit_id, start_date);

-- Recurring charges besides rent (parking, pet, storage, utilities, common-area maintenance).
CREATE TABLE lease_charge (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenant(id),
  lease_id     uuid NOT NULL REFERENCES lease(id),
  description  text NOT NULL,
  amount       numeric(12, 2) NOT NULL CHECK (amount > 0),
  starts_on    date,
  ends_on      date
);

-- Which month of which lease has been billed, and on which invoice: makes the rent run safe to repeat.
CREATE TABLE lease_billing (
  tenant_id   uuid NOT NULL REFERENCES tenant(id),
  lease_id    uuid NOT NULL REFERENCES lease(id),
  period      date NOT NULL CHECK (extract(day FROM period) = 1),
  invoice_id  uuid NOT NULL REFERENCES customer_invoice(id),
  PRIMARY KEY (lease_id, period)
);

ALTER TABLE customer_invoice ADD COLUMN lease_id uuid REFERENCES lease(id);
ALTER TABLE customer_invoice_line ADD COLUMN account_key text;

-- Make-ready between leases: the work orders, the target date and when the unit was actually ready.
CREATE TABLE unit_turn (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenant(id),
  facility_id      uuid NOT NULL REFERENCES facility(id),
  unit_id          uuid NOT NULL REFERENCES rental_unit(id),
  prior_lease_id   uuid REFERENCES lease(id),
  move_out_on      date NOT NULL,
  target_ready_on  date NOT NULL,
  status           text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'ready', 'cancelled')),
  ready_on         date,
  notes            text,
  created_by       uuid NOT NULL REFERENCES app_user(id),
  created_at       timestamptz NOT NULL DEFAULT now(),
  CHECK ((status = 'ready') = (ready_on IS NOT NULL))
);
CREATE UNIQUE INDEX unit_turn_one_open ON unit_turn (unit_id) WHERE status = 'open';
ALTER TABLE work_order ADD COLUMN unit_turn_id uuid REFERENCES unit_turn(id);

ALTER TABLE rental_unit ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_facility ON rental_unit USING (tenant_id = app_tenant_id() AND app_can_see_facility(facility_id)) WITH CHECK (tenant_id = app_tenant_id() AND app_can_see_facility(facility_id));
ALTER TABLE lease ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_facility ON lease USING (tenant_id = app_tenant_id() AND app_can_see_facility(facility_id)) WITH CHECK (tenant_id = app_tenant_id() AND app_can_see_facility(facility_id));
ALTER TABLE unit_turn ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_facility ON unit_turn USING (tenant_id = app_tenant_id() AND app_can_see_facility(facility_id)) WITH CHECK (tenant_id = app_tenant_id() AND app_can_see_facility(facility_id));
ALTER TABLE lease_charge ENABLE ROW LEVEL SECURITY;
CREATE POLICY via_parent ON lease_charge USING (tenant_id = app_tenant_id() AND EXISTS (SELECT 1 FROM lease l WHERE l.id = lease_id))
  WITH CHECK (tenant_id = app_tenant_id() AND EXISTS (SELECT 1 FROM lease l WHERE l.id = lease_id));
ALTER TABLE lease_billing ENABLE ROW LEVEL SECURITY;
CREATE POLICY via_parent ON lease_billing USING (tenant_id = app_tenant_id() AND EXISTS (SELECT 1 FROM lease l WHERE l.id = lease_id))
  WITH CHECK (tenant_id = app_tenant_id() AND EXISTS (SELECT 1 FROM lease l WHERE l.id = lease_id));
GRANT SELECT, INSERT, UPDATE ON rental_unit, lease, unit_turn TO erp_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON lease_charge TO erp_app;
GRANT SELECT, INSERT ON lease_billing TO erp_app;

UPDATE role SET permissions = (SELECT array_agg(DISTINCT p) FROM unnest(permissions || ARRAY['leasing.view', 'leasing.manage']) p) WHERE key IN ('admin', 'property_manager');
UPDATE role SET permissions = (SELECT array_agg(DISTINCT p) FROM unnest(permissions || ARRAY['ar.view', 'ar.manage']) p) WHERE key = 'property_manager';
UPDATE role SET permissions = (SELECT array_agg(DISTINCT p) FROM unnest(permissions || ARRAY['leasing.view']) p) WHERE key IN ('executive', 'finance_approver', 'ar_clerk');
