import "server-only";
import { env } from "@/env";
import { getPool } from "@/lib/db/pool";
import { withTenant, type TenantScope } from "@/lib/db/tenant";
import { PLANS, checkSeat, explainSubscription, isUpgrade, planFor, type PlanKey } from "./plans";
import { BillingError, billingEnabled, priceIdFor, stripeRequest } from "./stripe-api";

// The tenant's own subscription. One row per tenant, read/written under
// tenant RLS; Stripe ids live here and nowhere else. The webhook resolves
// the tenant from THIS table by stripe_customer_id — a payload can never
// name its own tenant.

export interface SubscriptionState {
  plan: PlanKey;
  planName: string;
  priceCents: number;
  seatCap: number;
  seatsUsed: number;
  status: string;
  cancelAtPeriodEnd: boolean;
  currentPeriodEnd: string | null;
  trialEndsAt: string | null;
  hasPaymentMethod: boolean;
  explain: string;
}

interface Row {
  plan: PlanKey;
  seat_cap: number;
  status: string;
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
  current_period_end: string | null;
  trial_ends_at: string | null;
  cancel_at_period_end: boolean;
}

async function readRow(scope: TenantScope): Promise<Row> {
  return withTenant(scope, async (c) => {
    const { rows } = await c.query<Row>(
      `SELECT plan, seat_cap, status, stripe_customer_id, stripe_subscription_id,
              current_period_end::text AS current_period_end,
              trial_ends_at::text AS trial_ends_at, cancel_at_period_end
         FROM subscriptions`,
    );
    if (rows[0]) return rows[0];
    // Self-heal: a tenant created before billing existed starts its trial now.
    const ins = await c.query<Row>(
      `INSERT INTO subscriptions (tenant_id, plan, seat_cap, status, trial_ends_at)
       VALUES ($1,'start',2,'trialing', now() + interval '30 days')
       ON CONFLICT (tenant_id) DO UPDATE SET updated_at = now()
       RETURNING plan, seat_cap, status, stripe_customer_id, stripe_subscription_id,
                 current_period_end::text AS current_period_end,
                 trial_ends_at::text AS trial_ends_at, cancel_at_period_end`,
      [scope.tenantId],
    );
    return ins.rows[0]!;
  });
}

async function seatsUsed(scope: TenantScope): Promise<number> {
  return withTenant(scope, async (c) => {
    // The CPA/bookkeeper seat is free — it never counts against the cap.
    const { rows } = await c.query<{ n: string }>(
      `SELECT count(*) AS n FROM memberships
        WHERE tenant_id = $1 AND role <> 'bookkeeper'`,
      [scope.tenantId],
    );
    return Number(rows[0]!.n);
  });
}

export async function getSubscription(scope: TenantScope): Promise<SubscriptionState> {
  const [row, used] = await Promise.all([readRow(scope), seatsUsed(scope)]);
  const plan = PLANS[row.plan];
  return {
    plan: row.plan,
    planName: plan.name,
    priceCents: plan.priceCents,
    seatCap: row.seat_cap,
    seatsUsed: used,
    status: row.status,
    cancelAtPeriodEnd: row.cancel_at_period_end,
    currentPeriodEnd: row.current_period_end,
    trialEndsAt: row.trial_ends_at,
    hasPaymentMethod: Boolean(row.stripe_subscription_id),
    explain: explainSubscription({
      plan: row.plan,
      status: row.status,
      cancelAtPeriodEnd: row.cancel_at_period_end,
      currentPeriodEnd: row.current_period_end,
      trialEndsAt: row.trial_ends_at,
    }),
  };
}

/** The seat wall the team API calls before adding a person. */
export async function assertSeatAvailable(scope: TenantScope): Promise<void> {
  const [row, used] = await Promise.all([readRow(scope), seatsUsed(scope)]);
  const check = checkSeat(row.plan, used);
  if (!check.allowed) {
    const err = new BillingError(402, "seat_limit_reached");
    (err as BillingError & { detail?: unknown }).detail = check;
    throw err;
  }
}

// --------------------------------------------------------------- checkout
async function ensureCustomer(scope: TenantScope): Promise<string> {
  const row = await readRow(scope);
  if (row.stripe_customer_id) return row.stripe_customer_id;
  // tenants is member-read RLS: read the name inside the scope or Stripe
  // gets a generic customer name.
  const tenantName = await withTenant(scope, async (c) => {
    const t = await c.query<{ name: string }>(`SELECT name FROM tenants WHERE id = $1`, [
      scope.tenantId,
    ]);
    return t.rows[0]?.name;
  });
  const customer = await stripeRequest<{ id: string }>("customers", {
    data: {
      name: tenantName ?? "Neuron SEO customer",
      // Email is collected by Checkout and attached by Stripe — the session
      // scope deliberately carries identity only.
      // The ONLY link back to us. The webhook still resolves the tenant from
      // our own table — this is for humans reading the Stripe dashboard.
      metadata: { tenant_id: scope.tenantId },
    },
    idempotencyKey: `cust:${scope.tenantId}`,
  });
  await withTenant(scope, async (c) => {
    await c.query(
      `UPDATE subscriptions SET stripe_customer_id = $1, updated_at = now()`,
      [customer.id],
    );
  });
  return customer.id;
}

/**
 * Embedded checkout: returns a client_secret we mount INSIDE our own page,
 * so the customer never leaves our branding.
 */
export async function startCheckout(
  scope: TenantScope,
  plan: PlanKey,
  returnPath: string,
): Promise<{ clientSecret: string }> {
  if (!billingEnabled()) throw new BillingError(503, "billing_not_configured");
  const p = planFor(plan);
  const customerId = await ensureCustomer(scope);
  const priceId = await priceIdFor(p.lookupKey);
  const origin = env().APP_ORIGIN;
  const session = await stripeRequest<{ client_secret: string }>("checkout/sessions", {
    data: {
      mode: "subscription",
      // API 2026-06-24.dahlia renamed this value: "embedded" is rejected now.
      // Same rename family as Stripe.js v9's initEmbeddedCheckout ->
      // createEmbeddedCheckoutPage, so keep the two in step when upgrading.
      ui_mode: "embedded_page",
      customer: customerId,
      line_items: [{ price: priceId, quantity: 1 }],
      return_url: `${origin}${returnPath}?checkout=done&session_id={CHECKOUT_SESSION_ID}`,
      subscription_data: { metadata: { tenant_id: scope.tenantId, plan } },
      // No trial here: the tenant's 30-day trial is ours, and the 30-day
      // money-back guarantee covers the first paid month.
      allow_promotion_codes: true,
    },
  });
  return { clientSecret: session.client_secret };
}

// ------------------------------------------------------- change / cancel
export async function changePlan(
  scope: TenantScope,
  to: PlanKey,
): Promise<{ plan: PlanKey; direction: "upgrade" | "downgrade" }> {
  const row = await readRow(scope);
  if (row.plan === to) throw new BillingError(409, "already_on_plan");
  if (!row.stripe_subscription_id) throw new BillingError(409, "no_active_subscription");

  const used = await seatsUsed(scope);
  const target = PLANS[to];
  if (used > target.seatCap) {
    throw new BillingError(
      409,
      `too_many_people_for_plan:${used}>${target.seatCap}`,
    );
  }

  const sub = await stripeRequest<{ items: { data: { id: string }[] } }>(
    `subscriptions/${row.stripe_subscription_id}`,
  );
  const itemId = sub.items.data[0]?.id;
  if (!itemId) throw new BillingError(502, "subscription_item_missing");
  const priceId = await priceIdFor(target.lookupKey);
  const up = isUpgrade(row.plan, to);

  await stripeRequest(`subscriptions/${row.stripe_subscription_id}`, {
    data: {
      items: [{ id: itemId, price: priceId }],
      // Upgrading bills the difference now; downgrading credits it — either
      // way the customer pays exactly for what they used.
      proration_behavior: "create_prorations",
      cancel_at_period_end: false,
      // Keep metadata in step with the price. The webhook derives the plan
      // from the price now, but a stale copy here is exactly what caused the
      // webhook to overwrite a correct local row with the OLD plan.
      metadata: { plan: to },
    },
  });
  await withTenant(scope, async (c) => {
    await c.query(
      `UPDATE subscriptions SET plan = $1, seat_cap = $2,
              included_posts = $3, included_reels = $4, ai_budget_usd = $5,
              cancel_at_period_end = false, updated_at = now()`,
      [to, target.seatCap, target.includedPosts, target.includedReels, target.aiBudgetUsd],
    );
  });
  return { plan: to, direction: up ? "upgrade" : "downgrade" };
}

/** Cancel at period end — access continues to the date already paid for. */
export async function cancelSubscription(scope: TenantScope): Promise<{ endsOn: string | null }> {
  const row = await readRow(scope);
  if (!row.stripe_subscription_id) {
    // Trial with no card: nothing to cancel at Stripe, just mark it.
    await withTenant(scope, async (c) => {
      await c.query(`UPDATE subscriptions SET status = 'canceled', updated_at = now()`);
    });
    return { endsOn: row.trial_ends_at };
  }
  await stripeRequest(`subscriptions/${row.stripe_subscription_id}`, {
    data: { cancel_at_period_end: true },
  });
  await withTenant(scope, async (c) => {
    await c.query(
      `UPDATE subscriptions SET cancel_at_period_end = true, updated_at = now()`,
    );
  });
  return { endsOn: row.current_period_end };
}

/** One click back — no retention maze, by doctrine. */
export async function resumeSubscription(scope: TenantScope): Promise<void> {
  const row = await readRow(scope);
  if (!row.stripe_subscription_id) throw new BillingError(409, "no_active_subscription");
  await stripeRequest(`subscriptions/${row.stripe_subscription_id}`, {
    data: { cancel_at_period_end: false },
  });
  await withTenant(scope, async (c) => {
    await c.query(
      `UPDATE subscriptions SET cancel_at_period_end = false, updated_at = now()`,
    );
  });
}

/** Hard-cancel immediately — used by account deletion. */
/**
 * The Stripe ids for a tenant, read BEFORE an account purge removes the row.
 * Account deletion must purge first (the irreversible Stripe cancel goes last),
 * so it needs to capture these while they still exist.
 */
export interface StripeRef {
  subscriptionId: string | null;
}
export async function stripeRefFor(scope: TenantScope): Promise<StripeRef> {
  const row = await readRow(scope);
  return { subscriptionId: row.stripe_subscription_id };
}

/** Cancel immediately and irreversibly. Takes a ref, not a scope, because by
 *  the time account-deletion calls it the tenant's rows are already gone. */
export async function cancelSubscriptionNow(ref: StripeRef): Promise<void> {
  if (ref.subscriptionId && billingEnabled()) {
    // Deliberately NOT swallowed here: the caller decides. Account deletion
    // logs and continues (the data is already gone, which is what was asked
    // for); anything else should know the cancel failed.
    await stripeRequest(`subscriptions/${ref.subscriptionId}`, { method: "DELETE" });
  }
}

/** A short-lived portal session for card updates only (Stripe hosts the PCI
 *  surface; plan changes and cancellation stay in OUR app). */
export async function billingPortalUrl(scope: TenantScope, returnPath: string): Promise<string> {
  const customerId = await ensureCustomer(scope);
  const origin = env().APP_ORIGIN;
  const s = await stripeRequest<{ url: string }>("billing_portal/sessions", {
    data: { customer: customerId, return_url: `${origin}${returnPath}` },
  });
  return s.url;
}

// ---------------------------------------------------------------- webhook
interface StripeEvent {
  id: string;
  type: string;
  /** Stripe's own clock for the event — the only ordering signal we get. */
  created?: number;
  data: { object: Record<string, unknown> };
}

/**
 * Apply a Stripe subscription event.
 *
 * A webhook has no session, so the tenant is resolved from OUR OWN row via
 * app.tenant_by_stripe_customer() — a SECURITY DEFINER lookup that needs no
 * scope. A tenant id in the Stripe payload is never trusted, because it is
 * never read.
 *
 * Everything after that runs INSIDE that tenant's scope, so RLS applies to the
 * webhook exactly as it does to a user request and the handler physically
 * cannot write another tenant's row. (An earlier version claimed to use a
 * "privileged pool" that does not exist in this codebase; every webhook was
 * failing 42501 on billing_events. Found live 2026-07-24 — see migration 0024.)
 *
 * Replays are no-ops: the dedupe is on Stripe's own event id.
 */
export async function applyBillingEvent(event: StripeEvent): Promise<{ applied: boolean; reason?: string }> {
  const pool = getPool();

  const obj = event.data.object;
  const customerId = typeof obj.customer === "string" ? obj.customer : null;
  if (!customerId) return { applied: false, reason: "no_customer" };

  // Definer lookup: works with no session, and can only map a customer we
  // ourselves recorded.
  const t = await pool.query<{ tenant_id: string | null }>(
    `SELECT app.tenant_by_stripe_customer($1) AS tenant_id`,
    [customerId],
  );
  const tenantId = t.rows[0]?.tenant_id;
  if (!tenantId) return { applied: false, reason: "unknown_customer" };

  // The webhook principal is the system, scoped to the resolved tenant only.
  return withTenant({ uid: "system:stripe-webhook", tenantId }, async (c) => {
    /**
     * A webhook UPDATE that matches zero rows is ALWAYS a bug, and under RLS it
     * is a silent one — an unscoped write just quietly matches nothing and the
     * handler reports success. That exact shape shipped here on 2026-07-24:
     * the UPDATEs ran on the raw pool inside a scoped block, so Stripe said
     * "active" while our books said "trialing" and nothing errored. Fail loud.
     */
    const mustUpdate = async (sql: string, params: unknown[]): Promise<void> => {
      const r = await c.query(sql, params);
      if (!r.rowCount) {
        throw new BillingError(502, "billing_update_matched_no_rows");
      }
    };
    const seen = await c.query(`SELECT 1 FROM billing_events WHERE event_id = $1`, [event.id]);
    if (seen.rows.length > 0) return { applied: false, reason: "duplicate" };

    // Stripe does not guarantee ORDER. Two different, valid, non-replayed
    // events can arrive newest-first; applying the older one afterwards rolls
    // the tenant back to a stale plan or re-marks a paid account past_due.
    // Dedupe on event.id cannot catch that — these are different events.
    const eventAt = typeof event.created === "number" ? new Date(event.created * 1000) : null;
    if (eventAt) {
      const cur = await c.query<{ stale: boolean }>(
        `SELECT (last_event_at IS NOT NULL AND last_event_at > $1) AS stale
           FROM subscriptions WHERE tenant_id = $2`,
        [eventAt.toISOString(), tenantId],
      );
      if (cur.rows[0]?.stale) {
        // Still record it, so a genuine replay of THIS event stays a no-op.
        await c.query(
          `INSERT INTO billing_events (event_id, tenant_id, type) VALUES ($1,$2,$3)
           ON CONFLICT (event_id) DO NOTHING`,
          [event.id, tenantId, event.type],
        );
        return { applied: false, reason: "stale_event" };
      }
    }

    const statusMap: Record<string, string> = {
    trialing: "trialing",
    active: "active",
    past_due: "past_due",
    unpaid: "past_due",
    canceled: "canceled",
    incomplete: "past_due",
    incomplete_expired: "canceled",
  };

  if (event.type.startsWith("customer.subscription.")) {
    const status = statusMap[String(obj.status)] ?? "past_due";
    const finalStatus = event.type.endsWith("deleted") ? "canceled" : status;
    // API 2026-06-24.dahlia moved current_period_end OFF the subscription root
    // and onto the item. Reading only the root silently yielded null forever,
    // so "your plan ends on ..." rendered blank and cancel reported no date.
    // Read the item first, fall back to the root for older API versions.
    const itemPeriodEnd = (obj.items as { data?: { current_period_end?: number }[] } | undefined)
      ?.data?.[0]?.current_period_end;
    const rawPeriodEnd =
      typeof itemPeriodEnd === "number"
        ? itemPeriodEnd
        : typeof obj.current_period_end === "number"
          ? obj.current_period_end
          : null;
    const periodEnd = rawPeriodEnd !== null ? new Date(rawPeriodEnd * 1000).toISOString() : null;
    // Which plan is this, really? Derive it from the PRICE actually on the
    // subscription, not from metadata. Metadata is a copy we wrote once, and a
    // copy drifts: in the parent codebase, changing the plan swapped the price
    // but left stale plan metadata, so the webhook faithfully wrote the OLD
    // plan back and the customer was billed the new price while capped at the
    // old plan's seats. The price is the thing Stripe actually charges —
    // trust that. (Found live 2026-07-24 on the first real upgrade.)
    const lookup = ((obj.items as { data?: { price?: { lookup_key?: string } }[] } | undefined)
      ?.data?.[0]?.price?.lookup_key) ?? null;
    const planFromPrice =
      (Object.values(PLANS).find((pl) => pl.lookupKey === lookup)?.key as PlanKey | undefined) ??
      null;
    const planMeta = (obj.metadata as Record<string, string> | undefined)?.plan;
    const plan =
      planFromPrice ?? (planMeta === "start" || planMeta === "growth" ? planMeta : null);

    await mustUpdate(
      `UPDATE subscriptions
          SET stripe_subscription_id = $2,
              status = $3,
              current_period_end = COALESCE($4::timestamptz, current_period_end),
              cancel_at_period_end = $5,
              plan = COALESCE($6, plan),
              seat_cap = COALESCE($7, seat_cap),
              included_posts = COALESCE($8, included_posts),
              included_reels = COALESCE($9, included_reels),
              ai_budget_usd = COALESCE($10, ai_budget_usd),
              updated_at = now()
        WHERE tenant_id = $1`,
      [
        tenantId,
        String(obj.id),
        finalStatus,
        periodEnd,
        Boolean(obj.cancel_at_period_end),
        plan,
        plan ? PLANS[plan].seatCap : null,
        plan ? PLANS[plan].includedPosts : null,
        plan ? PLANS[plan].includedReels : null,
        plan ? PLANS[plan].aiBudgetUsd : null,
      ],
    );
  } else if (event.type === "invoice.payment_failed") {
    await mustUpdate(
      `UPDATE subscriptions SET status = 'past_due', updated_at = now() WHERE tenant_id = $1`,
      [tenantId],
    );
  } else if (event.type === "invoice.paid") {
    await mustUpdate(
      `UPDATE subscriptions SET status = 'active', updated_at = now() WHERE tenant_id = $1`,
      [tenantId],
    );
  } else {
    return { applied: false, reason: "ignored_type" };
  }

    if (eventAt) {
      await c.query(
        `UPDATE subscriptions SET last_event_at = $1 WHERE tenant_id = $2`,
        [eventAt.toISOString(), tenantId],
      );
    }
    await c.query(
      `INSERT INTO billing_events (event_id, tenant_id, type) VALUES ($1,$2,$3)
       ON CONFLICT (event_id) DO NOTHING`,
      [event.id, tenantId, event.type],
    );
    return { applied: true };
  });
}
