-- 0001_security_spine — three-level isolation: tenant + department + role.
--
-- Consolidated from the topbuilder-os lineage (see migrations/PROVENANCE.md):
-- old 0001 (spine) + 0021/0036 (team management grants + dynamic departments)
-- + 0031 (session revocation) + 0033 (purge fixed-point, final form) +
-- 0042/0045 (tenant timezone + the UPDATE policy that makes it real).
--
-- Runs as the migration superuser/owner. Tables are owned by that role; the
-- app connects as the NON-superuser `app_user` (no BYPASSRLS) so it can never
-- bypass RLS. Directory tables (tenants, memberships, user_session_epochs)
-- are ENABLE-only NO FORCE so tenancy resolves BEFORE a tenant GUC exists;
-- sensitive tenant tables are ENABLE + FORCE, fail-closed (unset scope =>
-- zero rows).
--
-- ⛔ THE DIRECTORY-TABLE LAW (paid for three times in the parent codebase —
-- its migration 0041): a table on the path from an unauthenticated fact (a
-- slug, a token, a Stripe customer id) to a tenant_id is a DIRECTORY table.
-- ENABLE, policy, GRANT — never FORCE. SECURITY DEFINER runs as the owner,
-- FORCE is precisely the setting that binds the owner too, and on Cloud SQL
-- `postgres` is not a true superuser, so a FORCE-scoped resolution lookup
-- silently returns NULL and the feature dies with no error anywhere.

-- ========================================================= helper schema + GUCs
CREATE SCHEMA IF NOT EXISTS app;

-- Per-request principal (Identity Platform uid). Set by the server from the
-- verified session — NEVER from a client-supplied claim.
CREATE OR REPLACE FUNCTION app.current_uid() RETURNS text
  LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('app.current_uid', true), '')
$$;

-- Active tenant. NULL when unset => policies compare against NULL => zero rows.
CREATE OR REPLACE FUNCTION app.current_tenant() RETURNS uuid
  LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('app.current_tenant', true), '')::uuid
$$;

-- Department keys the principal may see in the active tenant (CSV -> array).
-- The department-wall MECHANISM: nothing seeds departments in the GEO shape,
-- but any tenant can create walls and any future table/policy can gate on
-- app.can_see_department('<key>') with no further plumbing.
CREATE OR REPLACE FUNCTION app.current_departments() RETURNS text[]
  LANGUAGE sql STABLE AS $$
  SELECT string_to_array(
           NULLIF(current_setting('app.current_departments', true), ''), ','
         )
$$;

-- True iff the principal may see rows tagged to department key `dept`.
CREATE OR REPLACE FUNCTION app.can_see_department(dept text) RETURNS boolean
  LANGUAGE sql STABLE AS $$
  SELECT dept = ANY (COALESCE(app.current_departments(), ARRAY[]::text[]))
$$;

GRANT USAGE ON SCHEMA app TO app_user;

-- ========================================================= directory tables
-- ENABLE-only, NO FORCE.
CREATE TABLE tenants (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name       text NOT NULL,
  slug       text NOT NULL UNIQUE,
  -- IANA zone the tenant schedules/reports in. Lives on tenants (ENABLE-only
  -- RLS) so a definer lookup can read it before any session exists.
  -- Denver default (Cory's home zone), not the parent's Phoenix: tenants set
  -- their own in settings; the default only decides a brand-new tenant's
  -- first report boundary.
  timezone   text NOT NULL DEFAULT 'America/Denver',
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;

CREATE TABLE memberships (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id    text NOT NULL,                         -- Identity Platform uid
  role       text NOT NULL
             CHECK (role IN ('owner','admin','staff','bookkeeper','viewer')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, user_id)
);
CREATE INDEX memberships_user_idx   ON memberships(user_id);
CREATE INDEX memberships_tenant_idx ON memberships(tenant_id);
ALTER TABLE memberships ENABLE ROW LEVEL SECURITY;

-- You can always read your OWN memberships (resolves tenancy pre-GUC)...
CREATE POLICY memberships_self_read ON memberships FOR SELECT
  USING (user_id = app.current_uid());
-- ...and co-members within your active tenant (team management screens).
CREATE POLICY memberships_tenant_read ON memberships FOR SELECT
  USING (tenant_id = app.current_tenant());
-- Team management writes (role changes) run as app_user under tenant RLS;
-- the API additionally requires owner/admin + aal2.
CREATE POLICY memberships_tenant_write ON memberships
  FOR UPDATE
  USING (tenant_id = app.current_tenant())
  WITH CHECK (tenant_id = app.current_tenant());

-- You see the tenants you belong to.
CREATE POLICY tenants_member_read ON tenants FOR SELECT
  USING (id IN (SELECT m.tenant_id FROM memberships m
                WHERE m.user_id = app.current_uid()));

-- A tenant may update its OWN row. Paired with a COLUMN-level grant that
-- limits app_user to `timezone` — the policy scopes WHICH row, the grant
-- scopes WHICH column. Without this policy the update silently affected zero
-- rows and reported success (parent migration 0045: a grant is permission to
-- attempt, not permission to succeed — on an RLS table you need both, and
-- the failure is silent in each direction).
CREATE POLICY tenants_member_update ON tenants
  FOR UPDATE
  USING (id = app.current_tenant())
  WITH CHECK (id = app.current_tenant());

-- A CHECK cannot consult pg_timezone_names, and an invalid zone must not be
-- storable — `now() AT TIME ZONE <bad>` throws at READ time, which would turn
-- a typo in settings into a 500. Validate on write instead.
CREATE OR REPLACE FUNCTION app.assert_valid_timezone() RETURNS trigger
  LANGUAGE plpgsql AS $fn$
BEGIN
  IF NEW.timezone IS NULL OR NEW.timezone = '' THEN
    RAISE EXCEPTION 'timezone required';
  END IF;
  PERFORM now() AT TIME ZONE NEW.timezone;
  RETURN NEW;
END $fn$;

CREATE TRIGGER tenants_valid_timezone
  BEFORE INSERT OR UPDATE OF timezone ON tenants
  FOR EACH ROW EXECUTE FUNCTION app.assert_valid_timezone();

-- ------------------------------------------------ server-side session revocation
-- The session cookie is stateless (iron-session): it proves who you are by
-- decrypting, and nothing consults the server about whether it should still
-- be honoured. The fix is one integer per user: the cookie carries the epoch
-- it was minted at; a request is honoured only while the two still agree.
-- Bumping the row invalidates every session that user holds, everywhere,
-- immediately (logout, offboarding, incident response).
--
-- A directory table, like tenants/memberships: it must be readable BEFORE a
-- tenant scope exists, because it gates authentication itself. ENABLE without
-- FORCE; the policy pins every row to the requesting principal.
CREATE TABLE user_session_epochs (
  user_id    text PRIMARY KEY,
  epoch      integer NOT NULL DEFAULT 1,
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE user_session_epochs ENABLE ROW LEVEL SECURITY;

CREATE POLICY own_epoch ON user_session_epochs
  USING (user_id = app.current_uid())
  WITH CHECK (user_id = app.current_uid());

COMMENT ON TABLE user_session_epochs IS
  'Server-side session revocation. A session cookie carries the epoch it was '
  'minted at; requireAuth honours it only while they match. Bump to sign a '
  'user out of every device at once.';

-- ========================================================= tenant tables (FORCE)
CREATE TABLE departments (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  key        text NOT NULL,      -- owner-defined slugs; nothing is seeded
  name       text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, key)
);
ALTER TABLE departments ENABLE ROW LEVEL SECURITY;
ALTER TABLE departments FORCE  ROW LEVEL SECURITY;
CREATE POLICY departments_tenant_isolation ON departments
  USING      (tenant_id = app.current_tenant())
  WITH CHECK (tenant_id = app.current_tenant());

CREATE TABLE member_department_access (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  membership_id uuid NOT NULL REFERENCES memberships(id) ON DELETE CASCADE,
  department_id uuid NOT NULL REFERENCES departments(id) ON DELETE CASCADE,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (membership_id, department_id)
);
ALTER TABLE member_department_access ENABLE ROW LEVEL SECURITY;
ALTER TABLE member_department_access FORCE  ROW LEVEL SECURITY;
CREATE POLICY mda_tenant_isolation ON member_department_access
  USING      (tenant_id = app.current_tenant())
  WITH CHECK (tenant_id = app.current_tenant());

-- Product analytics / audit events (tenant-scoped, append-only from the app).
CREATE TABLE events (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name         text NOT NULL,
  subject_type text,
  subject_id   uuid,
  actor_uid    text,
  occurred_at  timestamptz NOT NULL DEFAULT now(),
  payload      jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX events_tenant_name_idx ON events(tenant_id, name, occurred_at);
ALTER TABLE events ENABLE ROW LEVEL SECURITY;
ALTER TABLE events FORCE  ROW LEVEL SECURITY;
CREATE POLICY events_tenant_isolation ON events
  USING      (tenant_id = app.current_tenant())
  WITH CHECK (tenant_id = app.current_tenant());

-- ========================================================= signup bootstrap
-- Creates a tenant + its owner membership atomically — and NOTHING else.
-- ⛔ THE GEO PROVISIONING SHAPE: no chart of accounts, no seeded departments,
-- no domain rows of any kind. The 30-day trial subscription row is inserted
-- by the signup code path right after this returns (billing lives in 0002).
--
-- SECURITY DEFINER because at signup there is no prior membership to
-- authorize against. The ONLY way app_user creates a tenant. Sets the tenant
-- GUC before touching FORCE tables so it works even where the owner role is
-- not a true superuser (Cloud SQL).
CREATE OR REPLACE FUNCTION app.provision_tenant(
  p_name text, p_slug text, p_owner_uid text
) RETURNS uuid
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_tenant uuid;
BEGIN
  IF p_owner_uid IS NULL OR p_owner_uid = '' THEN
    RAISE EXCEPTION 'owner uid required';
  END IF;
  INSERT INTO tenants(name, slug) VALUES (p_name, p_slug) RETURNING id INTO v_tenant;
  INSERT INTO memberships(tenant_id, user_id, role)
    VALUES (v_tenant, p_owner_uid, 'owner');
  PERFORM set_config('app.current_tenant', v_tenant::text, true);
  INSERT INTO events(tenant_id, name, actor_uid)
    VALUES (v_tenant, 'tenant_provisioned', p_owner_uid);
  RETURN v_tenant;
END
$$;

-- ==================================================== self-service tenant delete
-- "Delete my account", done safely — the final fixed-point form (parent 0033).
--
-- SECURITY DEFINER, but it takes NO tenant argument: it purges ONLY the
-- tenant already in the session GUC, so a caller can never name someone
-- else's tenant and an unscoped session deletes nothing. It sweeps every
-- table carrying a tenant_id column to a FIXED POINT (correct for an FK graph
-- of any depth, including ones added years from now), then VERIFIES nothing
-- remains before dropping the tenant row — a purge that half-succeeds is
-- worse than one that fails, because the user has been told their data is
-- gone. The app.ledger_purge GUC is the hatch any future append-only-table
-- trigger must honour so a deliberate purge can remove immutable rows.
CREATE OR REPLACE FUNCTION app.purge_current_tenant()
RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, app
AS $$
DECLARE
  v_tenant    uuid := NULLIF(current_setting('app.current_tenant', true), '')::uuid;
  v_table     text;
  v_deleted   bigint := 0;
  v_count     bigint;
  v_progress  boolean;
  v_rounds    int := 0;
  v_remaining text;
BEGIN
  IF v_tenant IS NULL THEN
    RAISE EXCEPTION 'no tenant in scope — refusing to purge';
  END IF;

  PERFORM set_config('app.ledger_purge', 'on', true);

  LOOP
    v_progress := false;
    v_rounds := v_rounds + 1;

    FOR v_table IN
      SELECT c.relname
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = 'tenant_id'
       WHERE n.nspname = 'public' AND c.relkind = 'r'
         AND a.attnum > 0 AND NOT a.attisdropped
       ORDER BY c.relname
    LOOP
      -- A sub-block per table: an FK violation rolls back only this DELETE,
      -- leaving earlier progress in this round intact.
      BEGIN
        EXECUTE format('DELETE FROM %I WHERE tenant_id = $1', v_table) USING v_tenant;
        GET DIAGNOSTICS v_count = ROW_COUNT;
        IF v_count > 0 THEN
          v_deleted := v_deleted + v_count;
          v_progress := true;
        END IF;
      EXCEPTION WHEN foreign_key_violation THEN
        NULL; -- its children are still present; a later round will get it
      END;
    END LOOP;

    -- A round that deleted nothing means either everything is gone, or what
    -- remains is a cycle nothing can break. Either way, stop sweeping.
    EXIT WHEN NOT v_progress;

    IF v_rounds > 50 THEN
      RAISE EXCEPTION 'purge did not converge after % rounds', v_rounds;
    END IF;
  END LOOP;

  -- VERIFY. Never report success on a partial delete.
  FOR v_table IN
    SELECT c.relname
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = 'tenant_id'
     WHERE n.nspname = 'public' AND c.relkind = 'r'
       AND a.attnum > 0 AND NOT a.attisdropped
     ORDER BY c.relname
  LOOP
    EXECUTE format('SELECT count(*) FROM %I WHERE tenant_id = $1', v_table)
      INTO v_count USING v_tenant;
    IF v_count > 0 THEN
      v_remaining := concat_ws(', ', v_remaining, format('%s(%s)', v_table, v_count));
    END IF;
  END LOOP;

  IF v_remaining IS NOT NULL THEN
    RAISE EXCEPTION 'purge incomplete — rows remain in: %', v_remaining;
  END IF;

  DELETE FROM tenants WHERE id = v_tenant;
  RETURN v_deleted;
END $$;

REVOKE ALL ON FUNCTION app.purge_current_tenant() FROM PUBLIC;

COMMENT ON FUNCTION app.purge_current_tenant() IS
  'Self-service tenant delete. Sweeps to a fixed point (any FK depth), then '
  'VERIFIES nothing remains before dropping the tenant row. Takes no tenant '
  'argument — reads app.current_tenant — so it cannot be aimed elsewhere.';

-- ========================================================= grants (app_user)
-- Read the directory + tenant tables (RLS-scoped); emit events; manage the
-- team and its walls (role-gated at the API); call the vetted functions.
GRANT SELECT ON tenants, memberships, departments, member_department_access, events TO app_user;
GRANT UPDATE (timezone) ON tenants TO app_user;
GRANT UPDATE ON memberships TO app_user;
GRANT INSERT, UPDATE, DELETE ON departments TO app_user;
GRANT INSERT, DELETE ON member_department_access TO app_user;
GRANT INSERT ON events TO app_user;
GRANT SELECT, INSERT, UPDATE ON user_session_epochs TO app_user;
GRANT EXECUTE ON FUNCTION
  app.current_uid(),
  app.current_tenant(),
  app.current_departments(),
  app.can_see_department(text),
  app.provision_tenant(text, text, text),
  app.purge_current_tenant()
TO app_user;
