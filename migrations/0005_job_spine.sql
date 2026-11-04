-- 0005_job_spine — the durable work queue the publishing path runs on, and the
-- worker principal that drains it.
--
-- WHY THIS EXISTS, in one sentence: approving a piece of content has to survive
-- the laptop closing. A publish that lives in a request handler is lost the
-- moment anything goes wrong, and "we posted it" is the one claim this product
-- cannot get wrong in front of a platform reviewer.
--
-- ⛔ THE SHAPE THAT MATTERS. There are now TWO principals, not one:
--
--   app_user   — the web tier. Sees exactly one tenant, always, on every table.
--   app_worker — the publishing daemon. Sees the QUEUE across all tenants
--                (it has to; one worker serves everybody), but sees tenant
--                DATA through the same fail-closed GUC as the web tier.
--
-- That split is the whole security design. The worker's cross-tenant power is
-- confined to `jobs`, a table holding ids and status and nothing a customer
-- wrote. To touch content, channels or credentials it must first scope itself
-- to a single tenant, and it gets that tenant from the JOB ROW, never from an
-- argument a caller supplies. A worker that forgets to scope sees zero rows
-- rather than everybody's — the same failure direction as every other table
-- in this schema.
--
-- ⛔ WHY THE DEFINERS ARE OWNED BY app_worker AND NOT BY THE MIGRATION ROLE.
-- These tables are FORCE RLS, which means the table OWNER is subject to
-- policies too. A SECURITY DEFINER owned by the migration role would therefore
-- match no policy at all on Cloud SQL (where that role is not a real
-- superuser) while appearing to work perfectly in local dev (where it is one).
-- That is a bug that ships green and fails in production, so ownership is
-- pinned to app_worker, whose policies are written out below and are identical
-- in both environments. Same lesson as 0001's "set the GUC so it works even
-- where the owner role is not a true superuser".

-- ================================================== the worker's login role
-- NOLOGIN here; the deployment grants LOGIN and a password/IAM identity. It is
-- deliberately NOT a member of app_user: the worker must not inherit the web
-- tier's grants, and the web tier must never gain the worker's queue-wide
-- visibility.
-- The membership grant is not decoration: ALTER FUNCTION ... OWNER TO requires
-- the migration role to be a member of the new owner. Local dev runs as a real
-- superuser and would never notice; Cloud SQL's `postgres` is not one and the
-- migration would fail there. Granting it here keeps both environments on the
-- same path (the house lesson from 0001's Cloud SQL note).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_worker') THEN
    CREATE ROLE app_worker NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
  END IF;
  IF NOT pg_has_role(current_user, 'app_worker', 'MEMBER') THEN
    EXECUTE format('GRANT app_worker TO %I', current_user);
  END IF;
END $$;

GRANT USAGE ON SCHEMA app TO app_worker;

-- content_items needs this before anything can composite-FK to it. Same
-- reasoning as tenant_channels in 0004: a plain REFERENCES content_items(id)
-- is satisfied by ANY row, including another tenant's, because foreign key
-- checks run as the referencing table's owner with row security off.
ALTER TABLE content_items ADD CONSTRAINT content_items_tenant_id_key
  UNIQUE (tenant_id, id);

-- ============================================================== the queue
CREATE TABLE jobs (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  kind       text NOT NULL CHECK (kind IN ('publish')),

  -- ⛔ THE DRY-RUN SWITCH, AND WHY IT IS A COLUMN.
  -- 'dry_run' walks the entire path — claim, scope, load the channel, decrypt
  -- the credential, build the payload, record the outcome — and stops before
  -- the network call. 'live' is the only mode that contacts a platform. It is
  -- a stored column rather than an env var so that after the fact you can read
  -- a row and know, with certainty, whether anything left this machine. An
  -- env-var-only switch leaves no evidence, and "did that job actually post?"
  -- is the exact question a rehearsal has to be able to answer.
  mode       text NOT NULL DEFAULT 'dry_run' CHECK (mode IN ('dry_run','live')),

  status     text NOT NULL DEFAULT 'queued'
             CHECK (status IN ('queued','running','succeeded','failed','dead')),

  content_item_id uuid NOT NULL,
  channel_id      uuid NOT NULL,

  -- Lease, not lock. A worker that dies mid-job holds nothing: the lease
  -- simply expires and app.reap_expired_leases() puts the job back. A lock
  -- would need the dead process to come back and release it.
  claimed_by        text,
  claimed_at        timestamptz,
  lease_expires_at  timestamptz,

  attempts     integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  max_attempts integer NOT NULL DEFAULT 5 CHECK (max_attempts > 0),
  -- Exponential backoff lives here rather than in the worker's sleep loop, so
  -- a restarted worker honours it and a crashed one cannot lose it.
  run_after    timestamptz NOT NULL DEFAULT now(),

  last_error  text,
  -- What happened, in words, for the operator console and for a dry run to
  -- report what it WOULD have done.
  result_note text,

  -- ⛔ IDEMPOTENCY, ENFORCED BY THE DATABASE.
  -- Double-clicking Approve, a retried request, or two schedulers racing must
  -- not produce two posts. The natural key is (tenant, content item, channel):
  -- enqueueing the same publish twice is a no-op, not a second job. Live and
  -- dry-run rows are deliberately distinguished so a rehearsal does not block
  -- the real send that follows it.
  dedupe_key text NOT NULL,

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,

  UNIQUE (tenant_id, dedupe_key),

  -- Both composite. The job, the content it publishes, and the channel it
  -- publishes through must all belong to the same tenant, and the database is
  -- what guarantees it. ON DELETE CASCADE on both: a job for content or a
  -- channel that no longer exists has nothing to do.
  FOREIGN KEY (tenant_id, content_item_id)
    REFERENCES content_items(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, channel_id)
    REFERENCES tenant_channels(tenant_id, id) ON DELETE CASCADE
);

-- The claim query's index: eligible work, oldest first. Partial, because
-- finished jobs are the overwhelming majority of the table over time and none
-- of them are ever claimed again.
CREATE INDEX jobs_claimable_idx ON jobs(run_after, created_at)
  WHERE status = 'queued';
CREATE INDEX jobs_lease_idx ON jobs(lease_expires_at) WHERE status = 'running';
CREATE INDEX jobs_tenant_idx ON jobs(tenant_id, created_at DESC);

ALTER TABLE jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE jobs FORCE  ROW LEVEL SECURITY;

-- The web tier: one tenant, fail-closed on a NULL GUC, exactly like every
-- other tenant table.
CREATE POLICY jobs_isolation ON jobs
  FOR ALL TO app_user
  USING      (tenant_id = app.current_tenant())
  WITH CHECK (tenant_id = app.current_tenant());

-- The worker: the whole queue. This is the ONE deliberate cross-tenant read
-- in the schema, and it is confined to a table whose columns are ids, status
-- and timestamps. No title, no body, no token. Everything a customer actually
-- wrote stays behind the GUC-scoped policies below.
CREATE POLICY jobs_worker ON jobs
  FOR ALL TO app_worker
  USING (true) WITH CHECK (true);

COMMENT ON TABLE jobs IS
  'Durable work queue. Leased, not locked: a dead worker''s job returns to '
  'the queue when its lease expires. app_user sees one tenant; app_worker '
  'sees the whole queue (ids and status only) and must scope itself by GUC '
  'to touch anything a customer wrote. mode=dry_run walks the entire path '
  'without contacting a platform.';

-- ====================================================== worker liveness
-- NOT tenant-scoped: this is infrastructure, and it is what lets the operator
-- console say "the worker has not checked in for 6 minutes" instead of
-- silently showing an empty queue that looks like calm.
CREATE TABLE job_workers (
  worker_id    text PRIMARY KEY,
  hostname     text,
  started_at   timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  -- Denormalised so the console does not need a join to answer the only
  -- question it asks: is anything actually being worked on right now.
  current_job  uuid
);

ALTER TABLE job_workers ENABLE ROW LEVEL SECURITY;
ALTER TABLE job_workers FORCE ROW LEVEL SECURITY;
-- No app_user policy at all: the customer-facing app has no business reading
-- the fleet. Absence of a policy is a denial, which is the fail-closed
-- direction.
CREATE POLICY job_workers_worker ON job_workers
  FOR ALL TO app_worker USING (true) WITH CHECK (true);

COMMENT ON TABLE job_workers IS
  'Worker heartbeats for the operator console. Infrastructure, not tenant '
  'data: no app_user policy exists, so the customer app cannot read it.';

-- ============================================ the worker's view of tenant data
-- Deliberately NOTHING here, and that is the point worth writing down.
--
-- The policies on content_items, tenant_channels, tenant_credentials and
-- events (0001, 0004) carry no TO clause, which means TO PUBLIC — they already
-- apply to every role, app_worker included, with exactly the predicate wanted:
-- `tenant_id = app.current_tenant()`, fail-closed on a NULL GUC. Adding
-- app_worker copies would be duplicate policies that OR together, so a later
-- tightening of one would be silently undone by the other.
--
-- So the worker's privilege is narrower than it first appears: it may act for
-- ANY tenant, never for all of them at once, and the only table where it sees
-- across the boundary is `jobs` above. Assertions 6 and 7 in the pgTAP file
-- prove the worker really is blind to tenant data without a GUC.

-- ⛔ ================================= the publish flag is not the app's to set
-- 0004's comment promises that nothing writes 'published' until something
-- genuinely publishes. That was a promise about the CODE, and app_user holds
-- UPDATE on the status column, so the schema did not actually enforce it.
--
-- This trigger makes it structural. A row may only reach 'published' inside a
-- transaction that has set app.publishing = 'on', and the only thing that sets
-- it is app.complete_publish() below, which will not run unless a live job
-- with a valid lease reported a real destination URL. The web tier can no
-- longer mark something published, by accident or by a bug, and neither can a
-- future route that forgets. Encode the rule, do not comment it.
CREATE OR REPLACE FUNCTION app.guard_published_status()
RETURNS trigger LANGUAGE plpgsql SET search_path = public, app AS $$
BEGIN
  IF NEW.status = 'published'
     AND (TG_OP = 'INSERT' OR OLD.status IS DISTINCT FROM 'published')
     AND COALESCE(current_setting('app.publishing', true), '') <> 'on' THEN
    RAISE EXCEPTION
      'content_items.status=published may only be set by app.complete_publish()'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER content_items_publish_guard
  BEFORE INSERT OR UPDATE ON content_items
  FOR EACH ROW EXECUTE FUNCTION app.guard_published_status();

-- ============================================================ enqueue (web)
-- Called by the web tier when a customer approves an item. SECURITY INVOKER on
-- purpose: it must run with the caller's own tenant scope, so an app_user
-- session can only ever enqueue for its own tenant, enforced by the same RLS
-- as everything else. The ON CONFLICT is the idempotency: approving twice
-- returns the existing job instead of creating a rival.
CREATE OR REPLACE FUNCTION app.enqueue_publish(
  p_content_item uuid, p_channel uuid, p_mode text DEFAULT 'dry_run'
) RETURNS uuid
LANGUAGE plpgsql SET search_path = public, app AS $$
DECLARE
  v_tenant uuid := app.current_tenant();
  v_status text;
  v_job    uuid;
BEGIN
  IF v_tenant IS NULL THEN
    RAISE EXCEPTION 'no tenant in scope — refusing to enqueue';
  END IF;
  IF p_mode NOT IN ('dry_run','live') THEN
    RAISE EXCEPTION 'unknown publish mode: %', p_mode;
  END IF;

  -- RLS already restricts this SELECT to the caller's tenant, so a content id
  -- belonging to somebody else reads as "not found" rather than as a leak.
  SELECT status INTO v_status FROM content_items WHERE id = p_content_item;
  IF v_status IS NULL THEN
    RAISE EXCEPTION 'content item not found in this tenant';
  END IF;
  IF v_status <> 'approved' THEN
    RAISE EXCEPTION 'only approved content can be published (status=%)', v_status;
  END IF;

  INSERT INTO jobs(tenant_id, kind, mode, content_item_id, channel_id, dedupe_key)
  VALUES (v_tenant, 'publish', p_mode, p_content_item, p_channel,
          format('publish:%s:%s:%s', p_content_item, p_channel, p_mode))
  ON CONFLICT (tenant_id, dedupe_key) DO UPDATE
    SET updated_at = now()          -- a no-op update so RETURNING has a row
  RETURNING id INTO v_job;

  RETURN v_job;
END $$;

-- ============================================================ claim (worker)
-- ⛔ TAKES NO TENANT ARGUMENT. Same law as app.purge_current_tenant(): a
-- function that crosses tenants must never accept the tenant from its caller,
-- or the caller chooses the victim. The worker learns which tenant it is
-- working for by being TOLD, in the returned row, and the function sets the
-- GUC itself so the worker cannot skip that step.
--
-- FOR UPDATE SKIP LOCKED is what makes N workers safe: each takes a different
-- row instead of queueing behind the same one.
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
    SELECT id FROM jobs
     WHERE status = 'queued' AND run_after <= now()
     ORDER BY run_after, created_at
     FOR UPDATE SKIP LOCKED
     LIMIT 1
  )
  RETURNING * INTO v_job;

  IF v_job.id IS NULL THEN
    RETURN NULL;
  END IF;

  -- Scope the session to the job's tenant. From here the worker sees exactly
  -- one customer's data through the ordinary policies, and it never chose
  -- which one.
  PERFORM set_config('app.current_tenant', v_job.tenant_id::text, true);

  UPDATE job_workers SET last_seen_at = now(), current_job = v_job.id
   WHERE worker_id = p_worker;

  RETURN v_job;
END $$;

-- ======================================================== heartbeat (worker)
-- Extends the lease of a job this worker actually holds. The WHERE clause is
-- the authorization: a worker cannot extend somebody else's lease, and cannot
-- resurrect one that already expired (that job may already have been reaped
-- and given to another worker — silently extending it would produce two
-- workers publishing the same item).
CREATE OR REPLACE FUNCTION app.heartbeat_job(
  p_job uuid, p_worker text, p_lease_seconds integer DEFAULT 300
) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, app AS $$
DECLARE v_ok boolean := false;
BEGIN
  UPDATE jobs SET
    lease_expires_at = now() + make_interval(secs => p_lease_seconds),
    updated_at = now()
   WHERE id = p_job AND claimed_by = p_worker AND status = 'running'
     AND lease_expires_at > now()
  RETURNING true INTO v_ok;

  UPDATE job_workers SET last_seen_at = now() WHERE worker_id = p_worker;
  RETURN COALESCE(v_ok, false);
END $$;

CREATE OR REPLACE FUNCTION app.worker_checkin(p_worker text, p_hostname text)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, app AS $$
BEGIN
  INSERT INTO job_workers(worker_id, hostname)
       VALUES (p_worker, p_hostname)
  ON CONFLICT (worker_id) DO UPDATE
    SET last_seen_at = now(), hostname = EXCLUDED.hostname;
END $$;

-- ================================================== finish the job (worker)
-- ⛔ THE ONLY PATH TO 'published', AND IT REFUSES MORE THAN IT ACCEPTS.
--
-- A live job must present a real destination URL: publishing that cannot say
-- where it published is indistinguishable from not publishing, and this
-- product's entire pitch is that what the customer sees on screen is true.
-- A dry run must NOT touch the content item at all — it reports what it would
-- have done and leaves the item 'approved'. A rehearsal that marks something
-- published is precisely the lie the mode column exists to prevent.
CREATE OR REPLACE FUNCTION app.complete_publish(
  p_job uuid, p_worker text, p_url text DEFAULT NULL, p_note text DEFAULT NULL
) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, app AS $$
DECLARE v_job jobs;
BEGIN
  SELECT * INTO v_job FROM jobs
   WHERE id = p_job AND claimed_by = p_worker AND status = 'running'
     AND lease_expires_at > now()
   FOR UPDATE;

  IF v_job.id IS NULL THEN
    RAISE EXCEPTION 'no running job % held by % with a live lease', p_job, p_worker;
  END IF;

  IF v_job.mode = 'live' AND COALESCE(p_url, '') = '' THEN
    RAISE EXCEPTION 'a live publish must report the URL it published to';
  END IF;

  PERFORM set_config('app.current_tenant', v_job.tenant_id::text, true);

  IF v_job.mode = 'live' THEN
    -- The guard trigger refuses 'published' unless this is set, and this is
    -- the only place in the schema that sets it.
    PERFORM set_config('app.publishing', 'on', true);
    UPDATE content_items SET
      status = 'published', published_url = p_url,
      published_at = now(), updated_at = now()
     WHERE id = v_job.content_item_id;
    PERFORM set_config('app.publishing', '', true);

    INSERT INTO events(tenant_id, name, actor_uid)
    VALUES (v_job.tenant_id, 'content_published', concat('worker:', p_worker));
  ELSE
    INSERT INTO events(tenant_id, name, actor_uid)
    VALUES (v_job.tenant_id, 'content_publish_rehearsed', concat('worker:', p_worker));
  END IF;

  UPDATE jobs SET
    status = 'succeeded', finished_at = now(), updated_at = now(),
    lease_expires_at = NULL,
    result_note = COALESCE(p_note,
      CASE WHEN v_job.mode = 'live'
           THEN 'published' ELSE 'dry run: not sent to any platform' END)
   WHERE id = p_job;

  RETURN true;
END $$;

-- ========================================================== fail it (worker)
-- Retry with exponential backoff until max_attempts, then DEAD — never a
-- silent forever-loop. A dead job is a thing an operator must look at, which
-- is why it has its own status rather than sitting in 'failed' being retried
-- forever by a scheduler that has stopped counting.
CREATE OR REPLACE FUNCTION app.fail_job(
  p_job uuid, p_worker text, p_error text
) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, app AS $$
DECLARE v_job jobs; v_next text;
BEGIN
  SELECT * INTO v_job FROM jobs
   WHERE id = p_job AND claimed_by = p_worker AND status = 'running'
   FOR UPDATE;

  IF v_job.id IS NULL THEN
    RAISE EXCEPTION 'no running job % held by %', p_job, p_worker;
  END IF;

  IF v_job.attempts >= v_job.max_attempts THEN
    v_next := 'dead';
    UPDATE jobs SET status = 'dead', last_error = p_error, finished_at = now(),
                    lease_expires_at = NULL, updated_at = now()
     WHERE id = p_job;
    -- The content item says so too, so the customer is not left staring at an
    -- item that claims to be on its way when nothing is coming.
    PERFORM set_config('app.current_tenant', v_job.tenant_id::text, true);
    UPDATE content_items SET status = 'failed', updated_at = now()
     WHERE id = v_job.content_item_id;
  ELSE
    v_next := 'queued';
    UPDATE jobs SET status = 'queued', last_error = p_error,
                    claimed_by = NULL, lease_expires_at = NULL,
                    run_after = now() + make_interval(
                      secs => least(3600, power(2, v_job.attempts)::int * 30)),
                    updated_at = now()
     WHERE id = p_job;
  END IF;

  RETURN v_next;
END $$;

-- ===================================================== reap expired leases
-- The counterpart to leasing. Takes no arguments and names no tenant: it
-- restores every job whose holder stopped reporting, wherever it lives.
CREATE OR REPLACE FUNCTION app.reap_expired_leases()
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, app AS $$
DECLARE v_count integer;
BEGIN
  UPDATE jobs SET
    status = 'queued', claimed_by = NULL, lease_expires_at = NULL,
    last_error = 'lease expired: worker stopped reporting',
    run_after = now(), updated_at = now()
   WHERE status = 'running' AND lease_expires_at IS NOT NULL
     AND lease_expires_at < now();
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END $$;

-- ========================================================= ownership + grants
-- See the header: these run as app_worker so that the policies written above
-- are the ones that apply, in dev and on Cloud SQL alike.
ALTER FUNCTION app.claim_next_job(text, integer)            OWNER TO app_worker;
ALTER FUNCTION app.heartbeat_job(uuid, text, integer)       OWNER TO app_worker;
ALTER FUNCTION app.worker_checkin(text, text)               OWNER TO app_worker;
ALTER FUNCTION app.complete_publish(uuid, text, text, text) OWNER TO app_worker;
ALTER FUNCTION app.fail_job(uuid, text, text)               OWNER TO app_worker;
ALTER FUNCTION app.reap_expired_leases()                    OWNER TO app_worker;

REVOKE ALL ON FUNCTION app.claim_next_job(text, integer)            FROM PUBLIC;
REVOKE ALL ON FUNCTION app.heartbeat_job(uuid, text, integer)       FROM PUBLIC;
REVOKE ALL ON FUNCTION app.worker_checkin(text, text)               FROM PUBLIC;
REVOKE ALL ON FUNCTION app.complete_publish(uuid, text, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.fail_job(uuid, text, text)               FROM PUBLIC;
REVOKE ALL ON FUNCTION app.reap_expired_leases()                    FROM PUBLIC;

-- The web tier gets the queue for its own tenant, and enqueue. It does NOT get
-- claim/complete/fail: a request handler must not be able to mark work done.
--
-- The INSERT column list is the write surface, and what it LEAVES OUT is the
-- point: no `status`, no `claimed_by`, no `attempts`, no `result_note`. So the
-- web tier can ask for work to happen and cannot claim it already did — the
-- same reasoning that keeps `is_sample` out of app_user's UPDATE list on
-- content_items. UPDATE is limited to updated_at because enqueue_publish's
-- ON CONFLICT touches it to make a duplicate approval a no-op.
--
-- ⛔ Note what this deliberately does NOT enforce: a direct INSERT here skips
-- enqueue_publish's "only approved content" check. That check is not the last
-- line of defence and must not be treated as one — content can be rejected in
-- the seconds between enqueue and claim, so the publish handler RE-READS the
-- item's status after claiming and refuses anything that is no longer
-- approved. The schema guarantees tenancy; freshness is the worker's job.
GRANT SELECT ON jobs TO app_user;
GRANT INSERT (tenant_id, kind, mode, content_item_id, channel_id, dedupe_key)
  ON jobs TO app_user;
GRANT UPDATE (updated_at) ON jobs TO app_user;
GRANT EXECUTE ON FUNCTION app.enqueue_publish(uuid, uuid, text) TO app_user;

-- The worker gets the queue and the vetted functions. Note what is missing:
-- no INSERT on content_items, no DELETE anywhere, and UPDATE on content_items
-- limited to the four columns publishing actually writes — so a compromised
-- worker cannot rewrite a customer's copy, only report where it went.
GRANT SELECT, UPDATE ON jobs TO app_worker;
GRANT SELECT, INSERT, UPDATE ON job_workers TO app_worker;
GRANT SELECT ON content_items, tenant_channels, tenant_credentials TO app_worker;
GRANT UPDATE (status, published_url, published_at, updated_at)
  ON content_items TO app_worker;
GRANT UPDATE (status, last_error) ON tenant_channels TO app_worker;
GRANT INSERT ON events TO app_worker;
GRANT EXECUTE ON FUNCTION
  app.current_tenant(),
  app.claim_next_job(text, integer),
  app.heartbeat_job(uuid, text, integer),
  app.worker_checkin(text, text),
  app.complete_publish(uuid, text, text, text),
  app.fail_job(uuid, text, text),
  app.reap_expired_leases()
TO app_worker;

COMMENT ON FUNCTION app.claim_next_job(text, integer) IS
  'Leases the oldest eligible job across all tenants. Takes NO tenant '
  'argument (same law as purge_current_tenant) and sets app.current_tenant '
  'from the claimed row, so the worker never chooses whose data it touches.';

COMMENT ON FUNCTION app.complete_publish(uuid, text, text, text) IS
  'The only path to content_items.status=published, and it refuses a live '
  'completion with no URL. A dry run leaves the content item untouched.';

-- ========================================================= verify, don't assume
DO $$
DECLARE v_bad text;
BEGIN
  SELECT string_agg(c.relname, ', ' ORDER BY c.relname) INTO v_bad
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND c.relname IN ('jobs','job_workers')
     AND NOT (c.relrowsecurity AND c.relforcerowsecurity);
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION '0005: expected ENABLE + FORCE RLS, not set on: %', v_bad;
  END IF;

  -- The definers must be owned by app_worker or their policies do not apply.
  -- This is the check that would have caught the dev-works/prod-fails trap.
  SELECT string_agg(p.proname, ', ' ORDER BY p.proname) INTO v_bad
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    JOIN pg_roles r ON r.oid = p.proowner
   WHERE n.nspname = 'app'
     AND p.proname IN ('claim_next_job','heartbeat_job','worker_checkin',
                       'complete_publish','fail_job','reap_expired_leases')
     AND r.rolname <> 'app_worker';
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION '0005: job definers must be owned by app_worker, not: %', v_bad;
  END IF;
END $$;
