-- Runs once on first container init (docker-entrypoint-initdb.d).
-- Enables extensions and creates the NON-superuser application role. The app
-- ALWAYS connects as app_user (no BYPASSRLS) so it can never bypass RLS;
-- migrations run as the superuser `postgres`.
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS pgtap;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_user') THEN
    CREATE ROLE app_user LOGIN PASSWORD 'app_pw' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
  END IF;
END
$$;

GRANT CONNECT ON DATABASE neurongeo TO app_user;
GRANT USAGE ON SCHEMA public TO app_user;
-- Table/sequence privileges are granted per-table by the S1+ migrations.
