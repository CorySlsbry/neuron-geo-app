-- pgTAP: connected channels, their credentials, and the content queue
-- (migrations/0004_channels_content.sql).
--
-- What must hold, in the house pattern: tenant isolation on every read, the
-- WITH CHECK refusing every cross-tenant write, an UNSET tenant GUC yielding
-- nothing rather than everything (fail-closed), and the write surface being
-- exactly the columns the grants name — no path that can move a row between
-- tenants or strip a sample row of its label.
--
-- Plus the two guards that are specific to this migration: the COMPOSITE
-- foreign keys. Foreign key checks are not subject to RLS — they run as the
-- referencing table's owner and see every row in the database — so a plain
-- `REFERENCES tenant_channels(id)` would happily let tenant A hang its
-- content, and its credentials, off tenant B's connected account. Binding
-- tenant_id into the key is what makes that unrepresentable, and assertions
-- 8 and 9 are what prove the binding is really there.
--
-- ⛔ A note on how the cross-tenant UPDATEs are checked (assertions 21-22).
-- RLS refuses an out-of-scope UPDATE by making the rows INVISIBLE, not by
-- raising: the statement succeeds and reports zero rows. So "it did not
-- error" proves nothing at all. The test fires the update for real, then
-- drops back to the owner role at the end and asserts the rival's rows are
-- still exactly as they were. Absence of an exception is not evidence; the
-- untouched row is.
BEGIN;
SELECT plan(22);

-- ------------------------------------------------------------------ fixtures
INSERT INTO tenants(id, name, slug) VALUES
  ('cccccccc-0000-0000-0000-00000000000a', 'Channel Co', 'channel-co'),
  ('dddddddd-0000-0000-0000-00000000000b', 'Rival Co',   'rival-co');

INSERT INTO memberships(tenant_id, user_id, role) VALUES
  ('cccccccc-0000-0000-0000-00000000000a', 'owner-a', 'owner'),
  ('dddddddd-0000-0000-0000-00000000000b', 'owner-b', 'owner');

INSERT INTO tenant_channels(id, tenant_id, network, handle, account_id, status, scopes, connected_at) VALUES
  ('11111111-aaaa-0000-0000-000000000001', 'cccccccc-0000-0000-0000-00000000000a',
   'youtube',  '@channelco', 'UC_channelco', 'connected', ARRAY['youtube.upload'], now()),
  ('11111111-aaaa-0000-0000-000000000002', 'cccccccc-0000-0000-0000-00000000000a',
   'linkedin', 'channel-co', 'li_channelco', 'disconnected', ARRAY[]::text[], now()),
  -- The rival's channel. Everything below must be unable to see it, write to
  -- it, or hang a row off it.
  ('22222222-bbbb-0000-0000-000000000001', 'dddddddd-0000-0000-0000-00000000000b',
   'youtube',  '@rivalco',   'UC_rivalco',  'connected', ARRAY['youtube.upload'], now()),
  -- A second rival channel with NO credential row. Assertion 9 needs one:
  -- tenant_credentials is UNIQUE(channel_id), and against a channel that
  -- already has a credential the unique index raises 23505 BEFORE the foreign
  -- key is ever consulted — so the test would pass on the wrong constraint
  -- and would keep passing if the composite FK were weakened to a plain
  -- single-column reference.
  ('22222222-bbbb-0000-0000-000000000002', 'dddddddd-0000-0000-0000-00000000000b',
   'tiktok',   '@rivalco',   'tt_rivalco',  'connected', ARRAY[]::text[], now());

INSERT INTO tenant_credentials(tenant_id, channel_id, enc_token, expires_at) VALUES
  ('cccccccc-0000-0000-0000-00000000000a', '11111111-aaaa-0000-0000-000000000001',
   '\x676141414141'::bytea, now() + interval '1 hour'),
  ('dddddddd-0000-0000-0000-00000000000b', '22222222-bbbb-0000-0000-000000000001',
   '\x676242424242'::bytea, now() + interval '1 hour');

INSERT INTO content_items(id, tenant_id, kind, title, body, status, channel_id, is_sample) VALUES
  ('33333333-cccc-0000-0000-000000000001', 'cccccccc-0000-0000-0000-00000000000a',
   'post', 'Draft one', 'body', 'draft', '11111111-aaaa-0000-0000-000000000001', true),
  ('33333333-cccc-0000-0000-000000000002', 'cccccccc-0000-0000-0000-00000000000a',
   'reel', 'In review', 'body', 'in_review', NULL, true),
  ('33333333-cccc-0000-0000-000000000003', 'cccccccc-0000-0000-0000-00000000000a',
   'answer_page', 'Approved already', 'body', 'approved', NULL, false),
  ('44444444-dddd-0000-0000-000000000001', 'dddddddd-0000-0000-0000-00000000000b',
   'post', 'Rival draft', 'body', 'draft', NULL, false);

-- ------------------------------------------------- assertions as app_user
SET ROLE app_user;
SELECT set_config('app.current_uid', 'owner-a', true);
SELECT set_config('app.current_tenant', 'cccccccc-0000-0000-0000-00000000000a', true);
SELECT set_config('app.current_departments', '', true);

-- 1) channels: A sees exactly its own
SELECT is((SELECT count(*) FROM tenant_channels)::int, 2,
  'tenant A sees exactly its 2 channels');

-- 2) ...and B's is invisible even when named by id
SELECT is((SELECT count(*) FROM tenant_channels
            WHERE id = '22222222-bbbb-0000-0000-000000000001')::int, 0,
  'tenant A cannot see the rival''s channel by explicit id');

-- 3) WITH CHECK: no minting a channel into a foreign tenant
SELECT throws_ok($$
  INSERT INTO tenant_channels(tenant_id, network, account_id)
  VALUES ('dddddddd-0000-0000-0000-00000000000b', 'tiktok', 'tt_x')
$$, '42501', NULL, 'cross-tenant channel INSERT is blocked');

-- 4) content: A sees exactly its own
SELECT is((SELECT count(*) FROM content_items)::int, 3,
  'tenant A sees exactly its 3 content items');

-- 5) WITH CHECK on content
SELECT throws_ok($$
  INSERT INTO content_items(tenant_id, kind, title)
  VALUES ('dddddddd-0000-0000-0000-00000000000b', 'post', 'not yours')
$$, '42501', NULL, 'cross-tenant content INSERT is blocked');

-- 6) credentials: A sees only its own token row
SELECT is((SELECT count(*) FROM tenant_credentials)::int, 1,
  'tenant A sees exactly its 1 credential row');

-- 7) WITH CHECK on credentials
SELECT throws_ok($$
  INSERT INTO tenant_credentials(tenant_id, channel_id, enc_token)
  VALUES ('dddddddd-0000-0000-0000-00000000000b',
          '22222222-bbbb-0000-0000-000000000001', '\x00'::bytea)
$$, '42501', NULL, 'cross-tenant credential INSERT is blocked');

-- 8) ⛔ THE COMPOSITE FK, content side. tenant_id is A (so RLS is satisfied)
--    but the channel belongs to B. A single-column FK would ACCEPT this and
--    tenant A would be publishing through the rival's connected account.
SELECT throws_ok($$
  INSERT INTO content_items(tenant_id, kind, title, channel_id)
  VALUES ('cccccccc-0000-0000-0000-00000000000a', 'post', 'hijack',
          '22222222-bbbb-0000-0000-000000000001')
$$, '23503', NULL,
  'content cannot reference another tenant''s channel (composite FK)');

-- 9) ⛔ The composite FK, credential side — the same hole, one table over.
SELECT throws_ok($$
  INSERT INTO tenant_credentials(tenant_id, channel_id, enc_token)
  VALUES ('cccccccc-0000-0000-0000-00000000000a',
          '22222222-bbbb-0000-0000-000000000002', '\x00'::bytea)
$$, '23503', NULL,
  'a credential cannot reference another tenant''s channel (composite FK)');

-- 10) disconnecting must LEAVE the channel row (and its history) behind, so
--     the app is given no DELETE path onto it at all
SELECT ok(NOT has_table_privilege('app_user', 'public.tenant_channels', 'DELETE'),
  'app_user has no DELETE path onto tenant_channels');

-- 11) no column grant can move a row between tenants
SELECT ok(NOT has_column_privilege('app_user', 'public.content_items', 'tenant_id', 'UPDATE'),
  'app_user cannot UPDATE content_items.tenant_id');

-- 12) ...nor quietly strip a demo row of its "sample content" label
SELECT ok(NOT has_column_privilege('app_user', 'public.content_items', 'is_sample', 'UPDATE'),
  'app_user cannot UPDATE content_items.is_sample');

-- 13) the status vocabulary is closed
SELECT throws_ok($$
  UPDATE content_items SET status = 'live'
   WHERE id = '33333333-cccc-0000-0000-000000000001'
$$, '23514', NULL, 'an unknown content status is refused by the CHECK');

-- ---- the transitions the Review screen actually performs, for real
UPDATE content_items
   SET status = 'approved', reviewed_by = 'owner-a', reviewed_at = now(),
       updated_at = now()
 WHERE id = '33333333-cccc-0000-0000-000000000001'
   AND status IN ('draft','in_review');

-- 14) it moved, and it recorded who moved it
SELECT is(
  (SELECT status || '/' || reviewed_by FROM content_items
    WHERE id = '33333333-cccc-0000-0000-000000000001'),
  'approved/owner-a',
  'a draft item in my own tenant moves to approved and records the reviewer');

-- 15) all three tables are ENABLE **and** FORCE — the migration's guard block
--     asserts this at apply time; this asserts it on the database as replayed
SELECT is((SELECT count(*) FROM pg_class c
             JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE n.nspname = 'public'
              AND c.relname IN ('tenant_channels','tenant_credentials','content_items')
              AND c.relrowsecurity AND c.relforcerowsecurity)::int, 3,
  'all three new tables are ENABLE + FORCE row level security');

-- ---- onboarding writes the brand facts onto the tenant's own row
UPDATE tenants SET domain = 'channel-co.com', onboarded_at = now()
 WHERE id = 'cccccccc-0000-0000-0000-00000000000a';

-- 16) the column grant and the tenants_member_update policy BOTH have to be
--     right for this to land; either one missing fails silently (0001's note)
SELECT is(
  (SELECT domain FROM tenants WHERE id = 'cccccccc-0000-0000-0000-00000000000a'),
  'channel-co.com',
  'onboarding can write the brand domain onto its own tenant');

-- ---- fire the cross-tenant updates. Neither raises; both must do nothing.
UPDATE tenant_channels SET status = 'error', last_error = 'pwned'
 WHERE tenant_id = 'dddddddd-0000-0000-0000-00000000000b';
UPDATE content_items SET status = 'approved'
 WHERE tenant_id = 'dddddddd-0000-0000-0000-00000000000b';

-- ------------------------------------------------------------- fail-closed
-- Everything below runs with NO tenant in scope: app.current_tenant() is
-- NULL, every policy compares against NULL, and NULL is not true. This is the
-- state a bug in scope resolution produces, and it must yield NOTHING rather
-- than everything.
SELECT set_config('app.current_tenant', '', true);

-- 17-19) no rows, on any of the three
SELECT is((SELECT count(*) FROM tenant_channels)::int, 0,
  'an unset tenant GUC sees zero channels (fail-closed)');
SELECT is((SELECT count(*) FROM content_items)::int, 0,
  'an unset tenant GUC sees zero content items (fail-closed)');
SELECT is((SELECT count(*) FROM tenant_credentials)::int, 0,
  'an unset tenant GUC sees zero credentials (fail-closed)');

-- 20) ...and cannot write either
SELECT throws_ok($$
  INSERT INTO content_items(tenant_id, kind, title)
  VALUES ('cccccccc-0000-0000-0000-00000000000a', 'post', 'unscoped')
$$, '42501', NULL, 'an unset tenant GUC cannot INSERT content');

-- --------------------------------------------- the rival, seen from outside
-- Back to the owner role, which is the only vantage point from which "did
-- tenant A's cross-tenant UPDATE actually change anything?" can be answered.
RESET ROLE;

-- 21) the rival's channel is exactly as it was — not 'error', no last_error
SELECT is(
  (SELECT status || '/' || coalesce(last_error, 'none') FROM tenant_channels
    WHERE id = '22222222-bbbb-0000-0000-000000000001'),
  'connected/none',
  'the rival''s channel survived tenant A''s cross-tenant UPDATE untouched');

-- 22) ...and so did the rival's content
SELECT is(
  (SELECT status FROM content_items
    WHERE id = '44444444-dddd-0000-0000-000000000001'),
  'draft',
  'the rival''s content survived tenant A''s cross-tenant UPDATE untouched');

SELECT * FROM finish();
ROLLBACK;
