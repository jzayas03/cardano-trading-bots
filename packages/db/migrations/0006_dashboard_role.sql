-- Read-only role for the dashboard (M4, spec §5). Cluster-wide, so created only once; every
-- grant is scoped to the CURRENT schema (search_path) so the throwaway test schemas and the real
-- one each get their own grants and DROP SCHEMA never trips over a role dependency. The password is
-- local-only in the same sense as ctb_local_only in docker-compose.yml: this database is bound to
-- 127.0.0.1 and holds no secret.
DO $$
BEGIN
  -- CREATE ROLE is CLUSTER-wide while these grants are schema-scoped, so this file runs once per
  -- schema and many schemas migrate at once: vitest runs pg tests in parallel workers, each against
  -- its own throwaway schema. A check-then-create is not atomic across sessions -- every worker sees
  -- "not exists", they all issue CREATE ROLE, one wins and the rest fail on the pg_authid unique
  -- index. Measured: 7 of 8 concurrent migrations failed that way, and CI caught it on a fresh
  -- cluster while a developer machine passed because the role already existed from an earlier run.
  -- Catching the collision is the standard idiom; both SQLSTATEs are raised in practice
  -- (duplicate_object 42710, unique_violation 23505 from the catalog index).
  BEGIN
    CREATE ROLE ctb_dashboard LOGIN PASSWORD 'ctb_dashboard_local_only';
  EXCEPTION WHEN duplicate_object OR unique_violation THEN
    NULL; -- intentional: another session created the role first, which is exactly what we wanted
  END;
  EXECUTE format('GRANT USAGE ON SCHEMA %I TO ctb_dashboard', current_schema());
  EXECUTE format('GRANT SELECT ON ALL TABLES IN SCHEMA %I TO ctb_dashboard', current_schema());
  EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA %I GRANT SELECT ON TABLES TO ctb_dashboard', current_schema());
END $$;
