-- 0006_abandon_job — the terminal failure that 0005 was missing.
--
-- `app.fail_job()` retries with backoff and dead-letters only at
-- max_attempts. That is right for a timeout or a 503, and wrong for every
-- failure that cannot possibly resolve itself: the customer rejected the item
-- after approving it, the channel was disconnected, the credential will not
-- decrypt, live publishing is switched off. Retrying those five times over
-- half an hour is not resilience, it is noise that buries the one line an
-- operator needed to read.
--
-- So: two exits, and the WORKER decides which, because only the worker knows
-- whether what it hit was weather or a wall.
CREATE OR REPLACE FUNCTION app.abandon_job(
  p_job uuid, p_worker text, p_reason text
) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, app AS $$
DECLARE v_job jobs;
BEGIN
  SELECT * INTO v_job FROM jobs
   WHERE id = p_job AND claimed_by = p_worker AND status = 'running'
   FOR UPDATE;

  IF v_job.id IS NULL THEN
    RAISE EXCEPTION 'no running job % held by %', p_job, p_worker;
  END IF;

  UPDATE jobs SET status = 'dead', last_error = p_reason,
                  finished_at = now(), lease_expires_at = NULL,
                  updated_at = now()
   WHERE id = p_job;

  -- ⛔ The content item is deliberately NOT marked 'failed' here, and that is
  -- the difference from fail_job's dead-letter branch.
  --
  -- Every reason a job is abandoned is a reason the item is fine and the
  -- SETUP is not: it was rejected (so 'rejected' is already the truth), the
  -- channel was disconnected, live publishing is off. Overwriting those with
  -- 'failed' would tell the customer their content is broken when the honest
  -- answer is that nothing was attempted. A dead job is an operator's problem;
  -- it should not put a red badge on a piece of writing that is perfectly good.
  PERFORM set_config('app.current_tenant', v_job.tenant_id::text, true);
  INSERT INTO events(tenant_id, name, actor_uid)
  VALUES (v_job.tenant_id, 'publish_abandoned', concat('worker:', p_worker));

  RETURN true;
END $$;

ALTER FUNCTION app.abandon_job(uuid, text, text) OWNER TO app_worker;
REVOKE ALL ON FUNCTION app.abandon_job(uuid, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.abandon_job(uuid, text, text) TO app_worker;

COMMENT ON FUNCTION app.abandon_job(uuid, text, text) IS
  'Terminal failure for conditions that cannot resolve on retry (item no '
  'longer approved, channel disconnected, credential unreadable, live '
  'publishing disabled). Dead-letters the job WITHOUT marking the content '
  'failed — the content is fine, the setup is not.';
