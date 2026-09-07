-- Read-only role for the dashboard (M4, spec §5). Cluster-wide, so created only once; every
-- grant is scoped to the CURRENT schema (search_path) so the throwaway test schemas and the real
-- one each get their own grants and DROP SCHEMA never trips over a role dependency. The password is
-- local-only in the same sense as ctb_local_only in docker-compose.yml: this database is bound to
-- 127.0.0.1 and holds no secret.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ctb_dashboard') THEN
    CREATE ROLE ctb_dashboard LOGIN PASSWORD 'ctb_dashboard_local_only';
  END IF;
  EXECUTE format('GRANT USAGE ON SCHEMA %I TO ctb_dashboard', current_schema());
  EXECUTE format('GRANT SELECT ON ALL TABLES IN SCHEMA %I TO ctb_dashboard', current_schema());
  EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA %I GRANT SELECT ON TABLES TO ctb_dashboard', current_schema());
END $$;
