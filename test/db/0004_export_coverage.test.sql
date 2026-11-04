-- pgTAP: "download everything" must actually mean everything.
--
-- The bug this exists to prevent (found live in the parent codebase,
-- 2026-07-24): billing_events had no SELECT grant for app_user. Inside the
-- export's single transaction that one permission error aborted the whole
-- transaction, and the per-table catch swallowed it — so the ZIP shipped 4
-- tables out of 34 and the customer would never have known their data was
-- missing.
--
-- The code fix is savepoints + catalog discovery (account/export-stream.ts).
-- This is the other half: every tenant-scoped table must be readable by
-- app_user, or be on the explicit plumbing allowlist. Add a table, forget the
-- grant, this fails.
BEGIN;
SELECT plan(2);

CREATE TEMP TABLE _expected_unreadable(table_name text);
-- Deliberately EMPTY. Add a table here only with a written reason.

CREATE TEMP TABLE _tenant_tables AS
SELECT c.relname::text AS table_name
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  JOIN pg_attribute a ON a.attrelid = c.oid
 WHERE n.nspname = 'public'
   AND c.relkind = 'r'
   AND a.attname = 'tenant_id'
   AND a.attnum > 0
   AND NOT a.attisdropped;

-- 1) Every tenant table is SELECT-able by app_user, except the allowlist.
SELECT is(
  (SELECT coalesce(string_agg(table_name, ', ' ORDER BY table_name), '')
     FROM _tenant_tables t
    WHERE NOT has_table_privilege('app_user', 'public.' || t.table_name, 'SELECT')
      AND t.table_name NOT IN (SELECT table_name FROM _expected_unreadable)),
  '',
  'every tenant-scoped table is readable by app_user (or explicitly allowlisted)'
);

-- 2) The allowlist is honest: each entry really is unreadable. A stale entry
--    would quietly shrink the guard, so it has to keep earning its place.
SELECT is(
  (SELECT coalesce(string_agg(e.table_name, ', ' ORDER BY e.table_name), '')
     FROM _expected_unreadable e
    WHERE has_table_privilege('app_user', 'public.' || e.table_name, 'SELECT')),
  '',
  'no stale entries on the plumbing allowlist'
);

SELECT * FROM finish();
ROLLBACK;
