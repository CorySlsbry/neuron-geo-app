// billing module — public port.
//
// The SaaS subscription (distinct from customer invoices, which live in
// sales-invoicing). Two flat plans, no per-head fee. Checkout is EMBEDDED
// so the customer never leaves our branding; upgrade, downgrade, and cancel
// all happen inside the app with no retention maze; the webhook resolves
// the tenant from our own row, never from the payload. Fails closed
// without keys.
import "server-only";

export {
  checkSeat,
  explainSubscription,
  isUpgrade,
  PLAN_LIST,
  PLANS,
  planFor,
} from "./internal/plans";
export type { Plan, PlanKey, SeatCheck } from "./internal/plans";

export { BillingError, billingEnabled, publishableKey } from "./internal/stripe-api";

export { verifyStripeSignature } from "./internal/webhook-verify";

export {
  applyBillingEvent,
  assertSeatAvailable,
  billingPortalUrl,
  cancelSubscription,
  cancelSubscriptionNow,
  stripeRefFor,
  changePlan,
  getSubscription,
  resumeSubscription,
  startCheckout,
} from "./internal/store";
export type { SubscriptionState } from "./internal/store";
