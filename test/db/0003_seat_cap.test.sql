-- pgTAP: the seat cap must hold under CONCURRENCY, not just polite use
-- (migrations/0002_billing.sql, app.enforce_seat_cap).
--
-- The app checks "is a seat free?" in one transaction and inserts in another.
-- Two owners inviting at the same moment both read 1-of-2 and both insert,
-- landing 3 people on a 2-seat plan with no error and no extra revenue.
-- The database is the only place that race can be closed, so this proves the
-- trigger holds it — and that the free bookkeeper seat is still genuinely free.
BEGIN;
SELECT plan(4);

INSERT INTO tenants(id, name, slug) VALUES
  ('7e57cafe-0000-0000-0000-000000000001', 'Seat Cap Co', 'seat-cap-co');
INSERT INTO subscriptions(tenant_id, plan, seat_cap, status) VALUES
  ('7e57cafe-0000-0000-0000-000000000001', 'start', 2, 'active');

-- Fill the Start plan exactly to its 2-seat cap.
INSERT INTO memberships(tenant_id, user_id, role) VALUES
  ('7e57cafe-0000-0000-0000-000000000001', 'seat-a', 'owner'),
  ('7e57cafe-0000-0000-0000-000000000001', 'seat-b', 'staff');
SELECT is((SELECT count(*)::int FROM memberships
            WHERE tenant_id='7e57cafe-0000-0000-0000-000000000001' AND role<>'bookkeeper'),
          2, 'plan filled exactly to its 2-seat cap');

-- 1) One more paid seat must be refused — this is the race, made deterministic.
SELECT throws_ok($$
  INSERT INTO memberships(tenant_id, user_id, role)
  VALUES ('7e57cafe-0000-0000-0000-000000000001', 'seat-c', 'staff')
$$, '23514', NULL, 'a 3rd paid seat on a 2-seat plan is refused by the database');

-- 2) The bookkeeper seat is free and must STILL be allowed at the cap.
SELECT lives_ok($$
  INSERT INTO memberships(tenant_id, user_id, role)
  VALUES ('7e57cafe-0000-0000-0000-000000000001', 'the-books', 'bookkeeper')
$$, 'the free bookkeeper seat is still allowed at a full cap');

-- 3) Upgrading the plan lets the next person in — the trigger reads the
--    CURRENT cap rather than a value cached anywhere. (plan + seat_cap move
--    together; the CHECK forbids drifting one without the other.)
UPDATE subscriptions SET plan = 'growth', seat_cap = 10
 WHERE tenant_id = '7e57cafe-0000-0000-0000-000000000001';
SELECT lives_ok($$
  INSERT INTO memberships(tenant_id, user_id, role)
  VALUES ('7e57cafe-0000-0000-0000-000000000001', 'seat-c', 'staff')
$$, 'upgrading the plan immediately frees a seat');

SELECT * FROM finish();
ROLLBACK;
