-- 0005 Wide-to-long imports (e.g. training matrices: one row per person, one column per qualification).
-- One source row can yield several staged rows, identified by the source column they came from.
ALTER TABLE import_row ADD COLUMN source_column text NOT NULL DEFAULT '';
ALTER TABLE import_row DROP CONSTRAINT import_row_batch_id_row_number_key;
ALTER TABLE import_row ADD CONSTRAINT import_row_batch_row_column_key UNIQUE (batch_id, row_number, source_column);
