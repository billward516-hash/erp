-- S17c Intranet (D-130): company announcements (with optional event dates for the "coming up" list), quick links to
-- the company's other tools, and work phone and office location on employees for the people directory.
CREATE TABLE announcement (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenant(id),
  facility_id   uuid REFERENCES facility(id),             -- NULL = everyone
  title         text NOT NULL CHECK (length(title) BETWEEN 3 AND 200),
  body          text NOT NULL,                             -- Markdown subset, as policies
  kind          text NOT NULL DEFAULT 'news' CHECK (kind IN ('news', 'event', 'safety', 'people', 'it')),
  event_on      date,                                      -- events and holidays: shown under "coming up"
  pinned        boolean NOT NULL DEFAULT false,
  expires_on    date,                                      -- hidden from the home page after this day
  author_id     uuid NOT NULL REFERENCES app_user(id),
  published_at  timestamptz NOT NULL DEFAULT now(),
  withdrawn_at  timestamptz,
  CHECK (kind <> 'event' OR event_on IS NOT NULL)
);
CREATE INDEX announcement_recent ON announcement (tenant_id, published_at DESC) WHERE withdrawn_at IS NULL;

CREATE TABLE quick_link (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenant(id),
  title       text NOT NULL CHECK (length(title) BETWEEN 2 AND 60),
  url         text NOT NULL CHECK (url ~ '^(https://|/)'),        -- external https, or a path inside the platform
  description text,
  sort_order  integer NOT NULL DEFAULT 100,
  created_by  uuid NOT NULL REFERENCES app_user(id)
);

ALTER TABLE employee ADD COLUMN work_phone text;
ALTER TABLE employee ADD COLUMN office_location text;

DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['announcement', 'quick_link'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id())', t);
  END LOOP;
END $$;
GRANT SELECT, INSERT, UPDATE ON announcement, quick_link TO erp_app;
GRANT DELETE ON quick_link TO erp_app;

UPDATE role SET permissions = (SELECT array_agg(DISTINCT p) FROM unnest(permissions || ARRAY['announcements.post']) p) WHERE key IN ('admin', 'hr_manager', 'operations_manager');

-- The people directory: work contact details only, for the whole company. Employee rows are otherwise visible by site
-- (row-level security); a directory must find colleagues at other sites, so this function returns these columns alone.
CREATE FUNCTION people_directory() RETURNS TABLE (person_key text, user_id uuid, employee_id uuid, name text, job_title text, department text,
  site_code text, site_name text, email text, work_phone text, office_location text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT 'e:' || e.id, u.id, e.id, e.first_name || ' ' || e.last_name, e.job_title, d.name, f.code, f.name, coalesce(u.email, e.email), e.work_phone, e.office_location
  FROM employee e LEFT JOIN app_user u ON u.employee_id = e.id AND u.status = 'active' LEFT JOIN department d ON d.id = e.department_id LEFT JOIN facility f ON f.id = e.facility_id
  WHERE e.tenant_id = app_tenant_id() AND e.status = 'active'
  UNION ALL
  SELECT 'u:' || u.id, u.id, NULL, u.display_name, NULL, NULL, NULL, NULL, u.email, NULL, NULL
  FROM app_user u WHERE u.tenant_id = app_tenant_id() AND u.status = 'active' AND u.employee_id IS NULL
$$;
REVOKE ALL ON FUNCTION people_directory() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION people_directory() TO erp_app;
