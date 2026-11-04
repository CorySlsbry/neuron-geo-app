-- pgTAP: no view may bypass row-level security.
--
-- A plain CREATE VIEW runs with its OWNER's rights (the migration superuser),
-- which bypasses RLS on the base tables entirely. That happened once in the
-- parent codebase: a nudge view leaked every tenant's completed jobs to every
-- other tenant until its migration 0007 set security_invoker on it.
--
-- The squashed chain ships NO views, which is exactly why this guards the
-- CLASS: add a view, forget the option, and this test fails before the leak
-- ships. A rule the schema enforces beats a rule someone has to remember.
BEGIN;
SELECT plan(1);

SELECT is(
  (SELECT coalesce(string_agg(c.relname, ', ' ORDER BY c.relname), '')
     FROM pg_class c
     JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relkind = 'v'
      -- Exclude views owned by an EXTENSION (pgTAP installs pg_all_foreign_keys
      -- and tap_funky into public). They are not ours, they expose catalog
      -- metadata rather than tenant data, and we cannot ALTER them anyway.
      AND NOT EXISTS (
            SELECT 1 FROM pg_depend d
             WHERE d.objid = c.oid AND d.deptype = 'e')
      -- reloptions is NULL when no option was ever set, hence the coalesce
      AND NOT coalesce(
            (SELECT option_value::boolean
               FROM pg_options_to_table(c.reloptions)
              WHERE option_name = 'security_invoker'),
            false)),
  '',
  'every view in public runs with security_invoker = true (RLS applies to the caller)'
);

SELECT * FROM finish();
ROLLBACK;
