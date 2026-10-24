-- 0120 Cleanroom environmental monitoring (SC-007 A, D-184A).
-- Rooms with an ISO 14644-1 class, monitoring points with a sampling frequency, append-only readings (particle counts by size,
-- differential pressure, temperature, relative humidity) judged against limits when they are recorded, and one excursion per
-- point while an action limit stays exceeded (one nonconformance per excursion, not one per reading).

CREATE TABLE cleanroom (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenant(id),
  facility_id    uuid NOT NULL REFERENCES facility(id),
  code           text NOT NULL,
  name           text NOT NULL,
  iso_class      smallint NOT NULL CHECK (iso_class BETWEEN 1 AND 9),
  occupancy      text NOT NULL DEFAULT 'operational' CHECK (occupancy IN ('at_rest', 'operational')),
  owner_user_id  uuid NOT NULL REFERENCES app_user(id),
  alert_pct      smallint NOT NULL DEFAULT 80 CHECK (alert_pct BETWEEN 10 AND 99),   -- default alert limit as a share of the action limit
  trend_count    smallint NOT NULL DEFAULT 3 CHECK (trend_count BETWEEN 2 AND 20),   -- consecutive readings over the alert limit that make a trend
  active         boolean NOT NULL DEFAULT true,
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, code)
);
CREATE INDEX cleanroom_facility ON cleanroom (facility_id);
CREATE INDEX cleanroom_owner ON cleanroom (owner_user_id);

CREATE TABLE cleanroom_point (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenant(id),
  facility_id     uuid NOT NULL REFERENCES facility(id),
  room_id         uuid NOT NULL REFERENCES cleanroom(id),
  label           text NOT NULL,                                   -- where in the room: "Fill line, 0.3 m above the work surface"
  channels        text[] NOT NULL,                                 -- what this point measures: p0_1 p0_2 p0_3 p0_5 p1 p5 dp temp rh
  interval_hours  integer NOT NULL CHECK (interval_hours > 0),     -- sampling frequency: a reading is expected at least this often
  active          boolean NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (room_id, label),
  CHECK (cardinality(channels) > 0 AND channels <@ ARRAY['p0_1', 'p0_2', 'p0_3', 'p0_5', 'p1', 'p5', 'dp', 'temp', 'rh']::text[])
);
CREATE INDEX cleanroom_point_facility ON cleanroom_point (facility_id);

-- Per-point limits that replace the defaults for one channel (particle channels default from the room's ISO class; pressure, temperature and
-- humidity have no default and are limited only where a range is set here).
CREATE TABLE cleanroom_point_limit (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenant(id),
  facility_id  uuid NOT NULL REFERENCES facility(id),
  point_id     uuid NOT NULL REFERENCES cleanroom_point(id),
  channel      text NOT NULL CHECK (channel IN ('p0_1', 'p0_2', 'p0_3', 'p0_5', 'p1', 'p5', 'dp', 'temp', 'rh')),
  alert_low    numeric(18, 3),
  alert_high   numeric(18, 3),
  action_low   numeric(18, 3),
  action_high  numeric(18, 3),
  UNIQUE (point_id, channel),
  CHECK (alert_low IS NOT NULL OR alert_high IS NOT NULL OR action_low IS NOT NULL OR action_high IS NOT NULL),
  CHECK (action_low IS NULL OR action_high IS NULL OR action_low < action_high),
  CHECK (alert_low IS NULL OR alert_high IS NULL OR alert_low < alert_high)
);
CREATE INDEX cleanroom_point_limit_facility ON cleanroom_point_limit (facility_id);

-- Readings are a log: a wrong reading is answered with a new one and a note, never edited (like condition_reading).
CREATE TABLE cleanroom_reading (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id    uuid NOT NULL REFERENCES tenant(id),
  facility_id  uuid NOT NULL REFERENCES facility(id),
  point_id     uuid NOT NULL REFERENCES cleanroom_point(id),
  read_at      timestamptz NOT NULL,
  occupancy    text NOT NULL CHECK (occupancy IN ('at_rest', 'operational')),
  p0_1         numeric(18, 2) CHECK (p0_1 >= 0),                  -- particles per cubic metre, at or above the size in micrometres
  p0_2         numeric(18, 2) CHECK (p0_2 >= 0),
  p0_3         numeric(18, 2) CHECK (p0_3 >= 0),
  p0_5         numeric(18, 2) CHECK (p0_5 >= 0),
  p1           numeric(18, 2) CHECK (p1 >= 0),
  p5           numeric(18, 2) CHECK (p5 >= 0),
  dp_pa        numeric(10, 2),                                    -- differential pressure to the reference space, pascals
  temp_c       numeric(6, 2),
  rh_pct       numeric(5, 2) CHECK (rh_pct BETWEEN 0 AND 100),
  status       text NOT NULL CHECK (status IN ('ok', 'alert', 'action')),
  breaches     jsonb NOT NULL DEFAULT '[]',                       -- the limits applied when it was recorded: [{channel, level, value, limit}]
  note         text,
  source       text NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'import')),
  recorded_by  uuid REFERENCES app_user(id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  CHECK (p0_1 IS NOT NULL OR p0_2 IS NOT NULL OR p0_3 IS NOT NULL OR p0_5 IS NOT NULL OR p1 IS NOT NULL OR p5 IS NOT NULL OR dp_pa IS NOT NULL OR temp_c IS NOT NULL OR rh_pct IS NOT NULL)
);
CREATE UNIQUE INDEX cleanroom_reading_point_time ON cleanroom_reading (point_id, read_at);
CREATE INDEX cleanroom_reading_facility ON cleanroom_reading (facility_id, read_at DESC);
CREATE FUNCTION cleanroom_reading_final() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'cleanroom readings are a log; record a new reading with a note instead'; END $$;
CREATE TRIGGER cleanroom_reading_final BEFORE UPDATE OR DELETE ON cleanroom_reading FOR EACH ROW EXECUTE FUNCTION cleanroom_reading_final();

-- One excursion per point while an action limit stays exceeded; it holds the one nonconformance raised for it.
CREATE TABLE cleanroom_excursion (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid NOT NULL REFERENCES tenant(id),
  facility_id        uuid NOT NULL REFERENCES facility(id),
  room_id            uuid NOT NULL REFERENCES cleanroom(id),
  point_id           uuid NOT NULL REFERENCES cleanroom_point(id),
  started_at         timestamptz NOT NULL,
  ended_at           timestamptz,
  readings           integer NOT NULL DEFAULT 1,
  channels           text[] NOT NULL,
  peak               jsonb NOT NULL DEFAULT '{}',                 -- worst value per channel: {channel: {value, limit}}
  nonconformance_id  uuid REFERENCES nonconformance(id),
  CHECK (ended_at IS NULL OR ended_at >= started_at)
);
CREATE UNIQUE INDEX cleanroom_excursion_one_open ON cleanroom_excursion (point_id) WHERE ended_at IS NULL;
CREATE INDEX cleanroom_excursion_room ON cleanroom_excursion (room_id, started_at DESC);
CREATE INDEX cleanroom_excursion_ncr ON cleanroom_excursion (nonconformance_id);
CREATE INDEX cleanroom_excursion_facility ON cleanroom_excursion (facility_id);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['cleanroom', 'cleanroom_point', 'cleanroom_point_limit', 'cleanroom_reading', 'cleanroom_excursion'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_facility ON %I USING (tenant_id = app_tenant_id() AND app_can_see_facility(facility_id)) WITH CHECK (tenant_id = app_tenant_id() AND app_can_see_facility(facility_id))', t);
  END LOOP;
END $$;
GRANT SELECT, INSERT, UPDATE ON cleanroom, cleanroom_point, cleanroom_excursion TO erp_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON cleanroom_point_limit TO erp_app;
GRANT SELECT, INSERT ON cleanroom_reading TO erp_app;

-- Permissions (existing tenants; new tenants get them from the role templates in permissions.ts).
UPDATE role SET permissions = (SELECT array_agg(DISTINCT p) FROM unnest(permissions || ARRAY['cleanroom.view', 'cleanroom.record', 'cleanroom.manage']) p)
WHERE key IN ('admin', 'quality_manager', 'operations_manager');
UPDATE role SET permissions = (SELECT array_agg(DISTINCT p) FROM unnest(permissions || ARRAY['cleanroom.view', 'cleanroom.record']) p)
WHERE key IN ('quality_reviewer', 'production_supervisor', 'maintenance_manager', 'technician', 'operator');
UPDATE role SET permissions = (SELECT array_agg(DISTINCT p) FROM unnest(permissions || ARRAY['cleanroom.view']) p)
WHERE key IN ('executive', 'ehs_reviewer');
