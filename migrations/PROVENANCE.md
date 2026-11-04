# Migration provenance — the squash lineage

This chain was cut on 2026-08-14 (P0 of the GEO SaaS plan) by forking
`topbuilder-os` and squashing the spine subset of its 60-file migration chain
into a fresh chain from `0000`. This file is the audit map: every new file →
the parent migrations it consolidates, plus what was deliberately dropped and
why. The parent chain lives in the `topbuilder-os` repo's `migrations/`
directory and its git history; nothing here is recoverable only from memory.

A fresh database replayed from `0000` must land on exactly the schema the app
expects; `pnpm migrate` + `pnpm test:db` against an empty database is the gate.

## New chain

### `0000_bootstrap.sql`
| Consolidates | What was taken |
|---|---|
| parent `0000_bootstrap` | `pgcrypto` extension, verbatim. |

The `app_user` role (NOSUPERUSER + NOBYPASSRLS) is created outside the chain,
as in the parent: `db/init/00-init.sql` locally, `scripts/bootstrap-prod-db.sql`
in production.

### `0001_security_spine.sql`
| Consolidates | What was taken |
|---|---|
| parent `0001_security_spine` | The whole spine, near-verbatim: `app` schema; GUC helpers (`current_uid` / `current_tenant` / `current_departments` / `can_see_department`); `tenants`, `memberships` (self-read + tenant-read policies), `departments`, `member_department_access`, `events` (all FORCE where tenant-scoped); `app.provision_tenant` SECURITY DEFINER. Provisioning was ALREADY the GEO shape at the DB layer (tenant + owner membership + provisioned event, nothing else) — the NAHB chart-of-accounts and department seeding lived in the app's signup path and are gone. |
| parent `0021_department_walls` (parts) | `GRANT UPDATE ON memberships`, `memberships_tenant_write` policy, department-management grants. NOT taken: the standard-department seed (`field`/`financials`/`hr`) — the GEO shape seeds no departments — and `app.redeem_advisor_invite` (CPA invite channel, domain). |
| parent `0031_session_revocation` | `user_session_epochs` + `own_epoch` policy + grants, verbatim (ENABLE-only: it gates authentication itself). |
| parent `0033_purge_fixed_point` | `app.purge_current_tenant()` — the FINAL fixed-point + verify version, superseding the two-pass version from parent `0023`. Catalog-driven (any table with a `tenant_id` column), so it needs no re-pointing as the schema grows. The `app.ledger_purge` GUC hatch is kept for future append-only tables. |
| parent `0036_dynamic_departments` | `GRANT UPDATE, DELETE ON departments` (owner-managed custom departments). |
| parent `0042_tenant_timezone` + `0045_tenant_timezone_policy` | `tenants.timezone` column + `app.assert_valid_timezone` trigger + `GRANT UPDATE (timezone)` + the `tenants_member_update` policy that makes the grant actually work. NOT taken: `app.tenant_booking_profile` (public self-booking, domain) and the Desert Aire demo-tenant update. |
| parent `0041_resolution_rls` (the law) | The directory-table doctrine is stated in the header and enforced by the guard block at the end of `0002_billing.sql`; the structural vitest `resolution-rls.test.ts` holds it per-function. The three `NO FORCE` ALTERs themselves are moot (portal_tokens / advisor_invites are gone; subscriptions is created ENABLE-only in 0002). `app.lir_cohorts` (platform retention chart over domain tables) was dropped. |

**Note on "0037 membership stack":** the plan named parent `0037` as an
auth-spine source. On inspection `0037_membership_stack.sql` is the HVAC
*customer* membership domain (equipment, maintenance agreements, saved payment
methods, credit memos) — not the auth membership stack. The auth membership
machinery actually lives in parent `0001`/`0021`/`0025`/`0036`, all of which
are consolidated here. Parent `0037` was dropped whole as domain.

### `0002_billing.sql`
| Consolidates | What was taken |
|---|---|
| parent `0023_billing` | `subscriptions` (one row per tenant, Stripe ids live here and nowhere else), `billing_events`, `app.tenant_by_stripe_customer` SECURITY DEFINER. NOT taken: the crew/shop plan set (see below), the two-pass purge (superseded by 0033's), `app.forbid_posted_time_change` (domain), and the backfill trial insert for pre-billing tenants (a fresh chain has none; signup creates the trial row and the store self-heals). |
| parent `0024_billing_events_rls` | `tenant_id NOT NULL`, ENABLE + FORCE RLS, tenant policy, SELECT+INSERT grants — append-only, purge reaches it via the definer. Baked into the CREATE rather than ALTERed after. |
| parent `0025_seat_cap_enforcement` | `app.enforce_seat_cap()` trigger (row-lock serialised, bookkeeper seat free) + `subscriptions.last_event_at` (Stripe event-ordering clock). |
| parent `0035_idempotency_keys` | `idempotency_keys` table, verbatim (claim → work → record; FORCE RLS). |
| parent `0030_payment_idempotency` | **Concept only.** The parent's UNIQUE `(tenant_id, reference)` index lives on the domain `payments` table, which does not exist here. Webhook idempotency for the subscription plane is carried by `billing_events` (event-id dedupe) + `last_event_at` (ordering). ⛔ If a future migration adds any table recording provider payments, it MUST carry the partial-unique-reference index — the at-least-once double-post race is the reason. |
| parent `0041_resolution_rls` | `subscriptions` created ENABLE-only (never FORCE) + table comment + the verify-don't-assume guard block over the four directory tables. |
| parent `0059_solo_plan` | The *shape* of `subscriptions_seat_cap_matches_plan` (plan is the source of truth for the cap), re-cut for the GEO plans. |

**Plan concepts replaced, not carried:** `os_solo_349` / `os_crew_499` /
`os_shop_999` → **`geo_start_89`** (Start, $89/mo, 2 seats) and
**`geo_growth_199`** (Growth, $199/mo, 10 seats), plus the GEO allowance
columns **`included_posts` / `included_reels` / `ai_budget_usd`** (usage-guard
inputs; quantities are P0 placeholders pending Cory's pricing pass — the
columns and their CHECKs are the contract).

## Parent migrations dropped whole (construction domain)

`0002_ledger`, `0003_coa_tag`, `0004_field_ops`, `0005_attachments`,
`0006_revenue`, `0008_wip`, `0009_bank`, `0010_lir`, `0011_qbo`, `0012_agents`,
`0013_purchasing_ap`, `0014_workforce`, `0015_inventory`, `0016_dispatch`,
`0017_intake`, `0018_portal_crm`, `0019_portal_name`, `0020_financial_depth`,
`0022_pricebook_visual`, `0026`–`0029` (certified payroll, payroll drop,
department-wall policies on domain tables), `0030` (see concept note above),
`0032_portal_token_expiry`, `0034_bill_pay_in_transit`, `0037_membership_stack`
(HVAC customer memberships — see note), `0038_cron_tenants` (the daily domain
heartbeat; the GEO worker's claim function arrives with P1), `0039_public_demo`,
`0040_shared_inbox`, `0043`–`0058` (contract movements, self-booking, change
orders, job visibility, cash plan, job forms, bank recategorize, cost codes,
bonding, bank split, accounts & feeds, feed sync, capacity/revrec, credit-card
seed, invoice net subtotal), `0060_prospecting`.

`0007_view_security_invoker` — the ALTERed view is gone; the CLASS rule ("no
view may run with owner rights") is held by the pgTAP suite
`test/db/0005_view_security.test.sql`, which fails on any future view that
forgets `security_invoker`.

## What a P0 auditor should re-verify

1. Fresh replay: `pnpm migrate` from empty → `pnpm test:db` green.
2. `app_user` is NOSUPERUSER + NOBYPASSRLS (asserted in the spine suite).
3. Directory tables (tenants, memberships, user_session_epochs,
   subscriptions) are ENABLE + policy + never FORCE (guard block + vitest).
4. Every tenant-scoped table is FORCE unless it is on the directory list.
5. The seat-cap trigger and plan⇄cap CHECK agree with `PLANS` in
   `src/modules/billing/internal/plans.ts` (2 / 10).

## P1 amendments (2026-08-14)

- `0001_security_spine.sql` edited IN PLACE (pre-first-deploy, so the squash
  chain is still the source of truth, verified by fresh replay): the
  `tenants.timezone` default moved from the parent's `America/Phoenix` to
  `America/Denver`.
- `0003_invites.sql` appended: join-by-link team invites. `invites` is a
  DIRECTORY table (ENABLE-only RLS — the 0041 law) because
  `app.redeem_invite()` resolves a token hash to a tenant for a user who is
  not yet a member. Suite: `test/db/0007_invites.test.sql` (14 assertions).

## P2 addition (2026-08-14) — the first domain migration

### `0004_channels_content.sql`

The first DOMAIN migration in this chain. It consolidates nothing from the
parent: `topbuilder-os` has no social-channel or content-approval surface, so
every table here is new work rather than a re-cut of something inherited.

| Table | Shape |
|---|---|
| `tenant_channels` | What a tenant connected through a network's own OAuth dialog. Keyed `(tenant_id, network, account_id)` so reconnecting the SAME account updates the row rather than growing a card per click, while a second account on the same network is a legitimate second row. No DELETE grant: disconnecting leaves the row and its history. |
| `tenant_credentials` | One live sealed token per channel. Fernet, `key_version` for rolling rotation. A refresh REPLACES; a table of historical tokens for a live account is a liability with no reader. |
| `content_items` | The approval queue. `is_sample` is a column, not a naming convention, and no grant lets the app strip it. |

Also: `tenants.domain` + `tenants.onboarded_at`, with `GRANT UPDATE (name,
domain, onboarded_at)`. The existing `tenants_member_update` policy already
scopes WHICH row; the column grant scopes WHICH column. Both are required and
each fails silently alone (parent 0045, restated in 0001's comment).

**⛔ The one thing to carry forward from this migration: COMPOSITE foreign
keys on every tenant-owned table that references another tenant-owned table.**

`tenant_credentials` and `content_items` both reference `tenant_channels` via
`(tenant_id, channel_id) → (tenant_id, id)`, which is why `tenant_channels`
carries a redundant-looking `UNIQUE (tenant_id, id)`.

The reason is not style. **Foreign key checks are not subject to RLS** — they
run as the referencing table's owner and see every row in the database. A
plain `REFERENCES tenant_channels(id)` is satisfied by ANY channel row,
including another tenant's, so tenant A could point a content item (or a
credential) at tenant B's connected account and publish through it. RLS would
never be consulted. Binding `tenant_id` into the key makes the cross-tenant
row unrepresentable rather than merely unwritten. `ON DELETE SET NULL
(channel_id)` names its column explicitly (PG15+) because `tenant_id` is NOT
NULL and must not be nulled alongside it.

The migration closes with a verify-don't-assume guard block over the three new
tables, in the same shape as 0002's: it RAISEs unless the catalog reports
ENABLE **and** FORCE on all three, so the migration cannot commit while
asserting something the database does not agree with.

Suite: `test/db/0008_channels_content.test.sql` (22 assertions), including
both composite-FK cases and the fail-closed set. Note the shape of assertions
21 and 22: RLS refuses an out-of-scope UPDATE by making rows INVISIBLE, not by
raising, so the statement succeeds and reports zero rows. The test fires the
cross-tenant update for real and then drops back to the owner role to assert
the rival's rows are untouched. Absence of an exception is not evidence.

**Fresh-replay gate.** `scripts/pgtap.mjs` now honours `PGTAP_DB`, so the
"replay 0000 to head into an empty database, then run the whole suite" gate is
repeatable instead of a one-off:

```
docker exec -i neurongeo-db psql -U postgres \
  -c "DROP DATABASE IF EXISTS neurongeo_replay;" \
  -c "CREATE DATABASE neurongeo_replay;"
docker exec -i neurongeo-db psql -U postgres -d neurongeo_replay \
  -c "CREATE EXTENSION pgcrypto; CREATE EXTENSION pgtap;
      GRANT CONNECT ON DATABASE neurongeo_replay TO app_user;
      GRANT USAGE ON SCHEMA public TO app_user;"
MIGRATE_DATABASE_URL=postgres://postgres:postgres@localhost:5433/neurongeo_replay \
  pnpm migrate
PGTAP_DB=neurongeo_replay pnpm test:db
```
