-- 0007_provider_limits — a ceiling on how much this system can throw at one
-- platform at once.
--
-- WHAT WAS MISSING. The queue bounds RETRIES (exponential backoff, dead-letter
-- at max_attempts) but nothing bounded DISTINCT jobs. Approve one item for a
-- tenant with five channels and five jobs become claimable instantly; ten
-- tenants approving in the same minute is fifty. Every one of those is a
-- publish to a real platform the moment live mode is switched on, and the
-- platforms whose review we are asking for are exactly the parties who would
-- notice. Harmless while every job is a rehearsal; not something to discover
-- afterwards.
--
-- ⛔ ENFORCED AT THE CLAIM, NOT AT THE SEND. A worker that checks a limit just
-- before calling out has already been handed the job, so two workers check
-- independently and both proceed — the classic read-then-act race. Refusing to
-- CLAIM makes the database the arbiter: the ceiling is evaluated inside the
-- same statement that takes the row, so N workers cannot collectively exceed
-- it. Same reasoning as the review queue's `AND status IN (...)` guard.

-- ================================================== the network, denormalized
-- ⛔ WHY A COPY RATHER THAN A JOIN. `claim_next_job` runs across tenants and
-- must not read tenant-owned tables — `tenant_channels` is GUC-scoped and the
-- claim has no tenant scope yet, by design (it learns the tenant FROM the row
-- it claims). Joining to find the network would either fail closed and claim
-- nothing, or require handing the worker cross-tenant sight of a customer
-- table. Copying one enum-like value onto the job avoids both.
--
-- The privacy cost is real but small and worth naming: `jobs` now also carries
-- WHICH NETWORK, alongside the ids and statuses it already held. It still
-- carries nothing a customer wrote - no handle, no account id, no title.
ALTER TABLE jobs ADD COLUMN network text
  CHECK (network IN ('youtube','instagram','facebook','tiktok','linkedin'));

-- Backfill before the NOT NULL, so an existing queue survives the migration.
-- The subquery is safe here: migrations run as the owner outside RLS scoping,
-- and this is the one moment the mapping is allowed to be recomputed.
UPDATE jobs j SET network = ch.network
  FROM tenant_channels ch
 WHERE ch.id = j.channel_id AND j.network IS NULL;

-- Any row that still has no network references a channel that no longer
-- exists, which the composite FK's ON DELETE CASCADE should have removed.
DELETE FROM jobs WHERE network IS NULL;
ALTER TABLE jobs ALTER COLUMN network SET NOT NULL;

CREATE INDEX jobs_network_running_idx ON jobs(network) WHERE status = 'running';

-- ==================================================== the limits themselves
-- A TABLE rather than a constant in the function, because these are numbers an
-- operator will want to change at 2am without shipping a migration — and
-- because the value that is right for TikTok's publish API is not the value
-- that is right for a YouTube resumable upload.
--
-- Infrastructure, not tenant data: no app_user policy exists, so the customer
-- app cannot read or edit the throttle that governs it.
CREATE TABLE provider_limits (
  network text PRIMARY KEY
          CHECK (network IN ('youtube','instagram','facebook','tiktok','linkedin')),
  -- How many jobs for this network may be RUNNING at once, across all tenants
  -- and all workers.
  max_in_flight integer NOT NULL DEFAULT 2 CHECK (max_in_flight > 0),
  note text,
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE provider_limits ENABLE ROW LEVEL SECURITY;
ALTER TABLE provider_limits FORCE  ROW LEVEL SECURITY;
CREATE POLICY provider_limits_worker ON provider_limits
  FOR ALL TO app_worker USING (true) WITH CHECK (true);

-- Deliberately conservative. These are ceilings on concurrency, not targets,
-- and the cost of being too low is a slower queue while the cost of being too
-- high is a platform deciding we look like abuse during the exact week we are
-- asking them to approve us.
INSERT INTO provider_limits(network, max_in_flight, note) VALUES
  ('youtube',   1, 'Resumable uploads are heavy and quota-metered; one at a time.'),
  ('tiktok',    1, 'Publish API is rate-limited per app and the app is under review.'),
  ('instagram', 2, 'Container create + publish is two calls per post.'),
  ('facebook',  2, 'Graph API page posts are cheap but share the app rate limit.'),
  ('linkedin',  2, 'Per-member throttles are undocumented; stay quiet.');

COMMENT ON TABLE provider_limits IS
  'Per-network concurrency ceilings, enforced inside app.claim_next_job so N '
  'workers cannot collectively exceed one. Infrastructure: no app_user policy.';

-- ========================================== the claim, now ceiling-aware
-- ⛔ The ONLY change from 0005 is the added NOT EXISTS clause. Everything else
-- (no tenant argument, FOR UPDATE SKIP LOCKED, setting the GUC from the
-- claimed row) is unchanged and load-bearing — see 0005's comments.
CREATE OR REPLACE FUNCTION app.claim_next_job(
  p_worker text, p_lease_seconds integer DEFAULT 300
) RETURNS jobs
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, app AS $$
DECLARE v_job jobs;
BEGIN
  IF p_worker IS NULL OR p_worker = '' THEN
    RAISE EXCEPTION 'worker id required';
  END IF;
  IF p_lease_seconds <= 0 OR p_lease_seconds > 3600 THEN
    RAISE EXCEPTION 'lease must be between 1 and 3600 seconds';
  END IF;

  UPDATE jobs SET
    status           = 'running',
    claimed_by       = p_worker,
    claimed_at       = now(),
    lease_expires_at = now() + make_interval(secs => p_lease_seconds),
    attempts         = attempts + 1,
    updated_at       = now()
  WHERE id = (
    SELECT j.id FROM jobs j
     WHERE j.status = 'queued' AND j.run_after <= now()
       -- The ceiling. A job is claimable only while its network has room.
       -- COALESCE so a network with no configured row is still bounded rather
       -- than unlimited: an unknown limit must not mean "no limit".
       AND (
         SELECT count(*) FROM jobs r
          WHERE r.status = 'running' AND r.network = j.network
       ) < COALESCE(
         (SELECT l.max_in_flight FROM provider_limits l WHERE l.network = j.network),
         1
       )
     ORDER BY j.run_after, j.created_at
     FOR UPDATE SKIP LOCKED
     LIMIT 1
  )
  RETURNING * INTO v_job;

  IF v_job.id IS NULL THEN
    RETURN NULL;
  END IF;

  PERFORM set_config('app.current_tenant', v_job.tenant_id::text, true);

  UPDATE job_workers SET last_seen_at = now(), current_job = v_job.id
   WHERE worker_id = p_worker;

  RETURN v_job;
END $$;

ALTER FUNCTION app.claim_next_job(text, integer) OWNER TO app_worker;

-- ============================================ enqueue records the network too
CREATE OR REPLACE FUNCTION app.enqueue_publish(
  p_content_item uuid, p_channel uuid, p_mode text DEFAULT 'dry_run'
) RETURNS uuid
LANGUAGE plpgsql SET search_path = public, app AS $$
DECLARE
  v_tenant  uuid := app.current_tenant();
  v_status  text;
  v_network text;
  v_job     uuid;
BEGIN
  IF v_tenant IS NULL THEN
    RAISE EXCEPTION 'no tenant in scope — refusing to enqueue';
  END IF;
  IF p_mode NOT IN ('dry_run','live') THEN
    RAISE EXCEPTION 'unknown publish mode: %', p_mode;
  END IF;

  SELECT status INTO v_status FROM content_items WHERE id = p_content_item;
  IF v_status IS NULL THEN
    RAISE EXCEPTION 'content item not found in this tenant';
  END IF;
  IF v_status <> 'approved' THEN
    RAISE EXCEPTION 'only approved content can be published (status=%)', v_status;
  END IF;

  -- RLS scopes this read, so a channel belonging to anyone else is simply not
  -- found — the same shape as the content lookup above.
  SELECT network INTO v_network FROM tenant_channels WHERE id = p_channel;
  IF v_network IS NULL THEN
    RAISE EXCEPTION 'channel not found in this tenant';
  END IF;

  INSERT INTO jobs(tenant_id, kind, mode, network, content_item_id, channel_id, dedupe_key)
  VALUES (v_tenant, 'publish', p_mode, v_network, p_content_item, p_channel,
          format('publish:%s:%s:%s', p_content_item, p_channel, p_mode))
  ON CONFLICT (tenant_id, dedupe_key) DO UPDATE
    SET updated_at = now()
  RETURNING id INTO v_job;

  RETURN v_job;
END $$;

-- ⛔ The new column needs a GRANT or `enqueue_publish` cannot write it.
-- 0005's INSERT grant listed six columns; adding `network` to the statement
-- without adding it here fails with "permission denied for table jobs" — the
-- write must survive the whole chain (schema -> grant -> statement), and the
-- grant is the link that is easiest to forget because nothing in the function
-- body mentions it.
GRANT INSERT (network) ON jobs TO app_user;
GRANT EXECUTE ON FUNCTION app.enqueue_publish(uuid, uuid, text) TO app_user;
GRANT SELECT ON provider_limits TO app_worker;
GRANT UPDATE (max_in_flight, note, updated_at) ON provider_limits TO app_worker;

-- ========================================================= verify, don't assume
DO $$
DECLARE v_bad text;
BEGIN
  SELECT string_agg(c.relname, ', ') INTO v_bad
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND c.relname = 'provider_limits'
     AND NOT (c.relrowsecurity AND c.relforcerowsecurity);
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION '0007: expected ENABLE + FORCE RLS on %', v_bad;
  END IF;

  IF (SELECT count(*) FROM provider_limits) <> 5 THEN
    RAISE EXCEPTION '0007: every network needs a limit row, found %',
      (SELECT count(*) FROM provider_limits);
  END IF;
END $$;
