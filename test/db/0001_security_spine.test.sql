-- pgTAP negative tests for the security spine (migrations/0001_security_spine.sql).
-- Run inside a transaction that is rolled back. Fixtures are inserted as the
-- superuser (which bypasses RLS); the assertions run as `app_user` (subject to
-- RLS) to prove isolation actually holds.
BEGIN;
SELECT plan(15);

-- ------------------------------------------------------------------ fixtures
INSERT INTO tenants(id, name, slug) VALUES
  ('11111111-1111-1111-1111-111111111111', 'Tenant A', 'a'),
  ('22222222-2222-2222-2222-222222222222', 'Tenant B', 'b');

INSERT INTO memberships(tenant_id, user_id, role) VALUES
  ('11111111-1111-1111-1111-111111111111', 'user-a', 'owner'),
  ('22222222-2222-2222-2222-222222222222', 'user-b', 'owner');

INSERT INTO events(tenant_id, name) VALUES
  ('11111111-1111-1111-1111-111111111111', 'a-event-1'),
  ('11111111-1111-1111-1111-111111111111', 'a-event-2'),
  ('22222222-2222-2222-2222-222222222222', 'b-event-1');

-- Session revocation epochs for both principals (inserted as superuser; the
-- app normally self-creates its own row through the own_epoch policy).
INSERT INTO user_session_epochs(user_id) VALUES ('user-a'), ('user-b');

-- A representative department-walled table, to prove the wall MECHANISM.
-- Nothing seeds departments in the GEO shape, and no product table is walled
-- yet — the keys below are arbitrary on purpose: any future table gates on
-- app.can_see_department('<key>') exactly like this.
CREATE TABLE _dept_walled (
  tenant_id  uuid NOT NULL,
  department text NOT NULL,
  note       text NOT NULL
);
ALTER TABLE _dept_walled ENABLE ROW LEVEL SECURITY;
ALTER TABLE _dept_walled FORCE  ROW LEVEL SECURITY;
CREATE POLICY _dw_isolation ON _dept_walled
  USING (tenant_id = app.current_tenant() AND app.can_see_department(department));
GRANT SELECT ON _dept_walled TO app_user;
INSERT INTO _dept_walled VALUES
  ('11111111-1111-1111-1111-111111111111', 'hr-payroll', 'comp'),
  ('11111111-1111-1111-1111-111111111111', 'dispatch',   'route');

-- ------------------------------------------------- assertions as app_user
SET ROLE app_user;

-- 1) fail-closed: no tenant scope => zero sensitive rows
SELECT set_config('app.current_uid', '', true);
SELECT set_config('app.current_tenant', '', true);
SELECT set_config('app.current_departments', '', true);
SELECT is((SELECT count(*) FROM events)::int, 0,
  'events fail-closed: unset tenant scope returns zero rows');

-- 2) scoped to tenant A => sees only A's rows
SELECT set_config('app.current_tenant', '11111111-1111-1111-1111-111111111111', true);
SELECT is((SELECT count(*) FROM events)::int, 2,
  'tenant A sees exactly its 2 events');
SELECT is((SELECT count(*) FROM events
           WHERE tenant_id = '22222222-2222-2222-2222-222222222222')::int, 0,
  'tenant A sees 0 of tenant B (foreign rows invisible even by explicit id)');

-- 3) WITH CHECK: cannot write a row into a foreign tenant while scoped to A
SELECT throws_ok(
  $$ INSERT INTO events(tenant_id, name)
     VALUES ('22222222-2222-2222-2222-222222222222', 'x') $$,
  '42501',
  'new row violates row-level security policy for table "events"',
  'WITH CHECK blocks cross-tenant write');

-- 4) directory resolves pre-GUC: as user-a with no tenant scope, sees ONLY own
SELECT set_config('app.current_uid', 'user-a', true);
SELECT set_config('app.current_tenant', '', true);
SELECT is((SELECT count(*) FROM memberships)::int, 1,
  'user-a sees only their own membership before a tenant GUC exists');
SELECT is((SELECT count(*) FROM tenants)::int, 1,
  'user-a sees only tenant A (not tenant B)');

-- 5) department wall: a dispatch-only member sees 0 payroll rows
SELECT set_config('app.current_tenant', '11111111-1111-1111-1111-111111111111', true);
SELECT set_config('app.current_departments', 'dispatch', true);
SELECT is((SELECT count(*) FROM _dept_walled)::int, 1,
  'dispatch-only member sees only dispatch-tagged rows');
SELECT is((SELECT count(*) FROM _dept_walled WHERE department = 'hr-payroll')::int, 0,
  'dispatch-only member sees 0 hr-payroll rows');
-- and with no department scope, sees none
SELECT set_config('app.current_departments', '', true);
SELECT is((SELECT count(*) FROM _dept_walled)::int, 0,
  'department wall fail-closed: no department scope returns zero rows');

-- 6) session revocation: the epoch table pins every row to its own principal
SELECT set_config('app.current_uid', 'user-a', true);
SELECT is((SELECT count(*) FROM user_session_epochs)::int, 1,
  'a principal sees ONLY their own session epoch row');
SELECT results_eq(
  $$ UPDATE user_session_epochs
        SET epoch = epoch + 1, updated_at = now()
      WHERE user_id = 'user-a'
     RETURNING epoch $$,
  ARRAY[2],
  'a principal can bump their OWN epoch (logout revokes every device)');
-- Aim an UPDATE at user-b's epoch: under the own_epoch policy it silently
-- matches zero rows. Verified from the superuser side, where the row is
-- visible — it must still carry its original epoch.
UPDATE user_session_epochs SET epoch = 99 WHERE user_id = 'user-b';
RESET ROLE;
SELECT is((SELECT epoch FROM user_session_epochs WHERE user_id = 'user-b'), 1,
  'bumping ANOTHER user''s epoch silently matched zero rows (policy holds)');
SET ROLE app_user;
SELECT set_config('app.current_uid', 'user-a', true);
SELECT throws_ok(
  $$ INSERT INTO user_session_epochs(user_id) VALUES ('user-b') $$,
  '42501', NULL,
  'WITH CHECK blocks minting an epoch row for someone else');

-- 7) the app role genuinely cannot bypass RLS
RESET ROLE;
SELECT is((SELECT rolsuper FROM pg_roles WHERE rolname = 'app_user'), false,
  'app_user is not a superuser');
SELECT is((SELECT rolbypassrls FROM pg_roles WHERE rolname = 'app_user'), false,
  'app_user does not have BYPASSRLS');

SELECT * FROM finish();
ROLLBACK;
