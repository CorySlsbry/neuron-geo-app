import { NextResponse, type NextRequest } from "next/server";
import { clientKey, consume } from "@/lib/rate-limit";

/**
 * Per-request security headers (Next 16 `proxy` convention, formerly
 * `middleware`). The nonce-based Content-Security-Policy is set here — a nonce
 * cannot be a static header. Next reads the nonce from the request-side CSP
 * header and stamps it onto its own inline scripts.
 *
 * CSP posture: default-src 'self'; scripts locked to a per-request nonce +
 * 'strict-dynamic'; frame-ancestors 'none' (clickjacking); object-src 'none'.
 */
/**
 * Same-site check for state-changing requests — the login-CSRF defence.
 *
 * SameSite=Lax does NOT cover this. Lax governs whether an EXISTING cookie is
 * ATTACHED to a cross-site request; it says nothing about a cross-site POST
 * that makes us SET a new cookie. A login endpoint doesn't read an ambient
 * cookie, so Lax protects it not at all.
 *
 * The attack it stops: an attacker auto-submits a form to /api/auth/login
 * carrying THEIR OWN valid id token. `enctype="text/plain"` is CORS-safelisted,
 * so no preflight and no CORS block, and the classic name/value split
 * serialises to valid JSON. The victim's browser stores a session for the
 * ATTACKER's uid; the victim then types their real company and financial data
 * into a tenant the attacker owns. Verification is not the weak point — the
 * token is genuine.
 *
 * Webhooks are exempt because they are legitimately cross-site and are
 * authenticated by an HMAC signature over the raw body instead.
 */
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

function sameSiteViolation(request: NextRequest): boolean {
  if (SAFE_METHODS.has(request.method)) return false;
  // Signed webhooks authenticate themselves; they have no browser origin.
  if (request.nextUrl.pathname.startsWith("/api/webhooks/")) return false;

  // Fetch metadata is the strongest signal and is sent by every current
  // browser. "none" = typed in the address bar / bookmark.
  const site = request.headers.get("sec-fetch-site");
  if (site) return site !== "same-origin" && site !== "none";

  // Fallback for clients that omit Fetch metadata: compare Origin to Host.
  // A form POST from another site always carries an Origin.
  const origin = request.headers.get("origin");
  if (!origin) {
    // Neither signal present: BLOCK. This used to return false — "probably
    // curl, let it through" — which is a default-open decision made on an
    // absence of evidence. Every current browser sends Sec-Fetch-Site, so a
    // state-changing request carrying neither header is either a very old
    // client or something not worth trusting, and the ambient-cookie case
    // (login CSRF) is exactly the one this function exists to stop.
    //
    // Server-to-server callers that legitimately send neither belong in the
    // /api/webhooks/ exemption above, where they are authenticated by an HMAC
    // rather than by the shape of their headers.
    return true;
  }
  try {
    return new URL(origin).host !== request.headers.get("host");
  } catch {
    return true; // unparseable Origin is not something to reason about
  }
}

/**
 * Limits for the unauthenticated edges — the only surfaces reachable without
 * a session, and therefore the only ones a stranger can spend our resources on.
 *
 * Numbers chosen against real use, not round-number instinct: a business
 * signs up once; a person mistypes a password a handful of times, not sixty.
 */
const LIMITS: {
  prefix: string;
  limit: number;
  windowMs: number;
  /**
   * Also limit GET/HEAD. Off by default because a read is cheap and a busy
   * office shares one IP — reserved for any future PUBLIC read that runs
   * real queries against a named tenant.
   */
  includeSafe?: boolean;
}[] = [
  // Each call provisions a tenant (tenant + owner membership + trial row).
  { prefix: "/api/auth/signup", limit: 5, windowMs: 60 * 60_000 },
  // Slow password guessing. Identity Platform rate-limits its own side too;
  // this covers the session-minting half that lives here.
  { prefix: "/api/auth/login", limit: 20, windowMs: 5 * 60_000 },
  // Invite tokens are 256-bit so guessing is hopeless at ANY rate — this
  // bound exists so nobody gets to run the experiment on our database.
  // (Account signup / password reset have no server edge to limit here:
  // those calls go browser → Google, which enforces its own quotas.)
  { prefix: "/api/invites/accept", limit: 20, windowMs: 5 * 60_000 },
];

export function proxy(request: NextRequest): NextResponse {
  if (sameSiteViolation(request)) {
    return NextResponse.json(
      { error: { code: "cross_site_request_blocked", message: "cross_site_request_blocked" } },
      { status: 403 },
    );
  }

  // Rate limiting runs after the same-site check (cheaper to reject outright)
  // and only on the unauthenticated edges. Authenticated surfaces are bounded
  // by having a real account behind them; adding a limiter there would mostly
  // punish a busy office sharing one IP.
  const path = request.nextUrl.pathname;
  const rule = LIMITS.find((r) => path.startsWith(r.prefix));
  if (rule && (rule.includeSafe || !SAFE_METHODS.has(request.method))) {
    const { allowed, retryAfter } = consume(
      `${rule.prefix}:${clientKey(request.headers)}`,
      rule,
    );
    if (!allowed) {
      return NextResponse.json(
        { error: { code: "rate_limited", message: "rate_limited" } },
        { status: 429, headers: { "Retry-After": String(retryAfter) } },
      );
    }
  }

  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  const nonce = btoa(String.fromCharCode(...bytes));

  const isDev = process.env.NODE_ENV !== "production";
  const scriptSrc = [
    "'self'",
    `'nonce-${nonce}'`,
    "'strict-dynamic'",
    // HMR/eval is only needed by the dev server.
    isDev ? "'unsafe-eval'" : "",
  ]
    .filter(Boolean)
    .join(" ");

  const csp = [
    "default-src 'self'",
    `script-src ${scriptSrc} https://js.stripe.com`,
    // Stylesheets and <style> elements stay nonce-locked.
    `style-src 'self' 'nonce-${nonce}'`,
    /**
     * ⛔ style ATTRIBUTES are a separate directive, and without this line the
     * application renders wrong in every browser that enforces CSP.
     *
     * A nonce cannot be attached to a `style="…"` attribute — there is nowhere
     * to put it — so a nonce-only `style-src` blocks EVERY inline style. When
     * `style-src-attr` is absent it falls back to `style-src`, which is what
     * was happening here: several hundred React `style={{}}` props across every
     * screen were being parsed and then discarded. Verified in a browser
     * against a live page — the attribute was present in the DOM and
     * `el.style.length` was 0.
     *
     * It does not fail loudly. Class-based layout still works, so pages look
     * *mostly* right and quietly lose their spacing, their progress-bar widths,
     * their skeleton dimensions and their red/green money colours.
     *
     * `style-src-attr 'unsafe-inline'` is the narrow fix, not a loosening of
     * the policy: scripts, stylesheets and <style> blocks are untouched, and
     * the only new capability is setting a style attribute — which requires
     * DOM-injection an attacker does not have, since React escapes everything
     * it renders. The alternative is converting ~370 inline styles to classes,
     * which is a real project and does not make the product any safer.
     */
    "style-src-attr 'unsafe-inline'",
    "img-src 'self' data: blob: https://*.stripe.com",
    "font-src 'self'",
    // identitytoolkit: the browser signs in against Google directly, so the
    // user's password never reaches our servers. That is the whole reason this
    // entry exists — see lib/client/identity.ts.
    "connect-src 'self' https://api.stripe.com https://checkout.stripe.com https://identitytoolkit.googleapis.com https://securetoken.googleapis.com",
    // Stripe's embedded checkout runs in an iframe it serves itself.
    "frame-src https://js.stripe.com https://checkout.stripe.com https://hooks.stripe.com",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "upgrade-insecure-requests",
  ].join("; ");

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set("content-security-policy", csp);

  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set("content-security-policy", csp);
  response.headers.set("x-frame-options", "DENY");
  response.headers.set("x-content-type-options", "nosniff");
  response.headers.set("referrer-policy", "strict-origin-when-cross-origin");
  response.headers.set(
    "strict-transport-security",
    "max-age=63072000; includeSubDomains; preload",
  );
  response.headers.set(
    "permissions-policy",
    "camera=(), microphone=(), geolocation=(), browsing-topics=()",
  );
  return response;
}

export const config = {
  // Run on everything except Next's static assets and the favicon.
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
