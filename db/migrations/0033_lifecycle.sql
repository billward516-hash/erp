-- S15a Lifecycle economics (repair or replace): what an asset is expected to last, what an hour of its unplanned
-- downtime costs, and the cost of work orders brought over from a previous system (parts and contractors).
ALTER TABLE asset ADD COLUMN expected_life_years integer CHECK (expected_life_years BETWEEN 1 AND 100);
ALTER TABLE asset ADD COLUMN downtime_cost_per_hour numeric(12, 2) CHECK (downtime_cost_per_hour >= 0);
ALTER TABLE work_order ADD COLUMN legacy_cost numeric(14, 2) CHECK (legacy_cost >= 0);
