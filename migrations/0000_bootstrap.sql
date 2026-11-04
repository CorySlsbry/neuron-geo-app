-- 0000_bootstrap — extensions used across the schema.
-- Real tables, roles, and RLS policies arrive in 0001_security_spine.
-- (The app role itself — app_user, NOSUPERUSER + NOBYPASSRLS — is created
-- outside the chain: db/init/00-init.sql locally, scripts/bootstrap-prod-db.sql
-- in production. Migrations run as the owner role and must never create the
-- login role they grant to.)
CREATE EXTENSION IF NOT EXISTS pgcrypto; -- gen_random_uuid(), digest()
