-- Readiness probe (D-150): the request role may read which migrations have been applied (names and times only).
GRANT SELECT ON schema_migration TO erp_app;
