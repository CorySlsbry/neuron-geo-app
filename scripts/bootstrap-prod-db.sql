-- Bootstrap the production database roles.
--
-- Run ONCE as the `postgres` superuser against a fresh Cloud SQL instance,
-- BEFORE migrations. Migrations then run as postgres (they create policies and
-- revoke grants, which the app role must never be able to do), and the app
-- connects only ever as app_user.
--
-- The whole tenant-isolation guarantee rests on two properties of this role:
--   1. NOSUPERUSER  — a superuser silently ignores RLS.
--   2. NOBYPASSRLS  — the explicit form of the same guarantee.
-- If either is lost, every RLS policy in the schema becomes decorative. The
-- verification block at the bottom refuses to finish if that is the case.
--
-- Usage (through the Cloud SQL Auth Proxy, so nothing is exposed publicly):
--   psql "host=127.0.0.1 port=5433 user=postgres dbname=neurongeo" \
--     -v app_password="'<from Secret Manager>'" -f scripts/bootstrap-prod-db.sql

\set ON_ERROR_STOP on

-- The application role. No CREATEDB, no CREATEROLE, no superuser, no bypass.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_user') THEN
    EXECUTE format('CREATE ROLE app_user LOGIN PASSWORD %L', current_setting('bootstrap.app_password'));
  ELSE
    EXECUTE format('ALTER ROLE app_user WITH LOGIN PASSWORD %L', current_setting('bootstrap.app_password'));
  END IF;
END $$;

-- NOTE: on Cloud SQL the `postgres` login is NOT a true superuser (it is a
-- member of cloudsqlsuperuser), so it MAY NOT set the SUPERUSER / BYPASSRLS /
-- REPLICATION attributes at all -- "permission denied to alter role". That is
-- fine: a freshly created role has none of them. We therefore only strip the
-- attributes we CAN set, and then VERIFY the rest below rather than assuming.
ALTER ROLE app_user NOCREATEDB NOCREATEROLE;

-- app_user may USE the schema but never reshape it: migrations own DDL.
GRANT CONNECT ON DATABASE neurongeo TO app_user;
GRANT USAGE ON SCHEMA public TO app_user;
REVOKE CREATE ON SCHEMA public FROM app_user;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;

-- Cloud SQL's default `postgres` user is not a true superuser; it belongs to
-- cloudsqlsuperuser. Make sure objects it creates are owned somewhere app_user
-- cannot escalate through.
REVOKE ALL ON DATABASE neurongeo FROM PUBLIC;

-- ---------------------------------------------------------------- verify
-- Refuse to report success if the isolation guarantee is not actually true.
DO $$
DECLARE r record;
BEGIN
  SELECT rolsuper, rolbypassrls, rolcreatedb, rolcreaterole, rolcanlogin
    INTO r FROM pg_roles WHERE rolname = 'app_user';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'app_user was not created';
  END IF;
  IF r.rolsuper THEN
    RAISE EXCEPTION 'app_user is SUPERUSER — RLS would be silently ignored';
  END IF;
  IF r.rolbypassrls THEN
    RAISE EXCEPTION 'app_user has BYPASSRLS — every tenant policy is decorative';
  END IF;
  IF r.rolcreatedb OR r.rolcreaterole THEN
    RAISE EXCEPTION 'app_user has CREATEDB/CREATEROLE — more privilege than it needs';
  END IF;
  IF NOT r.rolcanlogin THEN
    RAISE EXCEPTION 'app_user cannot log in';
  END IF;
  RAISE NOTICE 'app_user OK: nosuperuser, nobypassrls, login, no create rights';
END $$;
