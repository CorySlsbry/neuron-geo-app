-- 0002_billing — the SaaS subscription plane, GEO plans.
--
-- Consolidated from the topbuilder-os lineage (see migrations/PROVENANCE.md):
-- old 0023 (subscriptions + billing_events + tenant resolution) + 0024
-- (billing_events RLS, fail-closed like everything else) + 0025 (seat-cap
-- trigger + webhook ordering clock) + 0035 (request idempotency keys) +
-- 0041 (subscriptions is a DIRECTORY table — never FORCE) + 0059's
-- plan⇄seat-cap CHECK shape, re-cut for the GEO plans.
--
-- Two flat plans (Cory 2026-08-14): Start $89/mo and Growth $199/mo, Stripe
-- lookup keys geo_start_89 / geo_growth_199. A tier buys CAPACITY — seats and
-- monthly usage allowances (posts, reels, AI budget) — never features.

CREATE TABLE subscriptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  plan text NOT NULL DEFAULT 'start'
    CONSTRAINT subscriptions_plan_check CHECK (plan IN ('start', 'growth')),
  seat_cap int NOT NULL DEFAULT 2 CHECK (seat_cap > 0),
  status text NOT NULL DEFAULT 'trialing'
    CHECK (status IN ('trialing', 'active', 'past_due', 'canceled')),
  -- Monthly usage allowances — the usage guard's inputs, denormalized onto
  -- the row so the guard never needs the TS plan catalog at read time.
  -- ⛔ Quantities are P0 placeholders pending Cory's pricing pass; the
  -- COLUMNS and their invariants are the contract.
  included_posts int NOT NULL DEFAULT 8 CHECK (included_posts >= 0),
  included_reels int NOT NULL DEFAULT 8 CHECK (included_reels >= 0),
  ai_budget_usd numeric(8,2) NOT NULL DEFAULT 15.00 CHECK (ai_budget_usd >= 0),
  stripe_customer_id text,
  stripe_subscription_id text,
  current_period_end timestamptz,
  trial_ends_at timestamptz,
  cancel_at_period_end boolean NOT NULL DEFAULT false,
  -- `created` timestamp of the newest Stripe event applied to this row.
  -- Stripe does NOT guarantee webhook ordering: an OLDER
  -- customer.subscription.updated arriving after a NEWER one would roll a
  -- tenant back to a stale plan. Event-id dedupe cannot catch that — these
  -- are two different, valid events. The clock can.
  last_event_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id),
  UNIQUE (stripe_customer_id),
  UNIQUE (stripe_subscription_id),
  -- The plan is the source of truth for the cap; nothing else may drift it.
  -- Without this a row could sit on Start with ten seats and quietly sell
  -- eight seats for nothing (the parent's 0059 lesson).
  CONSTRAINT subscriptions_seat_cap_matches_plan CHECK (
    (plan = 'start'  AND seat_cap = 2)  OR
    (plan = 'growth' AND seat_cap = 10)
  )
);

-- ⛔ DIRECTORY TABLE — ENABLE-only RLS, never FORCE (the 0041 law).
-- app.tenant_by_stripe_customer() resolves the tenant for a Stripe webhook
-- SECURITY DEFINER with no session; FORCE would make the policy bind the
-- owner too and the lookup would silently return nothing — a customer could
-- pay and never be upgraded, with no error anywhere.
ALTER TABLE subscriptions ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON subscriptions
  USING      (tenant_id = app.current_tenant())
  WITH CHECK (tenant_id = app.current_tenant());
GRANT SELECT, INSERT, UPDATE ON subscriptions TO app_user;

COMMENT ON TABLE subscriptions IS
  'DIRECTORY TABLE — ENABLE-only RLS, never FORCE. '
  'app.tenant_by_stripe_customer() resolves the tenant for a Stripe webhook, '
  'whose payload tenant ids are deliberately not trusted. See PROVENANCE '
  '(parent migration 0041).';

-- Webhook idempotency: a replayed Stripe event is a no-op, forever.
-- Tenant-scoped and FORCE (the webhook handler resolves the tenant FIRST via
-- the definer lookup, then does all its work INSIDE that tenant's scope — so
-- RLS applies to the webhook exactly as it does to a user request, a stronger
-- guarantee than any "privileged pool"). SELECT for the replay check, INSERT
-- to record; no UPDATE, no DELETE — the event log is append-only, and the
-- account purge reaches it via app.purge_current_tenant().
CREATE TABLE billing_events (
  event_id text PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  type text NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE billing_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing_events FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON billing_events
  USING      (tenant_id = app.current_tenant())
  WITH CHECK (tenant_id = app.current_tenant());
GRANT SELECT, INSERT ON billing_events TO app_user;

-- Resolve a tenant from a Stripe customer id WITHOUT a session (the webhook
-- arrives with no user). SECURITY DEFINER, returns the tenant id or nothing.
-- A tenant id in the Stripe payload is never trusted, because it is never read.
CREATE OR REPLACE FUNCTION app.tenant_by_stripe_customer(p_customer text)
RETURNS uuid
LANGUAGE sql SECURITY DEFINER STABLE
SET search_path = public, app
AS $$ SELECT tenant_id FROM subscriptions WHERE stripe_customer_id = p_customer $$;
REVOKE ALL ON FUNCTION app.tenant_by_stripe_customer(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.tenant_by_stripe_customer(text) TO app_user;

-- ------------------------------------------------------------- seat cap
-- The seat cap must hold under CONCURRENCY, not just under polite sequential
-- use. The app-layer check produces the friendly message; this is the
-- backstop that makes the guarantee true: two owners inviting at the same
-- moment serialize on the subscription row lock, and the loser gets a
-- check_violation instead of an eleventh seat on a ten-seat plan.
CREATE OR REPLACE FUNCTION app.enforce_seat_cap() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, app AS $$
DECLARE
  v_cap   int;
  v_used  int;
BEGIN
  -- The bookkeeper seat is free and never counts against the cap.
  IF NEW.role = 'bookkeeper' THEN
    RETURN NEW;
  END IF;

  -- Lock the tenant's subscription row so concurrent inserts serialise here.
  -- No subscription row yet (a tenant mid-signup, or a fixture) means there is
  -- no cap to enforce — the trial row is created moments later by signup().
  SELECT seat_cap INTO v_cap
    FROM subscriptions
   WHERE tenant_id = NEW.tenant_id
   FOR UPDATE;

  IF v_cap IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT count(*) INTO v_used
    FROM memberships
   WHERE tenant_id = NEW.tenant_id
     AND role <> 'bookkeeper';

  IF v_used >= v_cap THEN
    RAISE EXCEPTION 'seat_limit_reached: % of % seats already used', v_used, v_cap
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END $$;

-- BEFORE INSERT only: an existing member changing role is handled by the app,
-- and we never want a role edit to lock someone out of their own tenant.
CREATE TRIGGER memberships_seat_cap
  BEFORE INSERT ON memberships
  FOR EACH ROW EXECUTE FUNCTION app.enforce_seat_cap();

-- ------------------------------------------------ request-level idempotency
-- Claim -> work -> record, per (tenant, key, route) — Stripe's protocol,
-- because it is the one that works. A completed key replays its stored
-- response verbatim; an in-progress key 409s; a failed handler DELETES the
-- key so an honest retry can proceed. request_hash catches key REUSE with a
-- different body (a client bug) and 422s instead of hiding it.
CREATE TABLE idempotency_keys (
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  -- Client-supplied. Scoped per tenant so keys can never collide across
  -- tenants, and a key from one tenant can never surface another's response.
  key             text NOT NULL,
  -- The route that claimed it. The same key on a different route is a
  -- different operation, not a replay.
  route           text NOT NULL,
  -- SHA-256 of the request body, to catch key reuse with changed content.
  request_hash    text NOT NULL,
  status          text NOT NULL DEFAULT 'in_progress'
    CHECK (status IN ('in_progress', 'completed')),
  -- The stored response, replayed verbatim on a duplicate.
  response_status int,
  response_body   jsonb,
  -- Who claimed it, for support.
  claimed_by      text NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  completed_at    timestamptz,
  PRIMARY KEY (tenant_id, key, route)
);

ALTER TABLE idempotency_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE idempotency_keys FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON idempotency_keys
  USING      (tenant_id = app.current_tenant())
  WITH CHECK (tenant_id = app.current_tenant());
GRANT SELECT, INSERT, UPDATE, DELETE ON idempotency_keys TO app_user;

-- Reaping old keys. 24h is comfortably longer than any client will retry.
-- Deliberately NOT a unique-index-with-expiry: an expired key that gets
-- REUSED must be treated as a fresh request, not a replay of a response the
-- caller has long forgotten.
CREATE INDEX idempotency_keys_reap_idx ON idempotency_keys (created_at);

COMMENT ON TABLE idempotency_keys IS
  'Request-level idempotency. Claim -> work -> record, per (tenant, key, '
  'route). A completed key replays its stored response verbatim; an '
  'in-progress key 409s; a failed handler DELETES the key so an honest retry '
  'can proceed.';

-- ------------------------------------------------------------ the guard
-- Refuse to finish if the end state is not what this chain claims (the
-- verify-not-assume pattern from the parent's 0041): directory tables must be
-- ENABLE + policy + never FORCE, or the resolution functions go blind.
DO $$
DECLARE
  r record;
  v_bad text := '';
BEGIN
  FOR r IN
    SELECT c.relname, c.relrowsecurity AS enabled, c.relforcerowsecurity AS forced
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public'
       AND c.relname IN ('tenants','memberships','user_session_epochs','subscriptions')
  LOOP
    IF NOT r.enabled THEN
      v_bad := v_bad || format('%s has RLS disabled entirely; ', r.relname);
    END IF;
    IF r.forced THEN
      v_bad := v_bad || format('%s is FORCE (blinds the resolution functions); ', r.relname);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_policies p
                    WHERE p.schemaname = 'public' AND p.tablename = r.relname) THEN
      v_bad := v_bad || format('%s has NO policy; ', r.relname);
    END IF;
  END LOOP;

  IF v_bad <> '' THEN
    RAISE EXCEPTION 'directory tables in a bad state: %', v_bad;
  END IF;
  RAISE NOTICE 'directory tables verified: RLS enabled, FORCE off, policies intact';
END $$;
