-- Operations and sales managers work with parts every day (stock and lots, quotes and orders) but could not read the
-- parts catalog, so those screens were refused part of their data (D-161). Both default roles gain read access;
-- companies can still remove it.
UPDATE role SET permissions = (SELECT array_agg(DISTINCT p) FROM unnest(permissions || ARRAY['parts.view']) p)
WHERE key IN ('operations_manager', 'sales_manager');
