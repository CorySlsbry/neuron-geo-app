# neuron geo app

> **Portfolio snapshot.** A sanitized, history-free copy of a private repository, published to show the work.
> Credentials, customer and lead data, internal notes and third-party material were removed, and real client
> and people names were replaced with fictional ones, so this copy is not meant to run as-is.

- **What it is:** Neuron GEO, a customer-facing SaaS for AI-search (GEO) visibility.
- **Stack:** Next.js, React, Vitest, Drizzle, Zod
- **Languages:** TypeScript, SQL, JavaScript, CSS
- **Private repo history:** 36 commits, 2026-08-14 to 2026-08-17
- **This snapshot:** 175 files, 36 test files
- **Built by:** Cory Salisbury, with Claude Code

_All rights reserved. Shared for portfolio review only; no license is granted to copy, modify or redistribute this code._

---

The customer-facing GEO SaaS: the geo-flywheel engine as a product. This repo
is the P0 **spine** — forked from `topbuilder-os` (2026-08-14), construction
domain stripped, migrations squashed (`migrations/PROVENANCE.md` is the audit
map). What survives is the hardened multi-tenant chassis:

- **auth-tenancy** — session cookie (identity only) + directory-resolved
  authorization on every request, RLS fail-closed (FORCE on tenant tables,
  ENABLE-only on directory tables), server-side session revocation epochs,
  TOTP 2FA step-up (aal2) on sharp actions, department-wall mechanism.
- **billing** — flat GEO plans (Start $89 / Growth $199, Stripe lookup keys
  `geo_start_89` / `geo_growth_199`), embedded checkout, signature-verified
  webhook that resolves the tenant from our own row, seat caps enforced by a
  DB trigger, usage-allowance columns for the P1 usage guard.
- **account** — self-service data ownership: streamed export of every tenant
  table, typed-confirmation delete via a caller-scoped fixed-point purge.

No GEO product features live here yet — P0 is the clean spine only.

## Stack

Next.js 16 + TypeScript (strict) + Postgres 16 (RLS, non-superuser app role).
Modular monolith with lint-enforced module boundaries (`src/modules/*` expose
only `index.ts`).

## Prerequisites

- Node ≥ 20.9, pnpm 10, Docker (local Postgres with pgTAP).

## Develop

```bash
cp .env.example .env.local   # compose defaults work as-is
pnpm install
pnpm db:up                   # Postgres 16 + pgTAP on localhost:5433
pnpm migrate                 # apply migrations/ from 0000
pnpm dev                     # http://localhost:3000 (AUTH_MODE=dev)
```

## The gate (a change is not done until these pass)

```bash
pnpm typecheck && pnpm lint
pnpm test                    # vitest (unit + structural security tests)
pnpm test:db                 # pgTAP against the real RLS policies
```

The pgTAP runner counts declared `plan(N)` vs assertions actually run —
absence of failure is not success.

## Lineage

Forked from `topbuilder-os`. Its migration history is consolidated in
`migrations/PROVENANCE.md`; its security posture carries over in
`docs/SECURITY_AUDIT.md` (inherited findings re-verified per that file's
P0 addendum). The parent repo remains the source of truth for the
construction product.
