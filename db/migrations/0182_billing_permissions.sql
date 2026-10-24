-- SC-009 P2: the new permissions for companies that already exist (new companies copy the role templates in code).
-- Billing and retainers: finance, receivables and bookkeeping staff prepare and invoice; finance also sets rates and writes down;
-- executives and operations managers read.
UPDATE role SET permissions = (SELECT array_agg(DISTINCT p) FROM unnest(permissions || ARRAY['billing.view', 'billing.manage', 'billing.rates', 'billing.writeoff', 'retainers.view', 'retainers.manage']) p)
WHERE key IN ('admin', 'finance_approver');
UPDATE role SET permissions = (SELECT array_agg(DISTINCT p) FROM unnest(permissions || ARRAY['billing.view', 'billing.manage', 'retainers.view', 'retainers.manage']) p)
WHERE key IN ('ar_clerk', 'bookkeeper');
UPDATE role SET permissions = (SELECT array_agg(DISTINCT p) FROM unnest(permissions || ARRAY['billing.view', 'retainers.view']) p)
WHERE key IN ('executive', 'operations_manager');
