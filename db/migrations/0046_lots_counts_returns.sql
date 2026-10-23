-- S20b Lots on the remaining movements (D-147): cycle counts count a tracked part per lot, and customer returns on a
-- credit memo say which lots or serial numbers came back.
ALTER TABLE inventory_count_line ADD COLUMN lot_number text NOT NULL DEFAULT '';   -- '' for untracked parts
ALTER TABLE inventory_count_line DROP CONSTRAINT inventory_count_line_pkey;
ALTER TABLE inventory_count_line ADD PRIMARY KEY (count_id, part_id, lot_number);

ALTER TABLE customer_credit_memo_line ADD COLUMN lot_numbers text;               -- one lot, or serial numbers separated by commas
