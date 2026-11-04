-- 0004_channels_content — connected channels, their credentials, and the
-- content queue that flows through them.
--
-- This is the first DOMAIN migration in the GEO chain (0000-0003 are the
-- spine). It exists to make one thing genuinely true: a customer can connect
-- a real social account through that network's own OAuth dialog, see content
-- waiting for their approval, approve it, and disconnect again — the exact
-- sequence Meta, TikTok and Google demand on video before they will approve a
-- platform integration.
--
-- ⛔ ALL THREE TABLES ARE TENANT-OWNED: ENABLE + FORCE RLS, fail-closed on a
-- NULL tenant GUC. None of them sits on the path from an unauthenticated fact
-- to a tenant_id, so none of them is a DIRECTORY table (the 0041 law — see
-- migrations/PROVENANCE.md). The OAuth callback resolves its tenant from the
-- SESSION, not from anything the provider hands back, which is precisely why
-- no directory carve-out is needed here.

-- ========================================================= the brand identity
-- Onboarding asks for two facts and stores them on the tenant rather than in
-- a new table: the brand's name (already `tenants.name`) and the domain we
-- are trying to get cited for. `onboarded_at` is what lets Home tell a brand
-- new workspace apart from one that has deliberately connected nothing yet —
-- without it, "no channels" and "never finished setup" look identical, and
-- the honest empty state cannot pick the right sentence.
ALTER TABLE tenants ADD COLUMN domain       text;
ALTER TABLE tenants ADD COLUMN onboarded_at timestamptz;

-- The column grant scopes WHICH columns, the existing `tenants_member_update`
-- policy scopes WHICH row. Both are required on an RLS table, and the failure
-- is silent in each direction (parent migration 0045 — see 0001's comment).
GRANT UPDATE (name, domain, onboarded_at) ON tenants TO app_user;

-- ========================================================= connected channels
CREATE TABLE tenant_channels (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  network    text NOT NULL
             CHECK (network IN ('youtube','instagram','facebook','tiktok','linkedin')),
  -- What the customer recognises: "@neuronhq", "Neuron HQ". Provider-supplied,
  -- so nullable — a provider that will not tell us the handle must not stop
  -- the connection from being recorded.
  handle     text,
  -- The provider's own id for the account. NOT NULL because it is half of the
  -- identity key below: reconnecting the SAME account must update the row we
  -- already have rather than growing a second one every time someone clicks
  -- Connect, while connecting a DIFFERENT account under the same network is
  -- a legitimate second row.
  account_id text NOT NULL,
  status     text NOT NULL DEFAULT 'connected'
             CHECK (status IN ('connected','disconnected','error')),
  -- Exactly what the customer granted, as the provider reported it back —
  -- not what we asked for. A provider may grant a subset, and a channel that
  -- claims a permission it does not hold fails later, in front of a customer.
  scopes     text[] NOT NULL DEFAULT '{}',
  connected_at    timestamptz,
  disconnected_at timestamptz,
  -- Why it went to 'error'. Surfaced on the channel card, because a channel
  -- that is silently broken is worse than one that says what happened.
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, network, account_id),
  -- The target of the composite foreign keys below. See the note on
  -- content_items — this is what makes cross-tenant stitching impossible
  -- structurally rather than by remembering a WHERE clause.
  UNIQUE (tenant_id, id)
);
CREATE INDEX tenant_channels_tenant_idx ON tenant_channels(tenant_id, network);

ALTER TABLE tenant_channels ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_channels FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant_channels_isolation ON tenant_channels
  USING      (tenant_id = app.current_tenant())
  WITH CHECK (tenant_id = app.current_tenant());

COMMENT ON TABLE tenant_channels IS
  'Social accounts a tenant has connected through the network''s own OAuth '
  'dialog. Tenant-owned: ENABLE + FORCE RLS, fail-closed on a NULL tenant '
  'GUC. Disconnecting sets status and clears the credential row.';

-- ===================================================== the credential vault
-- ⛔ ENCRYPTED AT REST, AND THE LIMIT OF THAT IS STATED OUT LOUD.
--
-- `enc_token` holds a Fernet token (AES-128-CBC + HMAC-SHA256, key from
-- CHANNEL_TOKEN_KEY). Fernet is SYMMETRIC: every process holding the key can
-- both write and read. So "only the publishing worker can decrypt" is an
-- ORGANISATIONAL claim here, not a cryptographic one — anything with the env
-- var can read every token in the table. The cryptographic version is a
-- sealed box (the web tier holds only a public key and physically cannot
-- decrypt what it wrote); that is recorded as a v1.1 item in
-- docs/SECURITY_AUDIT.md rather than implied by this column's name.
--
-- What the encryption DOES buy, and it is not nothing: a database backup, a
-- replica, a stray pg_dump, or a SELECT through some future read-only
-- reporting path yields ciphertext, not a live posting token.
CREATE TABLE tenant_credentials (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  channel_id  uuid NOT NULL,
  -- The Fernet token, stored as its base64url form. bytea rather than text so
  -- nothing downstream is tempted to treat it as a printable value, and so a
  -- careless log line renders as an escaped blob instead of a credential.
  enc_token   bytea NOT NULL,
  -- Which key sealed it. Rotation writes new rows at a higher version while
  -- old rows stay readable by the key they were sealed with; without this
  -- column a rotation is a flag day.
  key_version integer NOT NULL DEFAULT 1 CHECK (key_version > 0),
  -- Provider-stated expiry of the access token, when the provider states one.
  expires_at  timestamptz,
  rotated_at  timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  -- One live credential per channel. A refresh REPLACES, it does not append —
  -- a table of historical tokens for a live account is a liability with no
  -- reader.
  UNIQUE (channel_id),
  -- Composite FK: the credential and its channel must belong to the SAME
  -- tenant. A plain `REFERENCES tenant_channels(id)` is satisfied by ANY
  -- channel row, including another tenant's, because foreign keys are not
  -- subject to RLS — the check runs as the referencing table's owner and sees
  -- every row. Binding tenant_id into the key is what makes a cross-tenant
  -- credential unrepresentable rather than merely unwritten.
  FOREIGN KEY (tenant_id, channel_id)
    REFERENCES tenant_channels(tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX tenant_credentials_tenant_idx ON tenant_credentials(tenant_id);

ALTER TABLE tenant_credentials ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_credentials FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant_credentials_isolation ON tenant_credentials
  USING      (tenant_id = app.current_tenant())
  WITH CHECK (tenant_id = app.current_tenant());

COMMENT ON TABLE tenant_credentials IS
  'Encrypted OAuth tokens, one live row per channel. Fernet (symmetric) — '
  'so worker-only decryption is organisational, not cryptographic; the '
  'sealed-box upgrade is v1.1 in docs/SECURITY_AUDIT.md. Composite FK binds '
  'each credential to its channel''s tenant.';

-- ========================================================= the content queue
CREATE TABLE content_items (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  kind       text NOT NULL CHECK (kind IN ('post','reel','answer_page')),
  title      text NOT NULL,
  body       text NOT NULL DEFAULT '',
  media_uri  text,
  -- The approval lifecycle. 'approved' is as far as this migration takes an
  -- item: PUBLISHING IS NOT BUILT YET, and a status that says 'published'
  -- when nothing was published is the one lie this product cannot afford —
  -- the whole point of the platform review video is that what is on screen
  -- is real. 'published' / 'failed' exist so the publishing phase does not
  -- need a migration to change a CHECK constraint under live rows.
  status     text NOT NULL DEFAULT 'draft'
             CHECK (status IN ('draft','in_review','approved','published','failed','rejected')),
  channel_id uuid,
  published_url text,
  published_at  timestamptz,
  -- ⛔ HONESTY COLUMN. Seeded demo rows carry TRUE and the UI labels them as
  -- sample content everywhere they appear. It is a column and not a naming
  -- convention because a convention is a thing you can forget while a NOT
  -- NULL default is not, and because "is any of this real?" is a question the
  -- Home counts have to be able to answer.
  is_sample  boolean NOT NULL DEFAULT false,
  -- Who moved it out of the queue, and when. The `events` row is the audit
  -- trail; these two are the denormalised answer the review screen shows
  -- without a join.
  reviewed_by text,
  reviewed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  -- Same composite-FK reasoning as tenant_credentials: without the tenant_id
  -- in the key, tenant A could point a content item at tenant B's connected
  -- channel and publish through it. ON DELETE SET NULL names its column
  -- explicitly (PG15+) because tenant_id is NOT NULL and must not be nulled
  -- along with it — deleting a channel orphans the content, it does not
  -- orphan the tenancy.
  FOREIGN KEY (tenant_id, channel_id)
    REFERENCES tenant_channels(tenant_id, id) ON DELETE SET NULL (channel_id)
);
CREATE INDEX content_items_queue_idx ON content_items(tenant_id, status, created_at DESC);

ALTER TABLE content_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE content_items FORCE  ROW LEVEL SECURITY;
CREATE POLICY content_items_isolation ON content_items
  USING      (tenant_id = app.current_tenant())
  WITH CHECK (tenant_id = app.current_tenant());

COMMENT ON TABLE content_items IS
  'The approval queue. draft/in_review -> approved|rejected is the only '
  'transition the app performs today; publishing is a later phase and NOTHING '
  'writes ''published'' until it genuinely publishes. is_sample marks seeded '
  'demo rows so the UI can never present them as real work.';

-- ========================================================= grants (app_user)
-- Table-level SELECT on all three, deliberately: the account export walks the
-- catalog for every table carrying a tenant_id and a missing grant silently
-- shrinks "download everything" (test/db/0004_export_coverage.test.sql is the
-- guard). Exporting `enc_token` ships ciphertext whose key is not in the ZIP,
-- so the export stays complete without becoming a credential leak.
GRANT SELECT ON tenant_channels, tenant_credentials, content_items TO app_user;

-- Channels: the app creates them on callback, updates status on disconnect.
-- No DELETE — disconnecting must leave the row (and its history) behind and
-- say so; only the tenant purge removes it, via the definer.
GRANT INSERT ON tenant_channels TO app_user;
GRANT UPDATE (handle, account_id, status, scopes, connected_at, disconnected_at, last_error)
  ON tenant_channels TO app_user;

-- Credentials: written on connect, replaced on refresh, DELETED on
-- disconnect. Disconnect destroying the token is the point — a revoked
-- connection that leaves a decryptable token in the table is not disconnected.
GRANT INSERT, DELETE ON tenant_credentials TO app_user;
GRANT UPDATE (enc_token, key_version, expires_at, rotated_at)
  ON tenant_credentials TO app_user;

-- Content: created by the generator (and the demo seed), moved by review.
-- The column list is the write surface: nothing here can rewrite `tenant_id`
-- or `is_sample`, so an item cannot be moved between tenants or quietly
-- stripped of its "sample content" label by any code path the app has.
GRANT INSERT ON content_items TO app_user;
GRANT UPDATE (title, body, media_uri, status, channel_id, published_url,
              published_at, reviewed_by, reviewed_at, updated_at)
  ON content_items TO app_user;

-- ========================================================= verify, don't assume
-- The same shape as 0002's guard block. A migration that SAYS a table is
-- FORCE and a database where it actually is are different claims; this makes
-- the second one a condition of the migration committing at all.
DO $$
DECLARE v_bad text;
BEGIN
  SELECT string_agg(c.relname, ', ' ORDER BY c.relname) INTO v_bad
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public'
     AND c.relname IN ('tenant_channels','tenant_credentials','content_items')
     AND NOT (c.relrowsecurity AND c.relforcerowsecurity);
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION '0004: expected ENABLE + FORCE RLS, not set on: %', v_bad;
  END IF;
END $$;
