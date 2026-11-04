-- pgTAP: terminal failure (migrations/0006_abandon_job.sql).
--
-- 0005 gave the queue one way to fail: retry with backoff, dead-letter at the
-- ceiling. 0006 adds the second, for failures that a retry cannot fix. The
-- distinction this suite exists to pin down is not "does it stop" — both stop
-- eventually — but WHAT IT SAYS ABOUT THE CUSTOMER'S CONTENT while stopping.
--
-- `fail_job` at the ceiling marks the item `failed`: five real attempts were
-- made and something about the send is broken. `abandon_job` deliberately
-- leaves the item alone, because every reason it fires is a reason the item is
-- fine and the SETUP is not — rejected after approval, channel disconnected,
-- credential unreadable, live publishing switched off. Putting a red badge on
-- perfectly good writing because an OAuth client is missing would be a lie
-- told by a status column.
BEGIN;
SELECT plan(5);

INSERT INTO tenants(id, name, slug) VALUES
  ('a0a0a0a0-0000-0000-0000-00000000000a', 'Abandon Co', 'abandon-co');
INSERT INTO memberships(tenant_id, user_id, role) VALUES
  ('a0a0a0a0-0000-0000-0000-00000000000a', 'owner-a', 'owner');
INSERT INTO tenant_channels(id, tenant_id, network, account_id, status, connected_at) VALUES
  ('b0b0b0b0-0000-0000-0000-00000000000a', 'a0a0a0a0-0000-0000-0000-00000000000a',
   'youtube', 'UC_abandon', 'connected', now());
INSERT INTO content_items(id, tenant_id, kind, title, status) VALUES
  ('c0c0c0c0-0000-0000-0000-00000000000a', 'a0a0a0a0-0000-0000-0000-00000000000a',
   'post', 'Perfectly good writing', 'approved');
INSERT INTO jobs(id, tenant_id, kind, mode, network, content_item_id, channel_id, dedupe_key,
                 status, claimed_by, lease_expires_at, attempts) VALUES
  ('d0d0d0d0-0000-0000-0000-00000000000a', 'a0a0a0a0-0000-0000-0000-00000000000a',
   'publish', 'live', 'youtube', 'c0c0c0c0-0000-0000-0000-00000000000a',
   'b0b0b0b0-0000-0000-0000-00000000000a', 'seed:abandon',
   'running', 'worker-1', now() + interval '5 min', 1);

SET ROLE app_worker;

-- 1) the lease is the authorization here too
SELECT throws_ok($$
  SELECT app.abandon_job('d0d0d0d0-0000-0000-0000-00000000000a', 'worker-2', 'nope')
$$, NULL, NULL, 'a worker cannot abandon a job it does not hold');

-- 2) the holder can, and it is terminal on the FIRST call — no five attempts
--    spent on a condition that cannot change
SELECT ok(app.abandon_job('d0d0d0d0-0000-0000-0000-00000000000a', 'worker-1',
                          'live publishing is switched off'),
  'the holding worker abandons the job');

SELECT is((SELECT status FROM jobs WHERE id = 'd0d0d0d0-0000-0000-0000-00000000000a'),
  'dead', 'an abandoned job is dead immediately, not queued for another try');

-- 3) ⛔ THE POINT OF THE WHOLE MIGRATION. The content is untouched.
SELECT is((SELECT status FROM content_items
            WHERE id = 'c0c0c0c0-0000-0000-0000-00000000000a'), 'approved',
  'abandoning does NOT mark the content failed — the content was never the problem');

-- 4) ...and the reason survives for whoever has to read it later
SELECT is((SELECT last_error FROM jobs WHERE id = 'd0d0d0d0-0000-0000-0000-00000000000a'),
  'live publishing is switched off',
  'the reason is recorded verbatim on the job');

SELECT * FROM finish();
ROLLBACK;
