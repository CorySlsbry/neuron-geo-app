/**
 * A small in-process token bucket for the unauthenticated edges.
 *
 * ⚠️ Read this before trusting it: the counter lives in ONE Cloud Run
 * instance's memory. With N instances the effective ceiling is N x the limit,
 * and a cold start resets it. That is a real weakness and it is deliberate —
 * the alternative (Redis/Memorystore, or Cloud Armor rules) is infrastructure
 * this product does not yet run, and shipping nothing while waiting for it is
 * strictly worse than shipping a bound that is merely imperfect.
 *
 * What it does buy, today:
 *   - the public intake form cannot be used to insert unbounded rows into a
 *     named victim tenant (the slug is public, the honeypot is one field, and
 *     `external_id` comes from a caller-chosen nonce so idempotency imposes no
 *     ceiling at all);
 *   - /api/auth/signup cannot be looped to provision tenants, each of which
 *     seeds 478 chart-of-accounts rows and a trial row;
 *   - password guessing against /api/auth/login is slowed well below useful.
 *
 * When Memorystore or Cloud Armor lands, replace the Map — the call sites and
 * the limits stay exactly as they are.
 */

interface Bucket {
  tokens: number;
  updatedAt: number;
}

const buckets = new Map<string, Bucket>();

/** Bound the map so a flood of distinct keys cannot become the memory leak. */
const MAX_KEYS = 20_000;

export interface RateLimit {
  /** Sustained requests per window. */
  limit: number;
  /** Window length in milliseconds. */
  windowMs: number;
}

export interface RateLimitResult {
  allowed: boolean;
  /** Seconds until the caller should try again (for Retry-After). */
  retryAfter: number;
}

/**
 * Consume one token for `key`. Refills continuously rather than in fixed
 * windows, so a caller cannot burst the full limit twice across a boundary.
 */
export function consume(key: string, { limit, windowMs }: RateLimit): RateLimitResult {
  const now = Date.now();

  if (buckets.size > MAX_KEYS) {
    // Cheapest correct thing: drop everything and start over. Every bucket is
    // at most `windowMs` old, so the worst case is one extra window of slack
    // for callers that were already mid-window.
    buckets.clear();
  }

  const refillPerMs = limit / windowMs;
  const b = buckets.get(key);
  if (!b) {
    buckets.set(key, { tokens: limit - 1, updatedAt: now });
    return { allowed: true, retryAfter: 0 };
  }

  b.tokens = Math.min(limit, b.tokens + (now - b.updatedAt) * refillPerMs);
  b.updatedAt = now;

  if (b.tokens < 1) {
    return { allowed: false, retryAfter: Math.ceil((1 - b.tokens) / refillPerMs / 1000) };
  }
  b.tokens -= 1;
  return { allowed: true, retryAfter: 0 };
}

/**
 * Best-effort client identity for rate limiting.
 *
 * `x-forwarded-for` is client-controlled in general, but on Cloud Run behind
 * Google's load balancer the LAST entry is appended by infrastructure the
 * caller cannot forge — so we take from the right, not the left. Getting this
 * backwards is the classic way to build a limiter that anyone can bypass with
 * a header.
 */
export function clientKey(headers: Headers): string {
  const xff = headers.get("x-forwarded-for");
  if (xff) {
    const parts = xff.split(",").map((p) => p.trim()).filter(Boolean);
    const last = parts[parts.length - 1];
    if (last) return last;
  }
  return headers.get("x-real-ip") ?? "unknown";
}

/** Reset — tests only. */
export function __resetRateLimits(): void {
  buckets.clear();
}
