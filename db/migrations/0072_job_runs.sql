-- Built-in daily scheduler (D-171): one row per job per day. Inserting the row is the lock, so with several server
-- instances exactly one runs the day's job, and a crashed run is visible instead of silently missing.
CREATE TABLE job_run (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  job          text NOT NULL,
  run_date     date NOT NULL,
  started_at   timestamptz NOT NULL DEFAULT now(),
  finished_at  timestamptz,
  status       text NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'done', 'failed')),
  trigger      text NOT NULL DEFAULT 'schedule' CHECK (trigger IN ('schedule', 'manual')),
  result       jsonb,
  error        text,
  UNIQUE (job, run_date)
);
-- Platform table, not company data: the app role reads and writes it through the platform's own connection only.
GRANT SELECT, INSERT, UPDATE ON job_run TO erp_app;
