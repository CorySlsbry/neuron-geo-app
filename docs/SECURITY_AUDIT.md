# Security Audit — Neuron SEO (P0 fork)

Living record for the `enterprise-security-audit` HARD GATE. A slice is not
"done" until the applicable items here are **verified** (with evidence) and
checked off.

**Lineage:** this app was forked from `topbuilder-os` on 2026-08-14 (P0 of the
GEO SaaS plan). The parent's full audit (route sweeps, live probes, incident
history) lives in the parent repo's `docs/SECURITY_AUDIT.md` and remains the
evidence base for every control inherited unchanged. This file records what
was RE-VERIFIED against this fork's own code and database. Inherited claims
are not carried forward as checked until re-proven here.

Legend: ✅ verified in THIS repo · 🧬 inherited design (parent-verified, carried
by construction) · 🔜 open

## P0 fork verification (2026-08-14)

### Three-level isolation — tenant + department + role
Evidence: `migrations/0001_security_spine.sql`, proven by `pnpm test:db`
against a FRESH database replayed from `0000` — **42/42 pgTAP assertions
pass** across 6 suites.

- ✅ RLS **ENABLE + FORCE** fail-closed on tenant tables; unset scope → zero
  rows. *(0001 suite)*
- ✅ App connects as a **non-superuser** role, no BYPASSRLS — asserted from
  `pg_roles`, not assumed. *(0001 suite)*
- ✅ Directory tables (`tenants`, `memberships`, `user_session_epochs`,
  `subscriptions`) ENABLE-only **NO FORCE** — the resolution-table law; also
  enforced by the guard block at the end of `migrations/0002_billing.sql`
  (raises if any is FORCE or policy-less) and by the structural vitest
  `resolution-rls.test.ts` (every SECURITY DEFINER function accounted for).
- ✅ **WITH CHECK** blocks cross-tenant writes. *(0001 + 0002 suites)*
- ✅ **Department-wall mechanism** fail-closed (no department scope → zero
  walled rows). Nothing seeds departments in the GEO shape; the mechanism is
  proven against a fixture table. *(0001 suite)*
- ✅ **Session revocation**: `user_session_epochs` pins every row to its own
  principal — foreign bump matches zero rows, foreign insert 42501, self-bump
  works. *(0001 suite)* App-side: cookie carries the mint-time epoch;
  `requireAuth` fails closed on mismatch or unreadable epoch.
- ✅ **Signup provisioning is the GEO shape** — live browser flow 2026-08-14:
  dev login → create company → exactly one tenant + one owner membership +
  one 30-day `start` trial row (2 seats, allowance columns at defaults),
  **zero departments, zero domain rows**. Verified by SQL against the dev DB.
- ✅ **aal2 step-up holds**: `GET /api/account/delete` as an aal1 dev session →
  `403 aal2_required` (live, 2026-08-14).

### Billing plane
Evidence: `migrations/0002_billing.sql` + `test/db/0002_billing.test.sql`,
`0003_seat_cap.test.sql`.

- ✅ Subscription isolation (a tenant sees exactly its row; cross-tenant
  create 42501; hijacking another's `stripe_customer_id` 23505).
- ✅ `billing_events` tenant-scoped + FORCE, fail-closed, append-only grants.
- ✅ Seat cap enforced by a DB trigger under a row lock (concurrency-safe);
  bookkeeper seat free; plan⇄seat-cap CHECK binds every role.
- ✅ Plan⇄cap drift impossible (`subscriptions_seat_cap_matches_plan`).
- 🧬 Webhook: signature over the raw body (multi-secret, constant-time,
  5-minute window — `billing/internal/webhook-verify.ts`, moved verbatim from
  the parent where it was live-verified); tenant resolved ONLY via
  `app.tenant_by_stripe_customer` (payload tenant ids never read); event-id
  dedupe + `last_event_at` ordering clock. 🔜 re-verify live once the NEURON
  Stripe account's webhook endpoint exists (P1).

### Data ownership (export & delete gate)
- ✅ Purge: caller-scoped fixed-point + verify (`0006_purge_fixed_point`
  suite: multi-level FK graph converges, bystander tenant untouched, unscoped
  session refused).
- ✅ Export coverage: every tenant-scoped table readable by `app_user` or
  explicitly allowlisted, allowlist empty (`0004_export_coverage` suite).
  Export streams under the tenant's own RLS scope (`streamWithTenant`,
  READ ONLY transaction).
- ✅ No view may bypass RLS (`0005_view_security` suite; the chain ships no
  views, the suite guards the class).

### App layer
- ✅ `tsc --noEmit` clean; vitest 88/88 including the structural security
  tests (viewer-readonly route sweep, resolution-RLS, loading coverage).
- 🧬 CSP with per-request nonce + `strict-dynamic`, same-site check on
  state-changing requests, rate limits on the unauthenticated edges
  (signup/login), iron-session httpOnly cookie, identity-only session,
  dev-login refuses production. Inherited unchanged from the parent
  (`src/proxy.ts`); the nonce path re-verified live in this fork (the theme
  boot script only runs nonce'd — an un-nonced inline script is dead under
  this CSP, proven by the hydration/nonce work 2026-08-14).
- 🔜 2FA (TOTP → aal2) end-to-end: mechanism inherited (identity-platform
  verify + `aal2` gates on sharp routes), needs a live pass once GCP Identity
  Platform is provisioned for THIS app (P1). Static-page exemption does not
  apply — this app has accounts, so 2FA is mandatory before launch.

## Open items for the P1 audit sweep
1. Provision NEURON-account Stripe products (`geo_start_89`,
   `geo_growth_199`) and live-verify checkout + webhook + plan change.
2. Identity Platform (or replacement) for this app + TOTP enrollment flow
   live pass; then re-run the aal2 sweep.
3. Rate-limit review once public GEO surfaces exist (today only auth edges
   are public).
4. Dependency audit (`pnpm audit --prod`) on every update — parent was clean
   at fork time.
5. Residue sweep: see the P0 report's "likely construction residue" list.

## P1 verification (2026-08-14) — signup, invites, paywall

Evidence: fresh-DB replay `0000→0003` + **56/56 pgTAP assertions** across 7
suites; 107 vitest green; live smoke against the REAL Identity Platform
project (`neuron-learnai`).

### Identity Platform is live (closes open item 2, first half)
- ✅ Real project wired: `GCP_PROJECT_ID=neuron-learnai`, TOTP MFA **ENABLED**
  on the project (optional per user, adjacentIntervals 5), authorized domains
  now include `app.neuron-hq.com` + `localhost`. Verified by reading the
  admin/v2 config back after each PATCH.
- ✅ The verifier's aud/iss pin is env-driven; the test suite pins a FAKE
  project id (`neuron-geo-test`) and stubs the JWKS — no coupling to real
  infrastructure. Production env parsing now HARD-FAILS at boot when
  AUTH_MODE is not identity-platform or the project/key are missing.
- ✅ Self-serve signup is CLIENT→GOOGLE only (accounts:signUp,
  sendOobCode, resetPassword): the password never touches our servers; the
  server still refuses sessions until `email_verified` and still pins the
  provider allowlist. Forgot-password is enumeration-safe (project has
  email-privacy on; the UI says "if there's an account").
- 🔜 aal2 live pass (TOTP enrollment on this app's security page) — the
  project side is ready; run the sweep during the P3 screens work.

### Invites (new surface, audited at birth)
- ✅ Token: 256-bit random, stored ONLY as SHA-256; raw token exists in the
  creation response and the copied link, nowhere else. Accept endpoint
  rate-limited in the proxy (20/5min/IP).
- ✅ `invites` is a DIRECTORY table (ENABLE-only RLS, tenant policy) because
  `app.redeem_invite()` is SECURITY DEFINER — registered in the structural
  vitest like every other definer. No UPDATE grant for app_user: only the
  definer can spend an invite (proven, 42501).
- ✅ Single-use (FOR UPDATE + accepted_at), 7-day expiry, and ONE
  indistinguishable NULL for unknown/spent/expired — nothing to probe.
- ✅ Seat cap enforced at REDEMPTION by the existing memberships trigger
  (single enforcement point) — proven at a full cap, bookkeeper exemption
  included. Creation additionally aal2 + owner/admin + paywalled.

### Paywall (authorization, so it lives in requireScope)
- ✅ Writes require active / live-trial / past_due-within-7-day-grace; 402
  `subscription_required` otherwise. Decision is a pure function with the
  full status × clock matrix unit-tested, fail-closed on unknown status and
  unreadable clocks.
- ✅ Reads NEVER blocked; export and billing routes deliberately unpaywalled
  (the way back in, and the way out, stay open).

## P2 verification (2026-08-14) — channel connections, credentials, content

The demo path (sign in, connect a channel through the network's own OAuth
dialog, approve content, disconnect, find the deletion instructions) and the
three tables behind it. Migration `0004_channels_content.sql`, module
`src/modules/channels`, pgTAP `test/db/0008_channels_content.test.sql`.

### Tenant isolation on the new tables
- OK — `tenant_channels`, `tenant_credentials`, `content_items` are all
  ENABLE **+ FORCE** RLS with a tenant policy on USING and WITH CHECK. The
  migration ends with a guard block that RAISEs unless the catalog agrees, so
  "the migration says FORCE" and "the database is FORCE" are the same claim.
- OK — fail-closed proven, not assumed: with `app.current_tenant` unset all
  three read zero rows and refuse INSERT (42501).
- OK — **composite foreign keys** `(tenant_id, channel_id)` referencing
  `tenant_channels (tenant_id, id)` on both credentials and content.

  ⛔ This is the finding worth remembering: **foreign key checks are NOT
  subject to RLS.** They run as the referencing table's owner and see every
  row in the database. A plain `REFERENCES tenant_channels(id)` would
  therefore let tenant A hang its content, and its credentials, off tenant
  B's connected account and publish through it. RLS would not have stopped
  it, because RLS is never consulted during an FK check. Binding tenant_id
  into the key makes the cross-tenant row unrepresentable. Proven blocked
  (23503) on both tables.
- OK — column-level UPDATE grants only: nothing the app can run rewrites
  `content_items.tenant_id` (no cross-tenant move) or `is_sample` (no
  stripping a demo row's label). Proven by `has_column_privilege`.
- OK — no DELETE grant on `tenant_channels`: a disconnect must leave the row
  and its history behind. Only the tenant purge removes it, via the definer.
- OK — no new DIRECTORY tables. The OAuth callback resolves its tenant from
  the SESSION, never from anything the provider returns, so nothing here sits
  on the path from an unauthenticated fact to a tenant_id (the 0041 law).

### Credential storage
- OK — tokens are sealed with **Fernet** (AES-128-CBC + HMAC-SHA256, key from
  `CHANNEL_TOKEN_KEY`) before they reach the database. Access AND refresh
  token are sealed together, so the refresh token, the one that does not
  expire, never gets weaker treatment than the access token.
- OK — authenticate-then-decrypt: the HMAC is verified before the ciphertext
  is touched. Decrypt-first turns CBC padding into an oracle. Tamper cases are
  unit-tested (ciphertext bit-flip, forged tag, wrong version byte, wrong key)
  and the tag comparison is constant-time.
- OK — no key configured means **no network is connectable at all**, and every
  card says so before it is clicked. The vault cannot be silently bypassed
  into storing a plaintext token.
- OK — disconnect DELETES the credential row and marks the channel first, then
  asks the provider to revoke. That order is deliberate: the reverse leaves a
  decryptable token in our table every time the provider is slow, and a
  customer withdrawing access must not be blocked by someone else's outage.
- OK — disconnect is NOT paywalled. Holding a revocation hostage to a lapsed
  card is behaviour every platform policy on this list forbids.

#### ⛔ v1.1 — SEALED BOX (the honest limit of the above)

**Fernet is SYMMETRIC.** Every process holding `CHANNEL_TOKEN_KEY` can both
seal and open, so "only the publishing worker can decrypt a customer's token"
is an **organisational** claim about which processes receive the env var. It
is **not enforced by the cryptography**: anything with the key reads every
token in the table. This is stated in the table comment, in
`src/modules/channels/internal/crypto.ts`, and here, rather than being implied
by the column name.

What it genuinely buys today: a database backup, a replica, a stray pg_dump,
or any future read-only reporting path over the table yields ciphertext, not a
live posting token. That is real and worth having. It is just not the stronger
claim, and the stronger claim is the one a column called `enc_token` invites a
reader to assume.

The v1.1 upgrade is a **sealed box** (X25519 + XSalsa20-Poly1305, for example
libsodium `crypto_box_seal`): the web tier holds only a PUBLIC key and is
cryptographically incapable of reading what it wrote, while the private key
lives only in the publishing worker's secret store. `key_version` on
`tenant_credentials` is the seam that makes this a rolling migration rather
than a flag day: new rows seal at v2 while v1 rows stay openable by the key
that sealed them.

### Route posture (new surfaces, audited at birth)
- OK — connect / decide / seed-samples / brand: `requireScope({ roles:
  WRITE_ROLES, write: true })`. Role-gated and paywalled, deliberately not
  aal2: that bar is for money and access, and a TOTP prompt to attach a
  YouTube account buys nothing while breaking the review recording.
- OK — disconnect: `WRITE_ROLES`, **not** paywalled (see above).
- OK — reads (channels / content / overview): membership only. A read-only
  workspace can still be looked at, and left.
- OK — CSRF on the OAuth leg: 256-bit `state` in an httpOnly, SameSite=**Lax**
  cookie (Strict would withhold it on the provider's top-level cross-site
  return and break every connection), compared in constant time, plus PKCE
  S256 where the provider supports it. The cookie's tenant is compared against
  the server-resolved active tenant and a mismatch REFUSES: someone who
  switched workspace mid-flow does not get the account attached to whichever
  tenant is active now.
- OK — the callback never returns JSON. Every outcome is a redirect to
  `/channels` carrying a machine code, so a failure cannot end as an error
  envelope in the customer's address bar. Provider error bodies are logged
  server-side and never forwarded (unit-tested: a secret in an exchange error
  does not reach the redirect URL).

### Fixed in this pass
- OK — `addMember` RETIRED. It INSERTed into `memberships` as app_user, which
  has never held an INSERT grant there, so it could only ever 500, and no UI
  called it. Not fixable by adding the grant: joining a tenant must enforce
  the seat cap, and `app.redeem_invite` is the one door whose lock does.
- OK — the data-export and delete surfaces no longer render controls that
  fail. Both are aal2-gated at the route, and the export is an `<a download>`,
  a navigation with no catch block, so an aal1 owner was served a raw
  `aal2_required` JSON envelope rendered as a page. `/account` additionally
  answered every 403 with "only the owner can delete the business account",
  told to the actual owner, and never cleared its loading state, leaving a
  permanent skeleton. Both now ask before they offer and link to `/security`.
- OK — the export ZIP filename was still `top-builder-os-export-*.zip`:
  parent-brand residue in a Content-Disposition header, invisible on screen
  and visible in the customer's Downloads folder. Now `neuron-geo-export-*`.
- OK — the `viewer-readonly` structural guard only matched
  `export const POST|PATCH|PUT|DELETE`. The OAuth callback is the first route
  needing `export async function` (it returns redirects, so it cannot use the
  `route()` JSON wrapper), and the guard would have silently stopped guarding
  any route written that way. Both spellings now match.

### Still open after P2
1. Stripe products (unchanged from P1 open item 1).
2. aal2 live pass: TOTP enrollment end-to-end on `/security`. This now BLOCKS
   filming the export and delete steps, because both require aal2.
3. Sealed-box upgrade for `tenant_credentials` (v1.1, above).
4. Per-network OAuth clients: none are configured, so no connection has been
   completed against a real provider yet. The dance is verified as far as it
   can be without credentials (authorize URL shape, PKCE, state cookie, every
   callback refusal path). The token exchange and the identity lookup are the
   untested half. See docs/NEEDS-CORY.md.
5. Rate-limit review: `/api/channels/callback/*` is reachable without a
   session (it 307s to /channels) and `/api/channels/connect` mints state
   cookies. Neither is expensive today and both sit behind a session or a
   cookie compare, but they are the first non-auth surfaces a stranger can
   touch since P1 and belong in the next limiter pass.

---

## P2-lite verification (2026-08-15) — the worker principal and the publish path

Migrations `0005_job_spine.sql` + `0006_abandon_job.sql`, module
`src/modules/publishing`, `src/lib/db/worker.ts`, `scripts/worker.ts`, pgTAP
`0009_job_spine` (37) + `0010_abandon_job` (5).

⛔ **This is the largest security-surface change since the fork**, and it needs
saying plainly: the schema now contains a role that can read across tenants.
Everything below exists to bound that.

### The new principal

- `app_worker` — NOLOGIN in the migration (the deployment grants the
  credential), NOSUPERUSER, **NOBYPASSRLS**, not a member of `app_user`.
- OK — its cross-tenant reach is **exactly one table**. `jobs` carries two
  policies: `jobs_isolation TO app_user` (tenant-scoped, fail-closed) and
  `jobs_worker TO app_worker USING (true)`. Every other table it touches
  (`content_items`, `tenant_channels`, `tenant_credentials`, `events`) is
  governed by the pre-existing PUBLIC policies, whose predicate is
  `tenant_id = app.current_tenant()`.
- OK — **proven, not asserted**: an unscoped `app_worker` session reads
  **zero** content items (assertion 16). Queue-wide is not data-wide.
- OK — what `jobs` exposes cross-tenant is ids, status, counters and
  timestamps. No title, no body, no token, nothing a customer wrote.
- OK — the worker never chooses whose data it touches.
  `app.claim_next_job()` **takes no tenant argument** (the same law as
  `purge_current_tenant`) and sets `app.current_tenant` itself from the row it
  claimed.
- OK — `job_workers` has **no `app_user` policy at all**, so the customer app
  cannot read the fleet. Absence of a policy is a denial.

### The definer-ownership trap, and why it is tested

`SECURITY DEFINER` runs as the function's owner, and `FORCE RLS` binds the
owner too. A definer owned by the migration role would match **no policy** on
Cloud SQL (where that role is not a real superuser) while working perfectly in
local dev (where it is one) — a dev-green/prod-dead failure.

- OK — all seven job definers are `ALTER FUNCTION … OWNER TO app_worker`, and
  the migration's own verification block RAISEs if any is not.
- OK — `resolution-rls.test.ts` additionally asserts, per function, the
  `OWNER TO app_worker` line, the existence of the `TO app_worker` policy on
  `jobs`, and that `jobs` is still FORCE. The escape hatch cannot be silently
  removed.

### Privilege minimisation on the worker

- OK — **no INSERT on `content_items`**; UPDATE limited to
  `(status, published_url, published_at, updated_at)`. A compromised worker
  cannot author or rewrite a customer's copy, only report where it went.
- OK — no DELETE anywhere. No grant on `tenants`, `memberships`, `invites`,
  `subscriptions` or `billing_events`.
- OK — the web tier has **no EXECUTE** on claim/complete/fail/abandon
  (asserted). A request handler that could complete a job could mark work done
  without doing it.
- OK — `app_user`'s INSERT on `jobs` is column-scoped and excludes `status`,
  `claimed_by`, `attempts` and `result_note`: the web tier may ASK for work and
  cannot claim the work already happened.

### The publish path (the first outbound network capability in this app)

- OK — **three independent gates, each fail-closed**, and all three are proven
  to fire rather than merely present: the job's `mode` column (default
  `dry_run`, in the database, on every row); `PUBLISH_LIVE_ENABLED` matched as
  exactly `"true"`; and a stored credential that opens with the current key.
  Two of the three were observed refusing a real job in a live run; the third
  is covered by an exhaustive unit test.
- OK — `mode` is a **stored column, not an env var**, so after the fact a row
  proves whether anything left the machine. An env-only switch leaves no
  evidence.
- OK — the decision is one **pure function** (`decidePublish`), so every
  refusal is a value with a test, not a branch that was walked once by hand.
- OK — a dry run never receives a token: `accessToken` is empty on the
  rehearsal path by construction.
- OK — the rehearsal note is written to the database and to logs and is
  asserted **not to contain the token**.
- OK — `send()` does not log the request; the bearer header is never rendered.
- OK — **a live completion is refused without a destination URL**, and a 200
  with an unrecognisable body raises rather than inventing one. That is the
  only place a fabricated "published" URL could enter the system.
- OK — the item's status is **re-read after the claim**. The enqueue-time check
  is stale by then, and a customer who rejects after approving must not be
  published anyway.
- OK — YouTube uploads are created `private` and TikTok posts `SELF_ONLY`.
  A demo publish that lands publicly on a customer's channel is not
  recoverable by an apology.

### The honesty guard (a promise the schema now keeps)

0004's comment said nothing writes `published` until something genuinely
publishes. `app_user` holds UPDATE on that column, so it was a promise about
the code only.

- OK — `content_items_publish_guard` refuses any transition to `published`
  outside a transaction that set `app.publishing`, which **only**
  `app.complete_publish()` sets. Proven to raise 23514 from `app_user`.
- OK — the guard is narrow: Approve/Reject still work (proven).
- OK — `abandon_job` deliberately does **not** mark content `failed`. Every
  reason it fires means the setup is broken, not the content.

### Composite foreign keys, again

- OK — `jobs` carries `(tenant_id, content_item_id)` and
  `(tenant_id, channel_id)` composite FKs, both proven to raise 23503 on a
  cross-tenant reference. Same law as 0004: **FK checks bypass RLS.**
  `content_items` gained the `UNIQUE (tenant_id, id)` needed to be a target.

### Open items carried forward

- ⚠️ **v1.1 sealed box still open.** The worker now decrypts customer tokens,
  which makes the symmetric-Fernet limit more material than it was at P2: any
  process holding `CHANNEL_TOKEN_KEY` reads every token. Unchanged in kind,
  larger in blast radius. Still the right v1.1 item.
- ⚠️ **The worker image is 991MB** and ships full `node_modules` plus source.
  Larger dependency surface than the 294MB web image. Acceptable for a
  non-ingress batch job; revisit if it ever serves anything.
- ⚠️ **No rate limiting on outbound publishes.** The queue's backoff bounds
  retries, but nothing bounds how many distinct jobs hit one provider at once.
  Harmless while every job is a rehearsal; needs a per-provider ceiling before
  live publishing is switched on for a real tenant.
- ⚠️ **`PUBLISH_LIVE_ENABLED` is per-deployment, not per-tenant.** Turning it
  on turns it on for everybody in that deployment. Fine for one operator and
  one demo; a per-tenant opt-in is the right shape before GA.
- ⛔ **Local dev `pg_hba` trusts 127.0.0.1** ahead of its scram rule, so a
  host-side connection validates no password. Any local "the credential works"
  claim about `app_worker` must be made container-to-container. Recorded so a
  future reader does not repeat it.
