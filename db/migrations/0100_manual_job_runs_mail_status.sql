-- D-183B. A person's manual run of the daily job is recorded like the scheduled one, and a queued email can be cancelled.
--
-- job_run keeps one row per (job, day) for the scheduled run (the lock, D-171). A manual run for one company is a further row
-- that carries that company and the person who started it, so it never collides with the day's scheduled row. The table now
-- holds company rows, so it gets row-level security like every other table with a tenant_id; the platform's own (admin)
-- connection owns the table and is not subject to it, and the application role sees only its own company's manual runs.
ALTER TABLE job_run ADD COLUMN tenant_id  uuid REFERENCES tenant(id);
ALTER TABLE job_run ADD COLUMN started_by uuid REFERENCES app_user(id);
ALTER TABLE job_run DROP CONSTRAINT job_run_job_run_date_key;
CREATE UNIQUE INDEX uq_job_run_scheduled_day ON job_run (job, run_date) WHERE tenant_id IS NULL;
CREATE INDEX ix_job_run_tenant_id ON job_run (tenant_id, started_at DESC) WHERE tenant_id IS NOT NULL;
CREATE INDEX ix_job_run_started_by ON job_run (started_by) WHERE started_by IS NOT NULL;
ALTER TABLE job_run ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON job_run USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());

-- A digest whose recipient has since turned email off (or left) is cancelled instead of sent.
ALTER TABLE email_message DROP CONSTRAINT email_message_status_check;
ALTER TABLE email_message ADD CONSTRAINT email_message_status_check CHECK (status IN ('queued', 'sent', 'failed', 'cancelled'));
CREATE INDEX ix_email_message_queued ON email_message (tenant_id, id) WHERE status = 'queued';
