import "server-only";
import { withTenant } from "@/lib/db/tenant";
import { subscriptionAccess, type SubscriptionAccess } from "./subscription-gate";

/**
 * Read the tenant's subscription row and answer the gate question. Lives in
 * auth-tenancy (not billing) because requireScope is the caller: the paywall
 * is an AUTHORIZATION concern, and this module already owns the row's
 * creation (signup inserts the trial). Raw SQL on the shared table, same as
 * signup — the billing MODULE stays about Stripe.
 */
export async function resolveSubscriptionAccess(
  uid: string,
  tenantId: string,
): Promise<SubscriptionAccess> {
  interface Row {
    status: string;
    trial_ends_at: string | null;
    current_period_end: string | null;
    updated_at: string | null;
  }
  const row = await withTenant({ uid, tenantId }, async (c) => {
    const { rows } = await c.query<Row>(
      `SELECT status, trial_ends_at::text AS trial_ends_at,
              current_period_end::text AS current_period_end,
              updated_at::text AS updated_at
         FROM subscriptions WHERE tenant_id = $1`,
      [tenantId],
    );
    if (rows[0]) return rows[0];
    // Self-heal, identical to billing's readRow: a tenant that somehow has no
    // subscription row starts its 30-day trial NOW rather than being locked
    // read-only by an absence. Fail-closed applies to unreadable STATE, not
    // to a brand-new tenant that never got its row.
    const ins = await c.query<Row>(
      `INSERT INTO subscriptions (tenant_id, plan, seat_cap, status, trial_ends_at)
       VALUES ($1,'start',2,'trialing', now() + interval '30 days')
       ON CONFLICT (tenant_id) DO UPDATE SET updated_at = now()
       RETURNING status, trial_ends_at::text AS trial_ends_at,
                 current_period_end::text AS current_period_end,
                 updated_at::text AS updated_at`,
      [tenantId],
    );
    return ins.rows[0]!;
  });
  return subscriptionAccess({
    status: row.status,
    trialEndsAt: row.trial_ends_at,
    currentPeriodEnd: row.current_period_end,
    updatedAt: row.updated_at,
  });
}
