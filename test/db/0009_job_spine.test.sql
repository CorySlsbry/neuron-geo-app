-- pgTAP: the job spine and the worker principal (migrations/0005_job_spine.sql).
--
-- 0005 introduces the first role in this schema that can see across tenants,
-- so this suite exists mostly to pin down how narrow that really is. Three
-- claims have to survive:
--
--   1. app_worker sees the QUEUE across tenants, and NOTHING ELSE without
--      first being scoped to exactly one tenant. Assertions 15-16.
--   2. The route to `published` is one function, and a rehearsal cannot take
--      it. Assertions 10, 25, 26.
--   3. A job cannot stitch one tenant's content to another tenant's channel,
--      for the same reason 0008 proves it of content and credentials: foreign
--      keys are not subject to RLS. Assertions 13-14.
--
-- ⛔ On timing. Every assertion below runs inside ONE transaction, so `now()`
-- is frozen at transaction start. That is what makes the lease tests
-- deterministic: `lease_expires_at = now() + 300s` is genuinely in the future
-- for the whole suite, and an "expired" lease is one written as `now() - 1
-- minute`. Nothing here sleeps or races.
BEGIN;
SELECT plan(37);

-- ------------------------------------------------------------------ fixtures
INSERT INTO tenants(id, name, slug) VALUES
  ('aaaa1111-0000-0000-0000-00000000000a', 'Job Co',   'job-co'),
  ('bbbb2222-0000-0000-0000-00000000000b', 'Rival Co', 'rival-jobs');

INSERT INTO memberships(tenant_id, user_id, role) VALUES
  ('aaaa1111-0000-0000-0000-00000000000a', 'owner-a', 'owner'),
  ('bbbb2222-0000-0000-0000-00000000000b', 'owner-b', 'owner');

INSERT INTO tenant_channels(id, tenant_id, network, handle, account_id, status, connected_at) VALUES
  ('c1c1c1c1-0000-0000-0000-00000000000a', 'aaaa1111-0000-0000-0000-00000000000a',
   'youtube', '@jobco', 'UC_jobco', 'connected', now()),
  -- A second channel for tenant A on a DIFFERENT network. 0007 caps YouTube at
  -- one in flight, so three YouTube jobs would make this suite a test of the
  -- throttle instead of the spine. Spanning networks keeps each suite about
  -- one thing (the ceiling itself is proven in 0011).
  ('c1c1c1c1-0000-0000-0000-00000000000b', 'aaaa1111-0000-0000-0000-00000000000a',
   'linkedin', 'jobco', 'li_jobco', 'connected', now()),
  ('c2c2c2c2-0000-0000-0000-00000000000b', 'bbbb2222-0000-0000-0000-00000000000b',
   'youtube', '@rival', 'UC_rival', 'connected', now());

INSERT INTO content_items(id, tenant_id, kind, title, status) VALUES
  ('d1d1d1d1-0000-0000-0000-000000000001', 'aaaa1111-0000-0000-0000-00000000000a',
   'post', 'Approved one',   'approved'),
  ('d1d1d1d1-0000-0000-0000-000000000002', 'aaaa1111-0000-0000-0000-00000000000a',
   'post', 'Approved two',   'approved'),
  ('d1d1d1d1-0000-0000-0000-000000000003', 'aaaa1111-0000-0000-0000-00000000000a',
   'post', 'Still a draft',  'draft'),
  ('d1d1d1d1-0000-0000-0000-000000000004', 'aaaa1111-0000-0000-0000-00000000000a',
   'post', 'Approved four',  'approved'),
  ('d2d2d2d2-0000-0000-0000-000000000001', 'bbbb2222-0000-0000-0000-00000000000b',
   'post', 'Rival approved', 'approved');

-- run_after is set explicitly so the claim order below is a fact, not a
-- coincidence of insertion timing.
INSERT INTO jobs(id, tenant_id, kind, mode, network, content_item_id, channel_id,
                 dedupe_key, run_after) VALUES
  ('e1e1e1e1-0000-0000-0000-000000000001', 'aaaa1111-0000-0000-0000-00000000000a',
   'publish', 'dry_run', 'youtube', 'd1d1d1d1-0000-0000-0000-000000000001',
   'c1c1c1c1-0000-0000-0000-00000000000a', 'seed:a1', now() - interval '5 min'),
  ('e1e1e1e1-0000-0000-0000-000000000002', 'aaaa1111-0000-0000-0000-00000000000a',
   'publish', 'live',    'linkedin', 'd1d1d1d1-0000-0000-0000-000000000002',
   'c1c1c1c1-0000-0000-0000-00000000000b', 'seed:a2', now() - interval '4 min'),
  ('e2e2e2e2-0000-0000-0000-000000000001', 'bbbb2222-0000-0000-0000-00000000000b',
   'publish', 'dry_run', 'youtube', 'd2d2d2d2-0000-0000-0000-000000000001',
   'c2c2c2c2-0000-0000-0000-00000000000b', 'seed:b1', now() - interval '3 min');

-- ============================================== the web tier (app_user)
SET ROLE app_user;
SELECT set_config('app.current_uid', 'owner-a', true);
SELECT set_config('app.current_tenant', 'aaaa1111-0000-0000-0000-00000000000a', true);
SELECT set_config('app.current_departments', '', true);

-- 1) the queue is tenant-scoped like everything else
SELECT is((SELECT count(*) FROM jobs)::int, 2,
  'tenant A sees exactly its 2 jobs');

-- 2) ...and naming the rival's job by id does not conjure it
SELECT is((SELECT count(*) FROM jobs
            WHERE id = 'e2e2e2e2-0000-0000-0000-000000000001')::int, 0,
  'tenant A cannot see the rival''s job by explicit id');

-- 3-4) the INSERT column list is the write surface: the web tier may ASK for
--      work, and may not claim the work already happened
SELECT ok(NOT has_column_privilege('app_user', 'public.jobs', 'status', 'INSERT'),
  'app_user cannot INSERT a jobs.status of its choosing');
SELECT ok(NOT has_column_privilege('app_user', 'public.jobs', 'status', 'UPDATE'),
  'app_user cannot UPDATE jobs.status');

-- 5) claiming is the worker's alone. A request handler that could claim could
--    also mark work done without doing it.
SELECT ok(NOT has_function_privilege('app_user', 'app.claim_next_job(text,integer)', 'EXECUTE'),
  'app_user has no EXECUTE on app.claim_next_job');

-- 6) the vetted enqueue path works for approved content
SELECT isnt(
  (SELECT app.enqueue_publish('d1d1d1d1-0000-0000-0000-000000000004',
                              'c1c1c1c1-0000-0000-0000-00000000000a', 'dry_run')),
  NULL, 'enqueue_publish returns a job for approved content');

-- 7) ⛔ IDEMPOTENT. Double-clicking Approve must not produce two posts.
SELECT is(
  (SELECT app.enqueue_publish('d1d1d1d1-0000-0000-0000-000000000004',
                              'c1c1c1c1-0000-0000-0000-00000000000a', 'dry_run')),
  (SELECT id FROM jobs WHERE dedupe_key =
     'publish:d1d1d1d1-0000-0000-0000-000000000004:c1c1c1c1-0000-0000-0000-00000000000a:dry_run'),
  'enqueueing the same publish twice returns the SAME job');

-- 8) unapproved content cannot be queued for publication
SELECT throws_ok($$
  SELECT app.enqueue_publish('d1d1d1d1-0000-0000-0000-000000000003',
                             'c1c1c1c1-0000-0000-0000-00000000000a', 'dry_run')
$$, NULL, 'only approved content can be published (status=draft)',
  'a draft cannot be enqueued for publishing');

-- 9) another tenant's content reads as ABSENT, not as forbidden — RLS has
--    already made it invisible, so the function never learns it exists
SELECT throws_ok($$
  SELECT app.enqueue_publish('d2d2d2d2-0000-0000-0000-000000000001',
                             'c1c1c1c1-0000-0000-0000-00000000000a', 'dry_run')
$$, NULL, 'content item not found in this tenant',
  'the rival''s content cannot be enqueued (it is invisible, not refused)');

-- 10) ⛔ THE HONESTY GUARD. app_user holds UPDATE on content_items.status, so
--     before 0005 the web tier could write 'published' having published
--     nothing. 0004's comment promised it would not; this makes the database
--     refuse it.
SELECT throws_ok($$
  UPDATE content_items SET status = 'published'
   WHERE id = 'd1d1d1d1-0000-0000-0000-000000000001'
$$, '23514', NULL,
  'the app cannot mark content published — only app.complete_publish() can');

-- 11) ...and the guard is narrow. Every other transition the review screen
--      performs still works; a blanket freeze would have broken Approve.
SELECT lives_ok($$
  UPDATE content_items SET status = 'rejected'
   WHERE id = 'd1d1d1d1-0000-0000-0000-000000000003'
$$, 'ordinary status transitions are untouched by the publish guard');

-- 12) fail-closed: no tenant in scope yields nothing, never everything
SELECT set_config('app.current_tenant', '', true);
SELECT is((SELECT count(*) FROM jobs)::int, 0,
  'an unscoped session sees ZERO jobs, not every tenant''s');

RESET ROLE;

-- ================================== the composite foreign keys (as owner)
-- Same class of hole 0008 closes for content and credentials. tenant_id is A,
-- so RLS is satisfied; the referenced row belongs to B. A single-column FK
-- accepts both of these and the queue becomes a cross-tenant publishing
-- machine.

-- 13) the job cannot point at another tenant's content
SELECT throws_ok($$
  INSERT INTO jobs(tenant_id, kind, network, content_item_id, channel_id, dedupe_key)
  VALUES ('aaaa1111-0000-0000-0000-00000000000a', 'publish', 'youtube',
          'd2d2d2d2-0000-0000-0000-000000000001',
          'c1c1c1c1-0000-0000-0000-00000000000a', 'hijack:1')
$$, '23503', NULL,
  'a job cannot reference another tenant''s content item (composite FK)');

-- 14) ...nor publish through another tenant's connected account
SELECT throws_ok($$
  INSERT INTO jobs(tenant_id, kind, network, content_item_id, channel_id, dedupe_key)
  VALUES ('aaaa1111-0000-0000-0000-00000000000a', 'publish', 'youtube',
          'd1d1d1d1-0000-0000-0000-000000000001',
          'c2c2c2c2-0000-0000-0000-00000000000b', 'hijack:2')
$$, '23503', NULL,
  'a job cannot reference another tenant''s channel (composite FK)');

-- ==================================================== the worker (app_worker)
SET ROLE app_worker;
SELECT set_config('app.current_tenant', '', true);
SELECT app.worker_checkin('worker-1', 'test-host');

-- 15) the one deliberate cross-tenant read: the queue, unscoped.
--
-- ⛔ Asserted against THIS SUITE'S OWN ROWS, not against a total. An earlier
-- version said `count(*) = 4` and passed only because the database happened to
-- be empty; the moment a fixture from anything else existed, a correct
-- implementation failed the test. Same trap as an absolute "queued >= 1" gate
-- standing in for a delta. The claim here is cross-tenant VISIBILITY — that
-- the worker can see tenant B's job, which app_user provably cannot — so name
-- the rows and let unrelated data be irrelevant.
SELECT is((SELECT count(*) FROM jobs
            WHERE id IN ('e1e1e1e1-0000-0000-0000-000000000001',
                         'e1e1e1e1-0000-0000-0000-000000000002',
                         'e2e2e2e2-0000-0000-0000-000000000001'))::int, 3,
  'the worker sees BOTH tenants'' jobs (2 from A, 1 from B) with no tenant scope');

-- 16) ⛔ AND NOTHING ELSE. The queue is ids and status; everything a customer
--     wrote stays behind the same GUC every other role answers to.
SELECT is((SELECT count(*) FROM content_items)::int, 0,
  'an unscoped WORKER sees ZERO content items — queue-wide is not data-wide');

-- 17-19) claim the oldest eligible job, and be TOLD which tenant it is for
SELECT is((SELECT (app.claim_next_job('worker-1', 300)).id),
  'e1e1e1e1-0000-0000-0000-000000000001'::uuid,
  'claim_next_job takes the oldest eligible job');

SELECT ok((SELECT status = 'running' AND claimed_by = 'worker-1'
                  AND lease_expires_at > now()
             FROM jobs WHERE id = 'e1e1e1e1-0000-0000-0000-000000000001'),
  'the claimed job is running, attributed, and under a live lease');

SELECT is(current_setting('app.current_tenant', true),
  'aaaa1111-0000-0000-0000-00000000000a',
  'claiming SCOPES the session to the job''s tenant (the worker never chose it)');

-- 20) a second claim cannot hand out the same row — and the ORDER is a fact,
--     so assert which row it does hand out rather than merely which it does not
SELECT is((SELECT (app.claim_next_job('worker-1', 300)).id),
  'e1e1e1e1-0000-0000-0000-000000000002'::uuid,
  'a second claim moves on to the next job, never re-issuing the first');

-- 21-22) the lease belongs to whoever holds it
SELECT is(app.heartbeat_job('e1e1e1e1-0000-0000-0000-000000000001', 'worker-2', 300),
  false, 'a worker cannot extend another worker''s lease');
SELECT is(app.heartbeat_job('e1e1e1e1-0000-0000-0000-000000000001', 'worker-1', 300),
  true, 'the holding worker can extend its own lease');

-- 23) completion is lease-checked too
SELECT throws_ok($$
  SELECT app.complete_publish('e1e1e1e1-0000-0000-0000-000000000001', 'worker-2')
$$, NULL, NULL, 'a worker cannot complete a job it does not hold');

-- 24) ⛔ a live publish that cannot say WHERE it published is not a publish
SELECT throws_ok($$
  SELECT app.complete_publish('e1e1e1e1-0000-0000-0000-000000000002', 'worker-1')
$$, NULL, 'a live publish must report the URL it published to',
  'a live completion with no URL is refused');

-- ⛔ A NOTE ON WHY EVERY PAIR BELOW IS TWO STATEMENTS AND NOT ONE.
-- `SELECT ok(mutating_fn() AND (SELECT ... FROM t))` does NOT work. Postgres
-- takes the snapshot at STATEMENT start, so the sub-select reads the table as
-- it was BEFORE the function in the same statement changed it. Written that
-- way, assertion 26 below passed while asserting nothing — the item still read
-- 'approved' because the update was invisible, not because the dry run
-- declined to make it. A test that can pass for the wrong reason is worse than
-- no test. Call the function, THEN assert, in a separate statement.

-- 25-26) ⛔ THE REHEARSAL CANNOT LIE. A dry run completes the JOB and leaves
--        the content item exactly where it was.
SELECT lives_ok($$
  SELECT app.complete_publish('e1e1e1e1-0000-0000-0000-000000000001',
                              'worker-1', NULL, 'rehearsed')
$$, 'a dry run completes its job');

SELECT is((SELECT status FROM content_items
            WHERE id = 'd1d1d1d1-0000-0000-0000-000000000001'), 'approved',
  'the rehearsed item is still approved — a dry run publishes NOTHING');

-- 27-28) the live path is the one that writes it, URL and all
SELECT ok(app.complete_publish('e1e1e1e1-0000-0000-0000-000000000002',
                               'worker-1', 'https://youtu.be/real'),
  'a live completion reports success');

SELECT ok((SELECT status = 'published' AND published_url = 'https://youtu.be/real'
             FROM content_items WHERE id = 'd1d1d1d1-0000-0000-0000-000000000002'),
  'the live path publishes the item and records the destination URL');

-- 29-30) failure retries with backoff rather than spinning
SELECT set_config('app.current_tenant', '', true);
SELECT is((SELECT (app.claim_next_job('worker-1', 300)).id),
  'e2e2e2e2-0000-0000-0000-000000000001'::uuid,
  'the worker moves on to the next tenant''s job');

SELECT is(app.fail_job('e2e2e2e2-0000-0000-0000-000000000001', 'worker-1', 'boom'),
  'queued', 'a recoverable failure re-queues the job');

SELECT ok((SELECT run_after > now() AND attempts = 1
             FROM jobs WHERE id = 'e2e2e2e2-0000-0000-0000-000000000001'),
  'the re-queued job carries a backoff and a counted attempt');

-- 32-33) ...but not forever. At the ceiling it goes DEAD and the customer's
--        item stops claiming to be on its way.
RESET ROLE;
UPDATE jobs SET status = 'running', claimed_by = 'worker-1',
                lease_expires_at = now() + interval '5 min',
                attempts = 5, max_attempts = 5
 WHERE id = 'e2e2e2e2-0000-0000-0000-000000000001';
SET ROLE app_worker;

SELECT is(app.fail_job('e2e2e2e2-0000-0000-0000-000000000001', 'worker-1', 'boom again'),
  'dead', 'at max_attempts the job is dead-lettered, not retried forever');

SELECT is((SELECT status FROM content_items
            WHERE id = 'd2d2d2d2-0000-0000-0000-000000000001'), 'failed',
  'a dead job marks its content failed — no item left claiming to be in flight');

-- 34-35) a worker that dies holds nothing
RESET ROLE;
UPDATE jobs SET status = 'running', claimed_by = 'ghost-worker',
                lease_expires_at = now() - interval '1 min'
 WHERE id = 'e1e1e1e1-0000-0000-0000-000000000001';
SET ROLE app_worker;

SELECT ok(app.reap_expired_leases() >= 1,
  'reaping finds the abandoned lease');

SELECT ok((SELECT status = 'queued' AND claimed_by IS NULL
             FROM jobs WHERE id = 'e1e1e1e1-0000-0000-0000-000000000001'),
  'the abandoned job is back in the queue, unattributed');

-- 36-37) the worker's write surface is as small as the web tier's. It can
--        report where content went; it cannot author or rewrite it.
SELECT ok(NOT has_table_privilege('app_worker', 'public.content_items', 'INSERT'),
  'app_worker cannot create content items');
SELECT ok(NOT has_column_privilege('app_worker', 'public.content_items', 'title', 'UPDATE'),
  'app_worker cannot rewrite a customer''s copy');

SELECT * FROM finish();
ROLLBACK;
