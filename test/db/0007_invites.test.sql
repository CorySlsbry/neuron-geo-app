-- pgTAP: join-by-link invites (migrations/0003_invites.sql).
--
-- What must hold: tenant isolation on the rows, no direct acceptance path
-- for app_user (only app.redeem_invite may spend an invite), single-use +
-- expiry + unknown all answering the same NULL, the seat cap holding at
-- REDEMPTION time (seats can fill between creating a link and clicking it),
-- the bookkeeper seat staying free, and an already-member redeem staying
-- idempotent instead of erroring or double-seating.
BEGIN;
SELECT plan(14);

-- ------------------------------------------------------------------ fixtures
INSERT INTO tenants(id, name, slug) VALUES
  ('aaaaaaaa-0000-0000-0000-000000000001', 'Invite Co',   'invite-co'),
  ('bbbbbbbb-0000-0000-0000-000000000002', 'Other Co',    'other-co');

INSERT INTO subscriptions(tenant_id, plan, seat_cap, status) VALUES
  ('aaaaaaaa-0000-0000-0000-000000000001', 'start', 2, 'active'),
  ('bbbbbbbb-0000-0000-0000-000000000002', 'start', 2, 'active');

INSERT INTO memberships(tenant_id, user_id, role) VALUES
  ('aaaaaaaa-0000-0000-0000-000000000001', 'owner-a', 'owner'),
  ('bbbbbbbb-0000-0000-0000-000000000002', 'owner-b', 'owner');

-- Tokens are stored as SHA-256 hex, exactly as the app writes them.
INSERT INTO invites(tenant_id, email, role, token_hash, invited_by, expires_at) VALUES
  ('aaaaaaaa-0000-0000-0000-000000000001', 'person1@example.com', 'staff',
   encode(digest('tok-live',  'sha256'), 'hex'), 'owner-a', now() + interval '7 days'),
  ('aaaaaaaa-0000-0000-0000-000000000001', 'person2@example.com', 'staff',
   encode(digest('tok-live2', 'sha256'), 'hex'), 'owner-a', now() + interval '7 days'),
  ('aaaaaaaa-0000-0000-0000-000000000001', 'person3@example.com',  'staff',
   encode(digest('tok-exp',   'sha256'), 'hex'), 'owner-a', now() - interval '1 hour'),
  ('aaaaaaaa-0000-0000-0000-000000000001', 'person4@example.com',   'bookkeeper',
   encode(digest('tok-book',  'sha256'), 'hex'), 'owner-a', now() + interval '7 days'),
  ('aaaaaaaa-0000-0000-0000-000000000001', 'person5@example.com', 'admin',
   encode(digest('tok-dup',   'sha256'), 'hex'), 'owner-a', now() + interval '7 days'),
  ('bbbbbbbb-0000-0000-0000-000000000002', 'person6@example.com', 'viewer',
   encode(digest('tok-b',     'sha256'), 'hex'), 'owner-b', now() + interval '7 days');

-- ------------------------------------------------- assertions as app_user
SET ROLE app_user;
SELECT set_config('app.current_uid', 'owner-a', true);
SELECT set_config('app.current_tenant', 'aaaaaaaa-0000-0000-0000-000000000001', true);
SELECT set_config('app.current_departments', '', true);

-- 1) tenant isolation: A sees exactly its own invites
SELECT is((SELECT count(*) FROM invites)::int, 5,
  'tenant A sees exactly its 5 invites');

-- 2) B's rows are invisible even by explicit id
SELECT is((SELECT count(*) FROM invites
            WHERE tenant_id = 'bbbbbbbb-0000-0000-0000-000000000002')::int, 0,
  'tenant A sees 0 of tenant B''s invites');

-- 3) WITH CHECK: cannot mint an invite into a foreign tenant
SELECT throws_ok($$
  INSERT INTO invites(tenant_id, email, role, token_hash, invited_by)
  VALUES ('bbbbbbbb-0000-0000-0000-000000000002', 'person7@example.com', 'staff', 'deadbeef', 'owner-a')
$$, '42501', NULL, 'cross-tenant invite INSERT is blocked');

-- 4) no UPDATE grant: app_user cannot spend an invite by hand — only the
--    definer function may, which is what makes single-use provable
SELECT throws_ok($$
  UPDATE invites SET accepted_at = now()
$$, '42501', NULL, 'app_user has no UPDATE path onto invites');

-- 5) redeem: a live token joins the tenant
SELECT is(
  app.redeem_invite(encode(digest('tok-live', 'sha256'), 'hex'), 'new-user-1'),
  'aaaaaaaa-0000-0000-0000-000000000001'::uuid,
  'a live token redeems to the inviting tenant');

-- 6) …with the ROLE the invite named, not a default
SELECT is(
  (SELECT role FROM memberships
    WHERE tenant_id = 'aaaaaaaa-0000-0000-0000-000000000001'
      AND user_id = 'new-user-1'),
  'staff',
  'the membership carries the invite''s role');

-- 7) …and the invite is spent, with the accepter on record
SELECT is(
  (SELECT accepted_by FROM invites
    WHERE token_hash = encode(digest('tok-live', 'sha256'), 'hex')),
  'new-user-1',
  'the spent invite records who accepted it');

-- 8) single-use: the same token again is dead
SELECT is(
  app.redeem_invite(encode(digest('tok-live', 'sha256'), 'hex'), 'someone-else'),
  NULL::uuid,
  'a spent token cannot be redeemed again');

-- 9) expiry: a stale token is dead
SELECT is(
  app.redeem_invite(encode(digest('tok-exp', 'sha256'), 'hex'), 'someone-else'),
  NULL::uuid,
  'an expired token cannot be redeemed');

-- 10) unknown tokens get the SAME answer as spent/expired — nothing to probe
SELECT is(
  app.redeem_invite(encode(digest('never-issued', 'sha256'), 'hex'), 'someone-else'),
  NULL::uuid,
  'an unknown token is indistinguishable from a spent or expired one');

-- 11) the seat cap holds at REDEMPTION time: A is now 2-of-2 (owner-a +
--     new-user-1), so the second staff link — minted while a seat was free —
--     hits the wall
SELECT throws_ok($$
  SELECT app.redeem_invite(encode(digest('tok-live2', 'sha256'), 'hex'), 'third-user')
$$, '23514', NULL, 'redemption at a full cap is refused by the seat trigger');

-- 12) the bookkeeper seat is free and still joins at a full cap
SELECT is(
  app.redeem_invite(encode(digest('tok-book', 'sha256'), 'hex'), 'the-cpa'),
  'aaaaaaaa-0000-0000-0000-000000000001'::uuid,
  'the free bookkeeper seat redeems past a full cap');

-- 13) an existing member redeeming again succeeds quietly…
SELECT is(
  app.redeem_invite(encode(digest('tok-dup', 'sha256'), 'hex'), 'owner-a'),
  'aaaaaaaa-0000-0000-0000-000000000001'::uuid,
  'an already-member redeem succeeds (idempotent join)');

-- 14) …without duplicating or demoting their membership
SELECT is(
  (SELECT count(*) FROM memberships
    WHERE tenant_id = 'aaaaaaaa-0000-0000-0000-000000000001'
      AND user_id = 'owner-a')::int,
  1,
  'no duplicate membership from an already-member redeem');

SELECT * FROM finish();
ROLLBACK;
