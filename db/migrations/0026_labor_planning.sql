-- S11c qualified-labor capacity: operator hours needed per machine hour at a work center (0.5 = one operator tends
-- two machines; 2 = a crew of two). NULL = 1.
ALTER TABLE work_center ADD COLUMN labor_ratio numeric(6, 3) CHECK (labor_ratio > 0 AND labor_ratio <= 20);
