// Tiny client-side fetch helper (client components only — no server imports).

/**
 * Codes that deserve a sentence rather than a machine string. A page that
 * renders `e.message` gets plain language for free; pages that switch on
 * `e.code` are unaffected.
 */
const HUMAN: Record<string, string> = {
  aal2_required:
    "This one needs 2-step verification. Turn it on under Sign-in security, then try again.",
  department_forbidden:
    "You don't have access to this part of the business. Ask the owner to give you access.",
  role_forbidden: "Your account can't make this change.",
  not_a_member: "You're not a member of this business anymore.",
  no_active_tenant: "Pick a business first.",
  seat_limit:
    "You've used every seat on your plan. Upgrade to add more people.",
  subscription_required:
    "Your workspace is read-only right now. Head to Billing to bring it back.",
};

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
  ) {
    super(HUMAN[code] ?? code);
  }
}

/**
 * Fired when the server says an action needs a second factor. AppShell listens
 * and shows one banner with the way out — otherwise every page would have to
 * special-case a condition that is really about the ACCOUNT, not the page.
 */
export const STEP_UP_EVENT = "tb:aal2-required";

/**
 * A key for one user INTENTION, stable across retries of that intention.
 *
 * Generate it when the action starts (not per fetch), hold it until the call
 * succeeds, and pass it to every attempt. That is what makes a retry after a
 * timeout safe: the server recognises the second attempt as the same intention
 * and replays the first response instead of doing the work twice.
 */
export function newIdempotencyKey(): string {
  return crypto.randomUUID();
}

/**
 * In-flight requests, keyed by method + path + body.
 *
 * This is the cheap half of double-submit protection and it needs no
 * per-call discipline: while a mutation is genuinely in flight, an identical
 * one reuses the same promise instead of hitting the network twice. It kills
 * the double-tap — the overwhelmingly common case — for every route at once.
 *
 * It deliberately does NOT dedupe repeats that happen sequentially. Adding the
 * same $50 material cost to a job twice on purpose is legitimate and must keep
 * working; those calls do not overlap, so they never collide here.
 *
 * The server-side Idempotency-Key handles the case this cannot: a retry after
 * the first response was lost, where the work may already have happened.
 */
const inFlight = new Map<string, Promise<unknown>>();

export async function api<T>(
  path: string,
  init?: RequestInit & { json?: unknown; idempotencyKey?: string },
): Promise<T> {
  const { json, idempotencyKey, ...rest } = init ?? {};
  const method = (rest.method ?? "GET").toUpperCase();
  const mutating = method !== "GET" && method !== "HEAD";

  if (mutating) {
    const sig = `${method} ${path} ${json !== undefined ? JSON.stringify(json) : ""}`;
    const existing = inFlight.get(sig);
    if (existing) return existing as Promise<T>;
    const p = send<T>(path, method, json, idempotencyKey, rest).finally(() => {
      inFlight.delete(sig);
    });
    inFlight.set(sig, p);
    return p;
  }
  return send<T>(path, method, json, idempotencyKey, rest);
}

async function send<T>(
  path: string,
  method: string,
  json: unknown,
  idempotencyKey: string | undefined,
  rest: RequestInit,
): Promise<T> {
  const res = await fetch(path, {
    ...rest,
    headers: {
      ...(json !== undefined ? { "content-type": "application/json" } : {}),
      ...(idempotencyKey ? { "idempotency-key": idempotencyKey } : {}),
      ...rest.headers,
    },
    body: json !== undefined ? JSON.stringify(json) : rest.body,
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as {
      error?: { code?: string };
    } | null;
    const code = body?.error?.code ?? `http_${res.status}`;
    if (code === "aal2_required" && typeof window !== "undefined") {
      window.dispatchEvent(new CustomEvent(STEP_UP_EVENT));
    }
    throw new ApiError(res.status, code);
  }
  return (await res.json()) as T;
}

/** Plain formatting for cents → "$1,234.56" (display only — never math). */
export function dollars(cents: number): string {
  return (cents / 100).toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
  });
}

/**
 * A typed dollar amount → integer cents, or null if it isn't a number.
 *
 * Deliberately NOT `Math.round(parseFloat(x) * 100)`. That is the standard way
 * money picks up binary drift — `parseFloat("11.29") * 100` is 1128.9999…, and
 * on some values the rounding lands a cent low. Everything downstream of this
 * (the ledger, job costing, the tax engine) is integer cents on purpose; the
 * moment a float touches the amount that guarantee is gone.
 *
 * Splits on the decimal point instead and rounds HALF-UP at the third digit,
 * matching the server's rounding rule.
 *
 * Forgiving about how people actually type: "$11,000", "11000.5", " 250 ".
 */
export function centsFromInput(raw: string): number | null {
  const s = raw.replace(/[$,\s]/g, "");
  if (s === "" || s === "." || !/^\d*\.?\d*$/.test(s)) return null;
  const [whole = "", frac = ""] = s.split(".");
  let cents = Number(whole || "0") * 100 + Number((frac + "00").slice(0, 2));
  if (frac.length > 2 && Number(frac[2]) >= 5) cents += 1; // half-up
  return Number.isSafeInteger(cents) ? cents : null;
}
