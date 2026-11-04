-- pgTAP: self-service tenant delete, on the REAL object graph
-- (migrations/0001_security_spine.sql, app.purge_current_tenant).
--
-- The parent codebase's original purge made exactly two passes and the second
-- had no error handler, so any tenant whose data was more than two foreign
-- keys deep could not be deleted — the advertised "your data is yours, leave
-- whenever" promise failing for exactly the customers who used the product.
-- The fix (parent 0033) sweeps to a FIXED POINT and then VERIFIES.
--
-- The spine's deepest chain today:
--   member_department_access -> memberships -> tenants   (3 levels)
--   member_department_access -> departments -> tenants
-- Alphabetical order visits `departments` and `memberships` BEFORE
-- `member_department_access`, so a single pass in name order cannot finish —
-- which is precisely what the fixed-point loop exists to survive. (The FKs
-- also carry ON DELETE CASCADE; the purge does not rely on it, and the sweep
-- must converge even if a future table forgets the cascade.)
BEGIN;
SELECT plan(7);

INSERT INTO tenants(id, name, slug) VALUES
  ('44444444-1111-4444-4444-444444444444', 'Purge Deep', 'purge-deep'),
  ('44444444-2222-4444-4444-444444444444', 'Bystander',  'purge-bystander');
INSERT INTO memberships(id, tenant_id, user_id, role) VALUES
  ('44444444-aaaa-4444-4444-444444444444', '44444444-1111-4444-4444-444444444444', 'user-purge', 'owner'),
  ('44444444-bbbb-4444-4444-444444444444', '44444444-2222-4444-4444-444444444444', 'user-other', 'owner');
INSERT INTO departments(id, tenant_id, key, name) VALUES
  ('44444444-cccc-4444-4444-444444444444', '44444444-1111-4444-4444-444444444444', 'content', 'Content team'),
  ('44444444-dddd-4444-4444-444444444444', '44444444-2222-4444-4444-444444444444', 'content', 'Content team');
INSERT INTO member_department_access(tenant_id, membership_id, department_id) VALUES
  ('44444444-1111-4444-4444-444444444444', '44444444-aaaa-4444-4444-444444444444',
   '44444444-cccc-4444-4444-444444444444'),
  ('44444444-2222-4444-4444-444444444444', '44444444-bbbb-4444-4444-444444444444',
   '44444444-dddd-4444-4444-444444444444');
INSERT INTO subscriptions(tenant_id, plan, seat_cap, status) VALUES
  ('44444444-1111-4444-4444-444444444444', 'start', 2, 'active'),
  ('44444444-2222-4444-4444-444444444444', 'start', 2, 'active');
INSERT INTO events(tenant_id, name) VALUES
  ('44444444-1111-4444-4444-444444444444', 'purge-me'),
  ('44444444-2222-4444-4444-444444444444', 'keep-me');
INSERT INTO billing_events(event_id, tenant_id, type) VALUES
  ('evt_purge_1', '44444444-1111-4444-4444-444444444444', 'invoice.paid');
INSERT INTO idempotency_keys(tenant_id, key, route, request_hash, claimed_by) VALUES
  ('44444444-1111-4444-4444-444444444444', 'k1', '/api/x', 'h', 'user-purge');

SET ROLE app_user;
SELECT set_config('app.current_uid', 'user-purge', true);
SELECT set_config('app.current_tenant', '44444444-1111-4444-4444-444444444444', true);
SELECT set_config('app.current_departments', 'content', true);

-- 1) It completes at all, across a graph whose children sort AFTER their
--    parents alphabetically (the shape that broke the two-pass version).
SELECT lives_ok(
  $$ SELECT app.purge_current_tenant() $$,
  'purge completes on the multi-level foreign-key graph');

-- 2) ...and the deepest child is actually gone (not silently skipped).
SELECT is((SELECT count(*) FROM member_department_access
            WHERE tenant_id = '44444444-1111-4444-4444-444444444444')::int,
          0, 'deepest child rows are gone');

-- 3) ...and every other tenant-scoped row of the doomed tenant is gone.
RESET ROLE;
SELECT is((SELECT count(*) FROM events
            WHERE tenant_id = '44444444-1111-4444-4444-444444444444')::int,
          0, 'events are gone');
SELECT is((SELECT count(*)
             FROM subscriptions s
        FULL JOIN billing_events b USING (tenant_id)
            WHERE tenant_id = '44444444-1111-4444-4444-444444444444')::int,
          0, 'billing rows (subscription + event log) are gone');

-- 4) ...and the tenant itself no longer exists.
SELECT is((SELECT count(*) FROM tenants
            WHERE id = '44444444-1111-4444-4444-444444444444')::int,
          0, 'the tenant row is removed');

-- 5) The bystander tenant is untouched — purge reads the GUC and takes no
--    argument, so it cannot reach across.
SELECT is((SELECT count(*) FROM member_department_access
            WHERE tenant_id = '44444444-2222-4444-4444-444444444444')::int,
          1, 'another tenant keeps its data');

-- 6) With no tenant in scope it refuses rather than doing something ambitious.
SET ROLE app_user;
SELECT set_config('app.current_tenant', '', true);
SELECT throws_ok(
  $$ SELECT app.purge_current_tenant() $$,
  NULL, NULL, 'refuses to run with no tenant in scope');

SELECT * FROM finish();
ROLLBACK;
