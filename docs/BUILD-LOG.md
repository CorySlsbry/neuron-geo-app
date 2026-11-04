# Build log — Neuron SEO

Append-only, newest at the bottom. One entry per working session: what was
built, what was actually VERIFIED (not what was intended), and what the next
session should pick up. Read this and `NEEDS-CORY.md` before doing anything
else — between them they are the whole handoff.

---

## 2026-08-15 — P2-lite chunk 1: the job spine (migration 0005)

**Why this first.** `NEEDS-CORY.md` names publishing as the one thing standing
between the app and a complete platform-verification video: Approve stops at
`approved` and nothing writes `published`. Publishing needs somewhere durable
to keep the work, so the queue is the foundation and it went in first.

### What was built

`migrations/0005_job_spine.sql` — the durable work queue and, more
consequentially, **a second database principal**.

- **`app_worker`** joins `app_user` as a login role. The split is the whole
  design: `app_user` sees one tenant on every table, always; `app_worker` sees
  the **queue** across all tenants (one worker serves everybody) but sees
  tenant **data** through the same fail-closed GUC as the web tier. Its
  cross-tenant reach is confined to `jobs`, whose columns are ids, status and
  timestamps — nothing a customer wrote.
- **`jobs`** — leased, not locked, so a worker that dies holds nothing and
  `app.reap_expired_leases()` returns the row to the queue. Exponential backoff
  lives in `run_after` (survives a restart), a dead-letter `status = 'dead'` at
  `max_attempts` so nothing retries forever, and `UNIQUE (tenant_id,
  dedupe_key)` so double-clicking Approve cannot produce two posts.
- **Both foreign keys are composite** — `(tenant_id, content_item_id)` and
  `(tenant_id, channel_id)`. Same law 0004 established: FK checks are not
  subject to RLS, so a single-column key would let a job stitch one tenant's
  content to another tenant's connected account.
- **`mode` is a stored column, not an env var.** `dry_run` walks the entire
  path — claim, scope, load channel, decrypt credential, build payload — and
  stops before the network call; `live` is the only mode that contacts a
  platform. Stored, because after the fact you must be able to read a row and
  know with certainty whether anything left the machine. An env-var switch
  leaves no evidence.
- **`job_workers`** — heartbeats, for the operator console later. No `app_user`
  policy exists at all, so the customer app cannot read the fleet.

### The bug this closed on the way past

0004's comment promised that nothing writes `published` until something
genuinely publishes. That was a promise about the CODE — `app_user` holds
`UPDATE` on `content_items.status`, so the web tier could always have written
it. `app.guard_published_status()` now makes it structural: a row may only
reach `published` inside a transaction that set `app.publishing`, and the only
thing that sets it is `app.complete_publish()`, which refuses a live completion
that cannot report a destination URL. The guard is narrow on purpose —
Approve/Reject still work untouched.

### Verified

- **Fresh replay into an empty database** (`neurongeo_replay`), 0000 → 0005,
  then the FULL pgTAP suite: **115/115**, of which `0009_job_spine.test.sql` is
  **37/37**.
- `pnpm typecheck` clean · `pnpm lint` exit 0 · **vitest 162/162** (was 154).

The eight new vitest assertions are the interesting ones. The parent repo's
`resolution-rls.test.ts` guard caught all six new definers as unregistered —
correctly. Registering them exposed a real subtlety: they read `jobs`, which is
FORCE, with no tenant GUC set. The naive fix (listing `jobs` as a resolution
table) would have demanded `jobs` stop being FORCE, weakening a table holding
every tenant's queue. Instead the functions are **owned by `app_worker`**,
which has an explicit `TO app_worker USING (true)` policy. That escape hatch is
now itself asserted: ownership per function, the policy's existence, and that
`jobs` is still FORCE. Without those, the definers would return NULL on Cloud
SQL while passing locally — a local superuser owner bypasses RLS outright, so
the failure would have shipped green.

### A false green found in my own test, worth not repeating

`SELECT ok(mutating_fn() AND (SELECT ... FROM t))` does not work. Postgres
takes the snapshot at **statement** start, so the sub-select reads the table as
it was before the function in the same statement changed it. Written that way,
the assertion "a dry run does not mark the content published" passed while
asserting nothing — the item still read `approved` because the update was
invisible, not because the dry run declined to make it. Call the function, then
assert, in a separate statement. Four assertions were rewritten this way.

### Next

**Chunk 2 is the publish path itself**: the worker loop (claim → re-read the
item's status → load channel + decrypt credential → build payload → dry-run
stop or live send → `complete_publish` / `fail_job`), plus the `/api` route that
calls `app.enqueue_publish` when a customer approves.

Note the deliberate seam recorded in 0005's grants: a direct INSERT into `jobs`
by the web tier skips `enqueue_publish`'s "only approved" check, and that is
fine because it is **not** the last line of defence — content can be rejected
in the seconds between enqueue and claim, so the publish handler must RE-READ
the item's status after claiming and refuse anything no longer approved. The
schema guarantees tenancy; freshness is the worker's job.

Nothing in this chunk can contact a social platform: there is no network code
yet, and `mode` defaults to `dry_run`.

---

## 2026-08-15 — P2-lite chunk 2: the publish path, proven as a rehearsal

**The gap this closes.** `NEEDS-CORY.md` item 3 said publishing was deliberately
not built and named it "the one remaining thing between here and a complete
verification video". It is now built, end to end, and it has been run.

### What was built

- `migrations/0006_abandon_job.sql` — a TERMINAL failure to sit beside
  `fail_job`'s retry-with-backoff. The distinction is not "does it stop" (both
  do) but what it says about the customer's content while stopping. `fail_job`
  at the ceiling marks the item `failed`: five real attempts were made. 
  `abandon_job` leaves the item alone, because every reason it fires means the
  item is fine and the SETUP is not (rejected after approval, channel
  disconnected, credential unreadable, live publishing off). A red badge on
  good writing because an OAuth client is missing would be a lie told by a
  status column.
- `src/lib/db/worker.ts` — the worker's own pool, on its own DSN, as
  `app_worker`. No fallback to `DATABASE_URL`: that would silently run the
  worker as `app_user`, where every job function is a permission error and the
  queue just looks empty. An empty queue is indistinguishable from a quiet
  night, so the failure has to be loud at startup.
- `src/modules/publishing/` — `decide.ts` (every gate as ONE PURE FUNCTION),
  `senders.ts` (five providers as data), `worker.ts` (I/O only), `queue.ts`
  (the web tier's enqueue).
- `scripts/worker.ts` — the daemon. `--once`, `--drain`, or poll.

### Why `decide.ts` is pure, and why that is the security argument

The decision to contact a live platform is the highest-consequence branch here.
Buried in the worker loop it is testable only against a database, a network and
a clock, which in practice means tested once by hand and never again. As a
function from plain data to a verdict, every refusal has a test that runs on
every commit, and "a dry run cannot become a send" is an assertion about a
value rather than a hope about control flow.

Three independent gates, each fails closed on its own: the job's `mode` column
(default `dry_run`, in the database, on every row), `PUBLISH_LIVE_ENABLED`
being exactly `"true"`, and a stored credential that opens with the current
key. The third is false for every network today.

### Verified — including a real run, not just tests

**The worker was executed against a real database.** Seeded a tenant with an
approved reel and a connected YouTube channel, enqueued through the vetted
`app.enqueue_publish`, and ran `pnpm worker --once`:

```
{"msg":"worker starting","mode":"rehearsal only — PUBLISH_LIVE_ENABLED is not \"true\", nothing can be sent"}
{"msg":"job finished","outcome":"rehearsed","detail":"dry run, nothing sent: would upload a video to
 YouTube account UC_proofco, titled \"Why your books matter in Q4\", created PRIVATE.
 (POST https://www.googleapis.com/upload/youtube/v3/videos?part=snippet,status)"}
```

Database afterwards: job `succeeded`, **content item still `approved`**, no
`published_url`, no `published_at`, and the event row reads
`content_publish_rehearsed` rather than `content_published`. The rehearsal
published nothing and said so.

Then both live gates were proven in reality, not only in unit tests. A `live`
job with the switch off: `abandoned — live publishing is switched off
(PUBLISH_LIVE_ENABLED is not "true"). This is a code guard, not a comment.`
The same job with `PUBLISH_LIVE_ENABLED=true`: `abandoned — no usable
credential for this channel`. The content item survived both untouched.

Gates: fresh replay 0000 → 0006 then full pgTAP **120/120** (0010 is 5/5) ·
typecheck clean · lint 0 · **vitest 196/196** (was 162) · `pnpm build` green.

### Two real bugs the gates caught

1. **`server-only` stops the daemon from starting.** Every module touching the
   database or the token vault imports it, correctly — but under plain `tsx` it
   resolves to its "you imported this from a Client Component" branch and
   throws on sight. The tempting fix was deleting those imports from
   `crypto.ts`, `networks.ts` and `pool.ts`, which would have removed the
   tripwire from precisely the modules that most need it. Instead the worker
   got its own tsconfig aliasing `server-only` to a no-op stub, scoped to one
   script. `pnpm build` and `pnpm typecheck` still resolve the real package.

2. **⛔ The sealed payload's field is `access`, not `accessToken`.** My worker
   read `accessToken`, which type-checks, never throws, and silently yields
   null — which every caller correctly treats as "no usable credential". The
   result would have been a publish path that refuses every valid token while
   reporting exactly the message it reports when no account is connected. Found
   only because the boundaries lint refused the deep import into
   `channels/internal` and forced the read through the port; the fix extracts
   `readAccessToken()` as the single place that knows the payload shape, and
   `disconnectChannel` now uses it too instead of its own copy.

### Next

The publish path is complete but has never contacted a platform, because
nothing can until an OAuth client exists. The remaining work in priority order:
wire the enqueue into the Review screen's Approve action so a customer can
trigger it (the API route is not built yet — `enqueuePublish` is only reachable
from the module port today); then Resend if the key appears; then containerize
and deploy.

---

## 2026-08-15 — chunk 3: Approve means post, and a guard against the bug class that nearly shipped

Two instructions from Cory this iteration: **approving is approval to post**,
and **build a mechanism that catches the `access`/`accessToken` class of bug
before it is written**, not after.

### The mechanism, because it governs everything after it

The bug was not a typo. It was writing a SECOND reader of a shape that already
had one, from memory, behind a type assertion that told the compiler to stop
checking. Three layers now, weakest to strongest:

1. **`Coding-Standards.md` § PREFLIGHT** (new, in the vault) — five checks that
   run before writing a line. P-1 is the load-bearing one: *never re-declare a
   shape someone else already reads; find the writer, call the existing
   reader.* P-2: a type assertion is a claim, not a check. P-3: `rg` and
   `git log -S` before adding a symbol.
2. **`CLAUDE.md`** — one line pointing at it, next to BRAIN-FIRST, so it is
   read at boot every session.
3. **⛔ `src/lib/shape-guard.test.ts`** — the half that cannot be skipped. It
   fails the build on any inline `JSON.parse(...) as { ... }` or `as unknown
   as`, and it tests its own regexes against the exact code that caused the
   incident. A checklist depends on the person who skipped it; this runs on
   every commit.

`SealedTokens` is now declared once and used by BOTH the writer
(`saveConnection`) and the reader (`readAccessToken`). **Sharing the type
immediately caught a second, live mismatch:** `refresh` was declared
`string | undefined` while `TokenGrant.refreshToken` is `string | null`. The
object literal had been hiding it.

### Approve now queues the post

`decide()` queues a publish for every CONNECTED channel in the same transaction
as the status change. Same-transaction is the point: split in two, an approved
item with nothing queued means the post silently never happens, and a job
queued against an approval that rolled back means a post nobody authorised.

- The mode written is what this deployment can honestly attempt —
  `publishModeForNewJobs()` returns `live` only when `PUBLISH_LIVE_ENABLED` is
  on, else `dry_run`. Queueing `live` regardless would make every approval
  produce a dead job saying "live publishing is switched off", which teaches an
  operator to ignore dead-letters. The worker re-checks independently and is
  still the authoritative gate.
- **Zero queued is a legitimate answer** and the API says so in words:
  "Approved. Nothing was queued to post because no channel is connected yet."
  The Review screen now renders the SERVER's sentence instead of its own
  hardcoded one, which had already gone stale within a day.

### Verified end to end, not just in tests

Fresh replay 0000 → 0006, then the exact approve statements `decide()` issues,
run as `app_user` in one transaction against a tenant with two connected
channels and one disconnected:

```
UPDATE 1
 enqueue_publish
 9a4e0661-...      <- LinkedIn
 d2db7a26-...      <- YouTube
(2 rows)            <- the DISCONNECTED TikTok channel was correctly skipped
COMMIT
```

Then `pnpm worker --drain` rehearsed both with the correct per-network request
(LinkedIn `POST /rest/posts`, YouTube upload created PRIVATE). Final state:
both jobs `succeeded`, **content item still `approved` with no published_url**,
and two `content_publish_rehearsed` events. Nothing was sent anywhere.

Gates: pgTAP **120/120** on a fresh replay · typecheck clean · lint 0 ·
**vitest 202/202** · build green.

### One test fixed for asserting a proxy instead of the claim

"Rejecting queues nothing" was written as "no query mentions `tenant_channels`"
and failed — because the re-read LEFT JOINs that table to name the item's
channel. The claim is about `enqueue_publish` never being called, so it now
asserts that. A test that fails for the wrong reason today passes for the wrong
reason tomorrow.

### Next

Containerize + prepare the Cloud Run deploy (domain mapping ready, not cut
over). Resend is still blocked on a key. The Review screen could also show each
item's publish history, which `jobsForItem` already supports and nothing calls.

---

## 2026-08-15 — chunk 4: containerized, and the images actually run

Resend re-checked first (backlog item 3): `RESEND_API_KEY` is still absent from
the vault, so email stays skipped. Item 4 it is.

### What was already here, and what it was worth

`Dockerfile`, `.dockerignore`, `cloudbuild.yaml` and `cloudbuild.build-only.yaml`
were all inherited from the parent repo with placeholder substitutions. **None
had ever been built for this app.** An inherited Dockerfile that has never been
built is a claim, not a fact, so the first job was to build it and run it rather
than to write more config on top of it.

The web image built clean and served correctly. Verified against the running
container, not the source: `/data-deletion` 200 and rendering all three promises
it makes to Meta (`privacy@neuron-hq.com`, 5 working days, 30 days), `/login`
200, `/dashboard` 200 as an EMPTY client shell with `/api/me`, `/api/content`
and `/api/channels` all returning 401 — so the unauthenticated 200 is a shell,
not a leak. Zero server errors in the log. Image is 294MB.

### The worker had nowhere to run

Added a `worker` target to the Dockerfile. **A separate image, not a second
command on the web one**, because the two connect as different database roles:
`app_user` (one tenant, no job-function EXECUTE) versus `app_worker` (the whole
queue). Migration 0005 makes that split the core of tenant isolation, and it
only holds if the two DSNs live on separate deployments.

It cannot use the standalone output: `next build --output standalone` traces
what the SERVER imports, and `scripts/worker.ts` is reachable from no route, so
none of it is included. The stage carries real node_modules and real source
instead. **That costs size honestly: 991MB against the web image's 294MB.** The
alternative is a second compile step, which buys size at the price of the worker
and the app disagreeing about what the code says. Noted rather than hidden; if
cold starts matter later, a `tsc`-emitted worker bundle is the fix.

`cloudbuild.worker.yaml` deploys it as a Cloud Run **JOB**, not a service: the
worker serves nothing and must not be reachable. `--drain` exits when the queue
is empty, so one invocation is exactly one pass. `PUBLISH_LIVE_ENABLED` is
deliberately NOT set in the pipeline — that switch belongs in a deliberate
`gcloud run jobs update` by a person, not in something that runs on every push.

### Verified end to end, containerized

Both images built, then the worker image run against real queued jobs:

```
{"msg":"worker starting","workerId":"container-worker","mode":"rehearsal only — PUBLISH_LIVE_ENABLED is not \"true\", nothing can be sent"}
{"msg":"job finished","outcome":"rehearsed","detail":"...would post 47 characters to LinkedIn as li_proofco. (POST https://api.linkedin.com/rest/posts)"}
{"msg":"job finished","outcome":"rehearsed","detail":"...would upload a video to YouTube account UC_proofco, titled ..., created PRIVATE."}
{"msg":"worker stopped","jobsHandled":2}
```

Both jobs `succeeded`, content item still `approved` with no `published_url`.

Gates: fresh replay 0000 → 0006 then pgTAP **120/120** · typecheck clean ·
lint 0 · vitest **202/202**.

### Three things running it caught that reading it could not

1. **`CMD` instead of `ENTRYPOINT` broke every flag.** With no ENTRYPOINT,
   `docker run <image> --drain` REPLACES the command rather than extending it,
   so node got `--drain` and exited with "bad option". Split into ENTRYPOINT +
   empty CMD, which is also what a Cloud Run Job's args override expects.

2. **A false RED worth not "fixing".** `/data-deletion` returned 500 with
   `Invalid environment configuration: APP_ORIGIN`. That is the guard working:
   `env.ts` refuses a localhost `APP_ORIGIN` in production because the failure
   mode is a customer redirected to localhost after handing over a card. My
   container run was misconfigured, not the app. I had guessed the variable
   name instead of reading `env.ts` — the exact PREFLIGHT P-3 failure I wrote a
   rule about three hours earlier.

3. **⛔ THE DEV DATABASE'S `pg_hba` MAKES HOST-SIDE PASSWORD TESTS MEANINGLESS.**
   It carries `host all all 127.0.0.1/32 trust` before `host all all all
   scram-sha-256`. So every `pnpm worker` run from the host connected under
   **trust** — any password would have worked, including a wrong one. The
   credential was never validated by those runs. Connecting container-to-
   container over the compose network hits the scram rule and does validate it
   (it passed). Anything that "proves" a credential over 127.0.0.1 against this
   container has proved nothing.

### Next

The deploy itself is blocked on Cory (no GCP resources for this app —
`NEEDS-CORY.md` item 4). Unblocked next: the operator console (worker health
from `job_workers`, per-tenant job counts), or surfacing publish history on the
Review screen, which `jobsForItem` already supports and nothing calls.

---

## 2026-08-15 — chunk 5: the customer can finally SEE what approving did

Read the vault first (Cory's instruction). A parallel Top Builder OS session had
written two laws that land directly here: **"grep for WRITERS, not just
callers"** — the mirror image of the PREFLIGHT P-1 rule I derived from the
`access`/`accessToken` bug, reached independently the same day from the opposite
end — and **"a cap that has never been observed to FIRE is indistinguishable
from no cap."** Cross-linked P-1 to theirs rather than letting the vault fork on
one lesson. Against the second: every guard in this app HAS been observed to
fire (the publish trigger raises 23514 in pgTAP, the live gates both abandoned a
real job, the shape-guard regex is tested against the exact code that caused the
incident, the composite FKs raise 23503).

### The backlog line was wrong, and verifying it changed the work

Item 5 is "operator console (worker health, per-tenant COGS, read-only
impersonation)". Applying the parallel session's own law — a queued item is a
hypothesis about the code — before building it:

- **Per-tenant COGS has no data source.** There is no ledger table and nothing
  anywhere writes a cost or a token count. Building that panel would mean
  fabricating numbers. Blocked on P4, not on Cory.
- **Read-only impersonation has no principal.** No admin/operator role exists.
  It would mean inventing a cross-tenant read path, which is the exact thing
  this schema is built to prevent, and deserves its own design pass.
- Only worker/queue health is honestly buildable today.

But re-reading the GOAL — "approve content **-> SEE IT PUBLISHED**" — the
higher-value unblocked item was still in backlog item 1: approving now queues
publishes and **nothing on any screen ever showed it**. Built that instead.

### What shipped

- `ContentItem.publish` — a summary counted from the `jobs` table via a LATERAL
  join: total, done, pending, failed, anyLive, and the latest job's own note.
  ⛔ Counted from rows, never inferred from `status`: an item stays `approved`
  through a rehearsal (correctly), and status cannot express "three channels
  succeeded, a fourth dead-lettered".
- `publishLine()` — the one sentence a customer reads about whether their
  content went out. **Extracted to its own module specifically so it could be
  tested**; inside the "use client" page that claim was untestable here.
- The Review screen renders it per decided item, plus a "View the post" link
  when a real URL exists.
- The footer copy was replaced. It said "Approved items stay here until
  automatic publishing is switched on. Nothing has been posted to your
  accounts." — stale the moment approving started queueing. It is now derived
  from whether any job was genuinely live. The page's own docstring said
  "publishing is not built"; also corrected.

### Verified

- **The LATERAL query executed against real data**, which vitest could not have
  caught (it mocks the client). Two items: one with 2 finished dry runs reads
  `total 2, done 2, any_live f` → renders "test run finished on 2 of 2, nothing
  sent"; one with no connected channel reads `total 0, any_live NULL` → renders
  "No channel was connected, so nothing was queued to post." The NULL is real
  (`bool_or` over zero rows) and the `?? false` handles it.
- Fresh replay 0000 → 0006 then pgTAP **120/120** · typecheck clean · lint 0 ·
  **vitest 209/209** (was 202; 7 new, including an exhaustive sweep asserting
  the word "posted" can never appear while `anyLive` is false).

### A fragility in my own pgTAP, found by accident

Assertion 15 of `0009_job_spine` asserted `count(*) = 4` over the whole queue to
prove cross-tenant visibility. It passed only because the database happened to
be empty — the moment this session's proof data existed, a perfectly correct
implementation failed. Rewritten to name its own three seeded rows, so unrelated
data is irrelevant. Same trap as an absolute `queued >= 1` gate standing in for
a delta check.

### Next

Worker + queue health is the honest remainder of item 5 and is unblocked.
Deploy stays blocked on Cory (GCP resources); Resend stays blocked (no key).

---

## 2026-08-15 — chunk 6: the security audit for the worker principal

Standing rule outranked the backlog here: `enterprise-security-audit` is a
HARD-STOP on every build AND update, and chunks 1-5 added the largest
security-surface change since the fork — a database role that can read across
tenants. `docs/SECURITY_AUDIT.md` now carries a P2-lite section covering it.

### What the audit records

- **The new principal is bounded to one table.** `app_worker` is NOBYPASSRLS,
  not a member of `app_user`, and its cross-tenant reach is `jobs` alone —
  ids, status, counters, timestamps. Everything a customer wrote stays behind
  the same GUC-scoped policies every other role answers to, and assertion 16
  proves an unscoped worker reads ZERO content items.
- **The definer-ownership trap is tested, not just avoided.** A definer owned
  by the migration role would match no policy on Cloud SQL while passing
  locally. All seven are owned by `app_worker`, the migration RAISEs if not,
  and vitest asserts the ownership, the policy's existence, and that `jobs` is
  still FORCE.
- **Privilege minimisation:** no INSERT on content, UPDATE limited to the four
  publishing columns, no DELETE anywhere, no EXECUTE for the web tier on
  claim/complete/fail/abandon, and `app_user`'s INSERT on `jobs` excludes
  `status`/`claimed_by`/`attempts` — the web tier may ask for work and cannot
  claim it already happened.
- **The first outbound network capability** gets its own treatment: three
  fail-closed gates (two observed refusing a real job, one exhaustively
  tested), `mode` stored as evidence rather than an env var, no token on the
  rehearsal path, the note asserted not to contain a credential, a live
  completion refused without a destination URL, and YouTube/TikTok defaults of
  `private`/`SELF_ONLY`.

### Five open items written down rather than left implied

The sealed-box v1.1 is now **larger in blast radius** (the worker decrypts
customer tokens); the worker image is 991MB of dependency surface; there is no
per-provider rate limit on outbound publishes; `PUBLISH_LIVE_ENABLED` is
per-deployment rather than per-tenant, so switching it on switches it on for
everybody; and the local `pg_hba` trust rule means no host-side test validates
a credential.

Gates: typecheck clean · lint 0 · vitest 209/209 (no code changed this chunk).

### Also this iteration, at Cory's request

Teardown of **Soro** (trysoro.com), a $39/mo automated-SEO-content competitor
he found via a Facebook ad → `Brain/04-Knowledge/Sources/Soro-Teardown.md`.
The finding worth carrying into the product: their hero is ten real Google
Search Console charts with a "Started using Soro" annotation on the inflection
point, and it is the most effective proof device I have seen in this market.
⛔ But their headline claims "Google & ChatGPT" and **every chart is Google** —
they cannot evidence the LLM half of their own pitch, because they have not
built the measurement. That artifact (per-question, per-engine, dated citation
before/after with the answer text) is exactly what our citation loop already
produces, and turning it into a shareable proof card is a product feature, not
a design job.

### Next

Worker + queue health remains the honest, unblocked remainder of item 5.
Deploy is blocked on Cory (GCP); Resend is blocked (no key).

---

## 2026-08-15 — chunk 7: fleet health, as a script with an exit code

Resend re-checked first: `RESEND_API_KEY` still absent. Item 5's honest
remainder it is.

### ⛔ Why this is a script and not an admin screen

The obvious home for "worker health" is an admin page, and **this app has no
admin principal to put one behind**. `job_workers` has NO `app_user` policy at
all — the customer app cannot read the fleet, deliberately — so building a web
surface for it would mean inventing a cross-tenant read path, which is the
exact thing the schema exists to prevent. It runs as `app_worker` instead,
from an operator's own machine, over the same DSN the worker uses.

It also **shows no customer content**. Per-tenant lines carry a tenant id and
counts. No titles, no bodies, no handles. An operator needs to know WHICH
tenant is stuck, never WHAT they wrote.

### What shipped

- `health.ts` — `assessFleet()`, pure, same reasoning as `decidePublish`. **A
  health check is trusted precisely when it is quiet, which makes "can it ever
  say no" the only question worth asking of it.**
- `health.test.ts` — 9 tests, one per unhealthy shape, exactly one for healthy.
- `scripts/ops-status.ts` + `pnpm ops:status` (`--json` for a monitor).
  **Exit code is the point: 0 ok, 1 warn, 2 down**, so it works as a probe and
  not only as something to read.

The rule that shapes the whole thing: **an empty queue and a dead worker look
identical from outside.** Nothing is happening either way. So every verdict is
stated in terms of work waiting *versus* workers reporting, never one alone —
no worker with nothing queued is an idle deployment (warn), and no worker with
three jobs queued is an outage (down). Paging on the first is how a health
check teaches people to ignore it.

Two faults a naive "is the worker up" check misses, both covered: workers alive
but the queue not draining, and a running job whose lease expired (a worker
died mid-flight).

### Verified — all three levels observed firing, with their exit codes

Per the law a parallel session wrote today, a check never seen to fail is
indistinguishable from no check. Run against a real database:

```
[WARN] No worker has ever checked in. Nothing is waiting, so nothing is stuck.   exit 1
[DOWN] No worker has ever checked in, and 1 job(s) are waiting.                  exit 2
       Nothing will publish.
[OK]   1 worker(s) reporting, 0 job(s) in flight, nothing stuck.                 exit 0
```

The DOWN case was produced by queueing a job 40 minutes old with no worker
alive; the OK case by running `pnpm worker --drain` against it, which rehearsed
the job and left the item approved. The tenant line printed an id and counts and
nothing else.

Gates: fresh replay 0000 → 0006 then pgTAP **120/120** · typecheck clean ·
lint 0 · **vitest 218/218** (was 209).

One self-inflicted failure worth noting: two assertions searched for "never
checked in" while the message reads "No worker has ever checked in". The regex
was wrong, not the code — fixed the test.

### Next

The remaining two thirds of item 5 (per-tenant COGS, read-only impersonation)
stay blocked for the reasons recorded in chunk 5: no cost meter exists, and no
admin principal exists. Deploy is blocked on Cory; Resend is blocked on a key.
Unblocked and useful: a per-provider rate limit before live publishing (open
item 3 in the security audit), or wiring `pnpm ops:status` into the worker
container as a Cloud Run health probe.

---

## 2026-08-15 — chunk 8: a ceiling on what we can throw at one platform

Open item 3 from the security audit. The queue bounded RETRIES (backoff,
dead-letter) but nothing bounded DISTINCT jobs: approve one item for a tenant
with five channels and five jobs are claimable instantly, ten tenants in the
same minute is fifty. Every one is a real publish the moment live mode is on,
and the platforms whose review we are asking for are exactly the parties who
would notice.

### What shipped — `0007_provider_limits.sql`

- **`provider_limits`** — per-network `max_in_flight`, seeded conservatively
  (YouTube 1, TikTok 1, the rest 2) with the reason on each row. A table rather
  than a constant because an operator will want to change these at 2am without
  shipping a migration. Infrastructure: no `app_user` policy, so the customer
  app cannot read or edit the throttle that governs it.
- **`jobs.network`, denormalized.** `claim_next_job` runs across tenants and
  must not read tenant-owned tables — `tenant_channels` is GUC-scoped and the
  claim has no scope yet, by design. Joining would either claim nothing or
  require giving the worker cross-tenant sight of a customer table. The privacy
  cost is named in the migration: `jobs` now also says WHICH network, alongside
  ids and statuses. Still nothing a customer wrote.
- ⛔ **Enforced at the CLAIM, not at the send.** A worker checking a limit just
  before calling out has already been handed the job, so two workers check
  independently and both proceed. Evaluating the ceiling inside the statement
  that takes the row makes the database the arbiter, so N workers cannot
  collectively exceed it. Same shape as the review queue's status guard.
- **An unknown limit means 1, never unlimited** — a `COALESCE` in the claim, so
  a network nobody configured is still bounded.

### Verified — the throttle was watched refusing

`0011_provider_limits.test.sql`, 8 assertions, all about a claim that does NOT
happen: YouTube at ceiling 1 forces the next claim to skip to a network with
room; a third claim with everything full returns nothing; the blocked job is
still `queued` rather than lost or failed; raising the ceiling releases exactly
that job; and a network with its limit row deleted is bounded at 1.

Gates: fresh replay 0000 → 0007 then pgTAP **128/128** · typecheck clean ·
lint 0 · vitest 218/218.

### Three failures on the way, all of them the new constraint working

1. `NOT NULL network` broke the 0009/0010 fixtures that insert jobs directly.
   Correct behaviour; fixtures updated.
2. **`enqueue_publish` wrote `network` and got "permission denied for table
   jobs".** 0005's INSERT grant listed six columns and I added a seventh to the
   statement without adding it to the grant. That is the grep-for-WRITERS law
   exactly: **the write has to survive the whole chain, schema → grant →
   statement**, and the grant is the link easiest to miss because nothing in
   the function body mentions it.
3. **0009 then failed at "a live completion with no URL is refused"** — because
   all three of its seeded jobs were YouTube, and YouTube's new ceiling is 1, so
   the second job was never claimable. The throttle working. Its fixtures now
   span networks, which keeps that suite about the spine and leaves the ceiling
   to 0011.

### Next

Genuinely unblocked work is now thin. Per-tenant COGS needs a meter that does
not exist; impersonation needs an admin principal that does not exist; deploy
needs GCP resources; Resend needs a key. The remaining sensible items are
polish (wire `ops:status` as the worker container's health probe) rather than
capability.
