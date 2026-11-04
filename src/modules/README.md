# Modules — the modular monolith

One deployable app, hard internal boundaries. Every domain module lives under
`src/modules/<module>/` and exposes **only** its `index.ts` as a public port.
Deep imports into another module's internals are blocked by
`eslint-plugin-boundaries` (see `eslint.config.mjs`).

## Communication — two channels only

1. **Typed port calls** — import another module through its `index.ts`.
2. **Domain events** — an in-process bus + the Postgres `outbox` table.

Domain modules must never import the app/HTTP layer (`src/app`, `src/middleware`).
Reporting is CQRS-lite: it reads projections, it never writes domain tables.

## Planned modules (created per build slice)

| Module | Slice | Responsibility |
|---|---|---|
| `auth-tenancy` | S1 | identity, tenant + department + role isolation, sessions, 2FA |
| `ledger` | S2 | the double-entry general ledger + posting engine (the book of record) |
| `job-costing` | S3/S6 | WIP/POC, committed costs, burden, budget-vs-actual |
| `field-ops` | S4 | jobs, scheduling, mobile cost capture |
| `estimating` | S5 | good-better-best estimates from the pricebook |
| `sales-invoicing` | S5 | invoices, Stripe payments |
| `bank-rec` | S7 | bank feeds, statement import, For-Review reconciliation |
| `reporting` | S8 | financial statements, CPA pack (read-only projections) |
| `qbo-bridge` | S9 | QBO import/migration + CPA export + optional OAuth Accountant Sync (one-way push of our ledger into the CPA's QBO; our GL is the book of record — QBO is a peripheral) |
| `agents` | S10 | the automation/agent framework (gate, run loop, learning) |
| `purchasing-ap` | S12 | vendors, POs, bills, 1099 |
| `inventory` | S14 | stock, receipts, material cost |
| `scheduling-dispatch` | S15 | dispatch board |
| `comms-voice` | S16 | call intake + booking (Retell) |
| `crm` | S17 | customer portal, CRM, reviews |
| `payroll` | S18 | embedded payroll → GL |
| `integrations` | ongoing | outbound adapters (Plaid, Stripe, QBO, Retell, …) |
