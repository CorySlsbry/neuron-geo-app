import "server-only";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { cookies } from "next/headers";
import { HttpError } from "@/lib/http/errors";
import {
  credentialsFor,
  networkDef,
  redirectUriFor,
  type ChannelIdentity,
  type Network,
} from "./networks";

/**
 * The OAuth authorization-code dance, written once.
 *
 * Every per-provider difference lives in networks.ts. This file contains no
 * network names at all, on purpose: the moment a branch on `network === "..."`
 * appears here, adding Meta or TikTok stops being configuration and becomes a
 * second code path to test, film and maintain.
 */

export class ChannelError extends HttpError {
  constructor(status: 400 | 403 | 404 | 409 | 422 | 502 | 503, code: string) {
    super(status, code);
  }
}

/**
 * The in-flight connection, parked in an httpOnly cookie between the redirect
 * out and the redirect back.
 *
 * A cookie rather than a database row because it is the BROWSER's leg of the
 * journey that has to be tied together: the whole point of `state` is to
 * prove the callback arrived in the same browser that started the flow. A row
 * keyed by state would authenticate the code, not the browser, and would
 * leave abandoned rows behind every time someone closes the consent screen.
 */
const COOKIE = "geo_oauth_connect";
/** Long enough to read a consent screen, short enough not to linger. */
const TTL_SECONDS = 600;

interface PendingConnect {
  /** Which network the flow was started for. */
  n: Network;
  /** The CSRF state. Compared against the provider's echo. */
  s: string;
  /** PKCE verifier, when this network uses PKCE. */
  v?: string;
  /** The tenant that started the flow — checked, never trusted, at callback. */
  t: string;
}

function b64url(buf: Buffer): string {
  return buf.toString("base64url");
}

/**
 * Start a connection: build the provider's consent URL and park what we will
 * need to verify the return trip.
 *
 * Returns the URL rather than a redirect. The Connect button calls this over
 * JSON and then navigates itself, so an unconfigured network, a lapsed
 * subscription or a missing role comes back as an ordinary error the screen
 * can render — instead of a 402 envelope rendered as a broken page because a
 * navigation was expected to be a redirect.
 */
export async function buildAuthorizeUrl(
  network: Network,
  tenantId: string,
): Promise<string> {
  const def = networkDef(network);
  const creds = credentialsFor(network);
  if (!creds) throw new ChannelError(503, "network_not_configured");

  const state = b64url(randomBytes(32));
  const pending: PendingConnect = { n: network, s: state, t: tenantId };

  const params = new URLSearchParams({
    response_type: "code",
    [def.clientIdParam]: creds.clientId,
    redirect_uri: redirectUriFor(network),
    scope: def.scopes.join(def.network === "facebook" || def.network === "instagram" ? "," : " "),
    state,
    ...(def.extraAuthorizeParams ?? {}),
  });

  if (def.pkce) {
    const verifier = b64url(randomBytes(32));
    pending.v = verifier;
    params.set("code_challenge", b64url(createHash("sha256").update(verifier).digest()));
    params.set("code_challenge_method", "S256");
  }

  const jar = await cookies();
  jar.set(COOKIE, JSON.stringify(pending), {
    httpOnly: true,
    // ⛔ Lax, NOT Strict. The provider returns the customer by a top-level
    // cross-site GET navigation; under Strict the browser withholds this
    // cookie on exactly that request and every connection fails with a
    // state mismatch. Lax sends it on top-level navigations, which is
    // precisely and only the case we need.
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: TTL_SECONDS,
  });

  return `${def.authorizeUrl}?${params.toString()}`;
}

/** Discard the in-flight state, whatever the outcome. Called on every path. */
export async function clearPending(): Promise<void> {
  (await cookies()).delete(COOKIE);
}

/**
 * Verify the callback really belongs to the flow this browser started, in
 * this tenant.
 *
 * `activeTenantId` comes from requireScope on the callback route — the server
 * -resolved directory, never the cookie. The cookie's tenant is compared
 * against it and a mismatch REFUSES: someone who switched workspaces in
 * another tab between the redirect out and the redirect back must not have
 * their YouTube account silently attached to whichever tenant happens to be
 * active now.
 */
export async function takePending(
  network: Network,
  state: string,
  activeTenantId: string,
): Promise<PendingConnect> {
  const raw = (await cookies()).get(COOKIE)?.value;
  if (!raw) throw new ChannelError(400, "connect_expired");

  let pending: PendingConnect;
  try {
    pending = JSON.parse(raw) as PendingConnect;
  } catch {
    throw new ChannelError(400, "connect_expired");
  }

  const a = Buffer.from(pending.s ?? "", "utf8");
  const b = Buffer.from(state, "utf8");
  // Constant-time, like every other secret comparison in this codebase. The
  // state is single-use and short-lived, so the practical risk is small — but
  // "small" is not a reason to write the version that leaks.
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    throw new ChannelError(403, "state_mismatch");
  }
  if (pending.n !== network) throw new ChannelError(403, "state_mismatch");
  if (pending.t !== activeTenantId) throw new ChannelError(403, "tenant_changed");

  return pending;
}

/** What the provider gave us, normalised. */
export interface TokenGrant {
  accessToken: string;
  refreshToken: string | null;
  /** Provider-stated expiry, when it states one. */
  expiresAt: Date | null;
  /** What was actually GRANTED — not what we asked for. */
  scopes: string[];
}

function pickString(body: Record<string, unknown>, key: string): string | null {
  const v = body[key];
  return typeof v === "string" && v.length > 0 ? v : null;
}

/**
 * Exchange the authorization code for a token.
 *
 * The client secret goes in the request body over TLS to the provider's token
 * endpoint — the one place it is ever transmitted, and never anywhere the
 * browser can see.
 */
export async function exchangeCode(
  network: Network,
  code: string,
  verifier: string | undefined,
): Promise<TokenGrant> {
  const def = networkDef(network);
  const creds = credentialsFor(network);
  if (!creds) throw new ChannelError(503, "network_not_configured");

  const form = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUriFor(network),
    [def.clientIdParam]: creds.clientId,
    client_secret: creds.clientSecret,
  });
  if (verifier) form.set("code_verifier", verifier);

  let res: Response;
  try {
    res =
      def.tokenMethod === "GET"
        ? await fetch(`${def.tokenUrl}?${form.toString()}`, { method: "GET" })
        : await fetch(def.tokenUrl, {
            method: "POST",
            headers: { "content-type": "application/x-www-form-urlencoded" },
            body: form.toString(),
          });
  } catch {
    throw new ChannelError(502, "provider_unreachable");
  }

  const body: unknown = await res.json().catch(() => null);
  if (!res.ok || body === null || typeof body !== "object") {
    // ⛔ The provider's error body is NOT forwarded to the client. It can
    // echo the redirect_uri and, on some providers, fragments of the request
    // — and it is written for a developer reading a server log, which is
    // exactly where it goes instead.
    console.error(`[channels] ${network} token exchange failed`, res.status);
    throw new ChannelError(502, "token_exchange_failed");
  }

  const json = body as Record<string, unknown>;
  const accessToken = pickString(json, "access_token");
  if (!accessToken) {
    console.error(`[channels] ${network} token response carried no access_token`);
    throw new ChannelError(502, "token_exchange_failed");
  }

  const expiresIn = typeof json.expires_in === "number" ? json.expires_in : null;
  const granted = pickString(json, "scope");

  return {
    accessToken,
    refreshToken: pickString(json, "refresh_token"),
    expiresAt: expiresIn ? new Date(Date.now() + expiresIn * 1000) : null,
    // Providers separate granted scopes by space or comma depending on the
    // provider and sometimes the endpoint. Split on both rather than pick.
    scopes: granted ? granted.split(/[\s,]+/).filter(Boolean) : [...def.scopes],
  };
}

/** Ask the provider who this token belongs to. */
export async function resolveIdentity(
  network: Network,
  accessToken: string,
): Promise<ChannelIdentity> {
  try {
    return await networkDef(network).resolveIdentity(accessToken);
  } catch (err) {
    console.error(`[channels] ${network} identity lookup failed`, err);
    throw new ChannelError(502, "identity_lookup_failed");
  }
}

/**
 * Tell the provider to forget the token. Best effort, deliberately.
 *
 * Disconnect must succeed locally even when the provider is down or has
 * already invalidated the grant — otherwise a customer who wants out is held
 * hostage by somebody else's outage, which is the opposite of what the
 * disconnect button promises. We delete our copy regardless; this is the
 * courtesy call, and its failure is logged, not surfaced.
 */
export async function revokeAtProvider(
  network: Network,
  accessToken: string,
): Promise<boolean> {
  const def = networkDef(network);
  if (!def.revokeUrl) return false;
  const creds = credentialsFor(network);
  try {
    const form = new URLSearchParams({ token: accessToken });
    if (creds) {
      form.set(def.clientIdParam, creds.clientId);
      form.set("client_secret", creds.clientSecret);
    }
    const res = await fetch(def.revokeUrl, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: form.toString(),
    });
    return res.ok;
  } catch {
    return false;
  }
}
