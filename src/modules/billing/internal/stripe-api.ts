import "server-only";
import { HttpError } from "@/lib/http/errors";

// Thin Stripe REST client for the SaaS-billing side. Raw fetch (no SDK
// dependency), key-gated, fails closed. Prices are resolved by lookup_key
// so no price id is ever hardcoded and test/live behave identically.

export class BillingError extends HttpError {
  constructor(status: 400 | 402 | 403 | 404 | 409 | 422 | 502 | 503, code: string) {
    super(status, code);
  }
}

export function billingEnabled(): boolean {
  return Boolean(process.env.STRIPE_SECRET_KEY);
}

function key(): string {
  const k = process.env.STRIPE_SECRET_KEY;
  if (!k) throw new BillingError(503, "billing_not_configured");
  return k;
}

/** Form-encode nested params the way Stripe expects (a[b][c]=v). */
function encode(data: Record<string, unknown>, prefix = ""): string[] {
  const out: string[] = [];
  for (const [k, v] of Object.entries(data)) {
    if (v === undefined || v === null) continue;
    const name = prefix ? `${prefix}[${k}]` : k;
    if (typeof v === "object" && !Array.isArray(v)) {
      out.push(...encode(v as Record<string, unknown>, name));
    } else if (Array.isArray(v)) {
      v.forEach((item, i) => {
        if (typeof item === "object") {
          out.push(...encode(item as Record<string, unknown>, `${name}[${i}]`));
        } else {
          out.push(`${encodeURIComponent(`${name}[${i}]`)}=${encodeURIComponent(String(item))}`);
        }
      });
    } else {
      out.push(`${encodeURIComponent(name)}=${encodeURIComponent(String(v))}`);
    }
  }
  return out;
}

export async function stripeRequest<T>(
  path: string,
  opts: { method?: "GET" | "POST" | "DELETE"; data?: Record<string, unknown>; idempotencyKey?: string } = {},
): Promise<T> {
  const method = opts.method ?? (opts.data ? "POST" : "GET");
  const headers: Record<string, string> = {
    Authorization: `Bearer ${key()}`,
    "Content-Type": "application/x-www-form-urlencoded",
  };
  if (opts.idempotencyKey) headers["Idempotency-Key"] = opts.idempotencyKey;
  const res = await fetch(`https://api.stripe.com/v1/${path}`, {
    method,
    headers,
    body: opts.data ? encode(opts.data).join("&") : undefined,
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as {
      error?: { code?: string; message?: string; param?: string; type?: string };
    };
    // Stripe's `message` is the only part that says what actually went wrong.
    // It never reaches the client (the thrown code is deliberately opaque),
    // but swallowing it entirely makes every failure look identical in the
    // logs — which cost real debugging time on 2026-07-24.
    console.error("[stripe] %s %s -> %d %s", method, path, res.status, {
      type: body.error?.type,
      code: body.error?.code,
      param: body.error?.param,
      message: body.error?.message,
    });
    throw new BillingError(502, `stripe:${res.status}:${body.error?.code ?? "unknown"}`);
  }
  return (await res.json()) as T;
}

/** Resolve a price id from its lookup_key. Cached per process — price ids
 *  don't change during a deployment's life. */
const priceCache = new Map<string, string>();

export async function priceIdFor(lookupKey: string): Promise<string> {
  const hit = priceCache.get(lookupKey);
  if (hit) return hit;
  const r = await stripeRequest<{ data: { id: string }[] }>(
    `prices?lookup_keys[]=${encodeURIComponent(lookupKey)}&active=true&limit=1`,
  );
  const id = r.data[0]?.id;
  if (!id) throw new BillingError(503, `price_not_found:${lookupKey}`);
  priceCache.set(lookupKey, id);
  return id;
}

export function publishableKey(): string | null {
  return process.env.STRIPE_PUBLISHABLE_KEY ?? null;
}
