// The paywall's DECISION, pure and exhaustively unit-tested. No I/O here —
// paywall.ts reads the subscription row and this file answers the only
// question that matters: does this tenant get to WRITE right now?
//
// The posture is deliberate and asymmetric:
//   - READS ARE NEVER BLOCKED. The customer's data is the customer's data;
//     a lapsed card must never hold it hostage (the same doctrine as the
//     always-available export). Reads degrade to a read-only state the UI
//     announces honestly via /api/me.
//   - WRITES require a subscription in good standing: active, a trial that
//     has not ended, or past_due within a 7-day grace window (card failures
//     are usually an expiry date, not a decision — grace turns "your card
//     expired so we froze you mid-week" into "update it when you get a
//     minute").

export type SubscriptionStatus = "trialing" | "active" | "past_due" | "canceled";

/** The slice of the subscriptions row the gate needs, ISO strings as stored. */
export interface GateRow {
  status: string;
  trialEndsAt: string | null;
  currentPeriodEnd: string | null;
  /** Fallback grace anchor when a past_due row has no period end on record. */
  updatedAt: string | null;
}

export type AccessState = "full" | "read_only";

export interface SubscriptionAccess {
  state: AccessState;
  /** Why — a stable machine reason the UI turns into a sentence. */
  reason:
    | "active"
    | "trialing"
    | "trial_expired"
    | "past_due_grace"
    | "past_due_lapsed"
    | "canceled"
    | "unknown_status";
  /** When full access ends/ended (ISO), when the row can say. */
  until: string | null;
}

export const PAST_DUE_GRACE_DAYS = 7;
const GRACE_MS = PAST_DUE_GRACE_DAYS * 24 * 60 * 60 * 1000;

/** Parse an ISO-ish timestamp; null and garbage both come back null. */
function ts(value: string | null): number | null {
  if (!value) return null;
  const t = Date.parse(value);
  return Number.isNaN(t) ? null : t;
}

export function subscriptionAccess(row: GateRow, now: Date = new Date()): SubscriptionAccess {
  const t = now.getTime();

  switch (row.status) {
    case "active":
      return { state: "full", reason: "active", until: row.currentPeriodEnd };

    case "trialing": {
      const end = ts(row.trialEndsAt);
      // A trialing row with no end date is a data bug, and the gate fails
      // CLOSED on it — an unreadable clock must not become a free plan.
      if (end !== null && end > t) {
        return { state: "full", reason: "trialing", until: row.trialEndsAt };
      }
      return { state: "read_only", reason: "trial_expired", until: row.trialEndsAt };
    }

    case "past_due": {
      // Grace runs from the end of the period the failed payment was FOR;
      // when Stripe never told us a period end, from the moment the row
      // flipped (updated_at). No anchor at all fails closed.
      const anchor = ts(row.currentPeriodEnd) ?? ts(row.updatedAt);
      if (anchor !== null && t < anchor + GRACE_MS) {
        return {
          state: "full",
          reason: "past_due_grace",
          until: new Date(anchor + GRACE_MS).toISOString(),
        };
      }
      return { state: "read_only", reason: "past_due_lapsed", until: null };
    }

    case "canceled":
      return { state: "read_only", reason: "canceled", until: null };

    default:
      // A status this code has never heard of gets no write access. The
      // CHECK constraint makes this unreachable today; the day a migration
      // adds a status, this line makes forgetting the gate a loud failure
      // instead of a silent free plan.
      return { state: "read_only", reason: "unknown_status", until: null };
  }
}
