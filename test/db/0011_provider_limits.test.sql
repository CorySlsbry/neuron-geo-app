-- pgTAP: the per-network concurrency ceiling (migrations/0007_provider_limits.sql).
--
-- ⛔ The claim is not "a limit exists" but "the limit REFUSES". A throttle that
-- has never been observed to stop anything is indistinguishable from no
-- throttle, so every assertion here is about a claim that does NOT happen.
BEGIN;
SELECT plan(8);

INSERT INTO tenants(id, name, slug) VALUES
  ('7a000000-0000-4000-8000-00000000000a', 'Limit Co', 'limit-co');
INSERT INTO memberships(tenant_id, user_id, role) VALUES
  ('7a000000-0000-4000-8000-00000000000a', 'owner-a', 'owner');

-- Two YouTube channels (ceiling 1) and two LinkedIn channels (ceiling 2), so
-- one network can be saturated while another is provably still claimable.
INSERT INTO tenant_channels(id, tenant_id, network, account_id, status, connected_at) VALUES
  ('7b000000-0000-4000-8000-000000000001', '7a000000-0000-4000-8000-00000000000a',
   'youtube',  'UC_one', 'connected', now()),
  ('7b000000-0000-4000-8000-000000000002', '7a000000-0000-4000-8000-00000000000a',
   'youtube',  'UC_two', 'connected', now()),
  ('7b000000-0000-4000-8000-000000000003', '7a000000-0000-4000-8000-00000000000a',
   'linkedin', 'li_one', 'connected', now());

INSERT INTO content_items(id, tenant_id, kind, title, status) VALUES
  ('7c000000-0000-4000-8000-000000000001', '7a000000-0000-4000-8000-00000000000a',
   'post', 'One', 'approved'),
  ('7c000000-0000-4000-8000-000000000002', '7a000000-0000-4000-8000-00000000000a',
   'post', 'Two', 'approved'),
  ('7c000000-0000-4000-8000-000000000003', '7a000000-0000-4000-8000-00000000000a',
   'post', 'Three', 'approved');

INSERT INTO jobs(id, tenant_id, kind, network, content_item_id, channel_id, dedupe_key, run_after) VALUES
  ('7d000000-0000-4000-8000-000000000001', '7a000000-0000-4000-8000-00000000000a',
   'publish', 'youtube',  '7c000000-0000-4000-8000-000000000001',
   '7b000000-0000-4000-8000-000000000001', 'lim:yt1', now() - interval '5 min'),
  ('7d000000-0000-4000-8000-000000000002', '7a000000-0000-4000-8000-00000000000a',
   'publish', 'youtube',  '7c000000-0000-4000-8000-000000000002',
   '7b000000-0000-4000-8000-000000000002', 'lim:yt2', now() - interval '4 min'),
  ('7d000000-0000-4000-8000-000000000003', '7a000000-0000-4000-8000-00000000000a',
   'publish', 'linkedin', '7c000000-0000-4000-8000-000000000003',
   '7b000000-0000-4000-8000-000000000003', 'lim:li1', now() - interval '3 min');

-- 1) every network ships with a limit, so "unconfigured" is never the state
SELECT is((SELECT count(*) FROM provider_limits)::int, 5,
  'every network has a configured ceiling');

-- 2) the customer app cannot read the throttle that governs it
SELECT ok(NOT has_table_privilege('app_user', 'public.provider_limits', 'SELECT'),
  'app_user cannot read provider_limits (infrastructure, not tenant data)');

SET ROLE app_worker;
SELECT set_config('app.current_tenant', '', true);
SELECT app.worker_checkin('w1', 'test');

-- 3) the first YouTube job claims normally
SELECT is((SELECT (app.claim_next_job('w1', 300)).id),
  '7d000000-0000-4000-8000-000000000001'::uuid,
  'the first YouTube job is claimable');

-- 4) ⛔ THE CEILING REFUSES. YouTube's limit is 1 and one is now running, so
--    the SECOND YouTube job must not be handed out — even though it is queued,
--    due, and nothing is locking it. It skips to LinkedIn instead.
SELECT set_config('app.current_tenant', '', true);
SELECT is((SELECT (app.claim_next_job('w2', 300)).id),
  '7d000000-0000-4000-8000-000000000003'::uuid,
  'YouTube is at its ceiling, so the claim skips to a network with room');

-- 5) ...and a third claim now gets NOTHING, because both networks are full
SELECT set_config('app.current_tenant', '', true);
SELECT is((SELECT (app.claim_next_job('w3', 300)).id), NULL,
  'with every network at its ceiling, the queue hands out nothing');

-- 6) the blocked job is still QUEUED, not lost, not failed
SELECT is((SELECT status FROM jobs WHERE id = '7d000000-0000-4000-8000-000000000002'),
  'queued', 'the throttled job is still queued and will run when room appears');

-- 7) raising the ceiling releases it — the limit is the only thing holding it
RESET ROLE;
UPDATE provider_limits SET max_in_flight = 2 WHERE network = 'youtube';
SET ROLE app_worker;
SELECT set_config('app.current_tenant', '', true);
SELECT is((SELECT (app.claim_next_job('w3', 300)).id),
  '7d000000-0000-4000-8000-000000000002'::uuid,
  'raising the ceiling makes the previously blocked job claimable');

-- 8) an unconfigured network is bounded at 1, not unbounded. "Unknown limit"
--    must never mean "no limit" — the COALESCE in the claim is what makes the
--    fail-closed direction the default.
RESET ROLE;
DELETE FROM provider_limits WHERE network = 'linkedin';
INSERT INTO tenant_channels(id, tenant_id, network, account_id, status, connected_at) VALUES
  ('7b000000-0000-4000-8000-000000000004', '7a000000-0000-4000-8000-00000000000a',
   'linkedin', 'li_two', 'connected', now());
INSERT INTO content_items(id, tenant_id, kind, title, status) VALUES
  ('7c000000-0000-4000-8000-000000000004', '7a000000-0000-4000-8000-00000000000a',
   'post', 'Four', 'approved');
INSERT INTO jobs(id, tenant_id, kind, network, content_item_id, channel_id, dedupe_key, run_after) VALUES
  ('7d000000-0000-4000-8000-000000000004', '7a000000-0000-4000-8000-00000000000a',
   'publish', 'linkedin', '7c000000-0000-4000-8000-000000000004',
   '7b000000-0000-4000-8000-000000000004', 'lim:li2', now() - interval '2 min');
SET ROLE app_worker;
SELECT set_config('app.current_tenant', '', true);
SELECT is((SELECT (app.claim_next_job('w4', 300)).id), NULL,
  'a network with NO configured limit is bounded at 1, never unbounded');

SELECT * FROM finish();
ROLLBACK;
