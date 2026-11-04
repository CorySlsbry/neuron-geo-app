import "server-only";
import { createHmac, timingSafeEqual } from "node:crypto";

// Relocated verbatim from sales-invoicing/internal/stripe.ts when the
// construction domain was stripped (P0 fork): the billing webhook was already
// the second consumer, and the helper has no domain in it — it verifies a
// Stripe signature header against our webhook secret(s), constant-time.

/** Verify Stripe's webhook signature (t + v1 HMAC scheme), constant-time.
 *
 * ⛔ STRIPE_WEBHOOK_SECRET MAY HOLD SEVERAL SECRETS, COMMA-SEPARATED. Stripe
 * issues each webhook ENDPOINT its own whsec. One env var per endpoint
 * would work too, but a single list keeps rotation one operation and means
 * a second endpoint someday is config, not code.
 */
export function verifyStripeSignature(payload: string, header: string | null): boolean {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret || !header) return false;
  const secrets = secret.split(",").map((s) => s.trim()).filter(Boolean);
  if (secrets.length === 0) return false;
  // During a webhook-secret rotation Stripe signs with BOTH secrets and sends
  // several `v1=` values in one header. Object.fromEntries kept only the last
  // one, so if our secret produced any but the last signature every event was
  // rejected — an availability failure during exactly the maintenance window
  // where you least want billing events to stop applying. Collect all
  // candidates.
  let t: string | undefined;
  const candidates: string[] = [];
  for (const part of header.split(",")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    const k = part.slice(0, eq).trim();
    const v = part.slice(eq + 1).trim();
    if (k === "t") t = v;
    else if (k === "v1") candidates.push(v);
  }
  if (!t || candidates.length === 0) return false;
  // Tolerance: 5 minutes, binding the timestamp per the plan.
  if (Math.abs(Date.now() / 1000 - Number(t)) > 300) return false;
  // No early return: compare every candidate against every secret so the
  // work done does not depend on WHICH signature matched, or which secret.
  let ok = false;
  for (const s of secrets) {
    const expected = createHmac("sha256", s).update(`${t}.${payload}`).digest("hex");
    const b = Buffer.from(expected);
    for (const candidate of candidates) {
      const a = Buffer.from(candidate);
      if (a.length === b.length && timingSafeEqual(a, b)) ok = true;
    }
  }
  return ok;
}
