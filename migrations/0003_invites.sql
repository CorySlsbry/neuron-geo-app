-- 0003_invites — join-by-link team invites.
--
-- v1 is the SHAREABLE LINK, deliberately: Identity Platform's built-in mail
-- can only send its own OOB emails (verify / reset), so invite DELIVERY waits
-- for the mail provider (docs/NEEDS-CORY.md). The row still records the
-- invitee's email — it is the audit trail and the future To: line — but the
-- LINK is the credential: 256-bit token, stored only as a SHA-256 hash,
-- single-use, 7-day expiry.
--
-- ⛔ DIRECTORY TABLE (the 0041 law — see migrations/PROVENANCE.md): the
-- redemption path resolves an unauthenticated fact (a token) to a tenant_id
-- via SECURITY DEFINER, and the redeeming user is NOT yet a member — so this
-- table is ENABLE-only RLS, never FORCE. The tenant policy scopes the
-- create/list/revoke surfaces, which run as app_user under a tenant GUC.

CREATE TABLE invites (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  -- Recorded for the roster ("who did we invite?") and for future email
  -- delivery. NOT enforced at redemption: the link is the credential, like
  -- every join-link product — the UI says so out loud.
  email      text NOT NULL,
  -- Owner is never granted by link; ownership moves person-to-person.
  role       text NOT NULL CHECK (role IN ('admin','staff','bookkeeper','viewer')),
  -- SHA-256 hex of the raw token. The raw token exists only in the creation
  -- response and the copied link — a database read leaks nothing redeemable.
  token_hash text NOT NULL UNIQUE,
  invited_by text NOT NULL,
  expires_at timestamptz NOT NULL DEFAULT now() + interval '7 days',
  accepted_at timestamptz,
  accepted_by text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX invites_tenant_idx ON invites(tenant_id);

ALTER TABLE invites ENABLE ROW LEVEL SECURITY;
CREATE POLICY invites_tenant_isolation ON invites
  USING      (tenant_id = app.current_tenant())
  WITH CHECK (tenant_id = app.current_tenant());

-- Full SELECT on purpose, token_hash included: the hash is SHA-256 of a
-- 256-bit random token, so reading it redeems nothing (redemption takes the
-- RAW token, which is never stored) — and the account export's coverage law
-- (test/db/0004) requires every tenant table to be plainly readable by
-- app_user so "download everything" stays true. The API simply never selects
-- the column.
GRANT SELECT ON invites TO app_user;
GRANT INSERT (tenant_id, email, role, token_hash, invited_by, expires_at)
  ON invites TO app_user;
-- Revoke = DELETE. No UPDATE grant: acceptance happens only inside the
-- definer function below.
GRANT DELETE ON invites TO app_user;

COMMENT ON TABLE invites IS
  'Join-by-link team invites. DIRECTORY TABLE — ENABLE-only RLS, never '
  'FORCE: app.redeem_invite() resolves a token to a tenant for a user who '
  'is not yet a member. Raw tokens are never stored (SHA-256 only).';

-- Redeem: token hash + the authenticated uid -> membership, atomically.
-- SECURITY DEFINER because the redeeming user has no membership to authorize
-- against — the valid, unspent, unexpired token IS the authorization. Returns
-- the joined tenant id, or NULL for invalid/spent/expired (one
-- indistinguishable answer: a probing caller learns nothing about which).
--
-- The seat cap is enforced by the memberships BEFORE INSERT trigger
-- (app.enforce_seat_cap, migration 0002) — the same single enforcement point
-- as every other way a person is added; a full plan raises check_violation
-- ('seat_limit_reached…'), which the API maps to 402. FOR UPDATE on the
-- invite row makes double-redemption a race two callers cannot win twice.
CREATE OR REPLACE FUNCTION app.redeem_invite(p_token_hash text, p_uid text)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, app
AS $$
DECLARE
  v_invite record;
BEGIN
  IF p_uid IS NULL OR p_uid = '' THEN
    RAISE EXCEPTION 'uid required';
  END IF;

  SELECT id, tenant_id, role INTO v_invite
    FROM invites
   WHERE token_hash = p_token_hash
     AND accepted_at IS NULL
     AND expires_at > now()
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  -- Already a member (e.g. invited twice): spend the invite, succeed quietly.
  IF NOT EXISTS (SELECT 1 FROM memberships
                  WHERE tenant_id = v_invite.tenant_id AND user_id = p_uid) THEN
    INSERT INTO memberships (tenant_id, user_id, role)
    VALUES (v_invite.tenant_id, p_uid, v_invite.role);
  END IF;

  UPDATE invites SET accepted_at = now(), accepted_by = p_uid
   WHERE id = v_invite.id;
  RETURN v_invite.tenant_id;
END $$;

REVOKE ALL ON FUNCTION app.redeem_invite(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.redeem_invite(text, text) TO app_user;

COMMENT ON FUNCTION app.redeem_invite(text, text) IS
  'Redeem an invite token (hash) for the authenticated uid. Single-use '
  '(FOR UPDATE + accepted_at), 7-day expiry, seat cap enforced by the '
  'memberships insert trigger. NULL for invalid/spent/expired — one answer.';
