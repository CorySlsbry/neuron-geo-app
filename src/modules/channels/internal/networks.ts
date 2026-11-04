import "server-only";
import { env } from "@/env";
import { sealingAvailable } from "./crypto";

/**
 * Every network is CONFIGURATION, not code.
 *
 * The OAuth dance is identical everywhere — redirect with a state, get a code
 * back, POST it for a token, ask who the token belongs to. What differs
 * between Google, Meta, TikTok and LinkedIn is a handful of values and three
 * genuine quirks, and all of them live in this table:
 *
 *   - TikTok names its client id `client_key`          → `clientIdParam`
 *   - Meta's token endpoint is a GET, everyone else POST → `tokenMethod`
 *   - TikTok requires PKCE, Google accepts it          → `pkce`
 *
 * That is the whole reason YouTube being first does not make Meta and TikTok
 * a rewrite: adding them is filling in this record and setting two env vars.
 * If a future network needs a fourth quirk, it belongs here as a fifth field
 * — not as a branch in oauth.ts.
 */

export const NETWORKS = [
  "youtube",
  "instagram",
  "facebook",
  "tiktok",
  "linkedin",
] as const;

export type Network = (typeof NETWORKS)[number];

export function isNetwork(value: string): value is Network {
  return (NETWORKS as readonly string[]).includes(value);
}

/** Who a token belongs to, as the provider reports it. */
export interface ChannelIdentity {
  /** The provider's own id for the account. Stored; half of the row's key. */
  accountId: string;
  /** What the customer recognises. Null when the provider will not say. */
  handle: string | null;
}

export interface NetworkDef {
  network: Network;
  /** Customer-facing name. Shown on the card. */
  label: string;
  /** Plain sentence describing what connecting it lets us do. */
  blurb: string;
  clientIdEnv: string;
  clientSecretEnv: string;
  authorizeUrl: string;
  tokenUrl: string;
  /** Where to tell the provider to forget us. Absent = no revoke endpoint. */
  revokeUrl?: string;
  scopes: readonly string[];
  /** The authorize/token parameter carrying the client id. TikTok: client_key. */
  clientIdParam: string;
  /** Meta serves its token exchange over GET; everyone else takes a POST. */
  tokenMethod: "GET" | "POST";
  /** Send a PKCE challenge. Required by TikTok, accepted by Google. */
  pkce: boolean;
  /** Extra authorize-URL parameters this provider needs. */
  extraAuthorizeParams?: Readonly<Record<string, string>>;
  /** Ask the provider who this token belongs to. */
  resolveIdentity(accessToken: string): Promise<ChannelIdentity>;
}

/** JSON from a provider is `unknown` until proven otherwise. */
async function getJson(
  url: string,
  init: RequestInit,
): Promise<Record<string, unknown>> {
  const res = await fetch(url, init);
  const body: unknown = await res.json().catch(() => null);
  if (!res.ok || body === null || typeof body !== "object") {
    throw new Error(`provider identity lookup failed (${res.status})`);
  }
  return body as Record<string, unknown>;
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

const DEFS: Record<Network, NetworkDef> = {
  // ── YouTube (Google) ────────────────────────────────────────────────────
  // First because a Google OAuth client is the credential most likely to
  // already exist, and because Google's consent screen is the clearest one to
  // film. access_type=offline + prompt=consent are what make the provider
  // return a refresh token; without both, a re-authorising user silently gets
  // an access token that dies in an hour and no way to renew it.
  youtube: {
    network: "youtube",
    label: "YouTube",
    blurb: "Publish long-form video and Shorts to your channel.",
    clientIdEnv: "YOUTUBE_OAUTH_CLIENT_ID",
    clientSecretEnv: "YOUTUBE_OAUTH_CLIENT_SECRET",
    authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl: "https://oauth2.googleapis.com/token",
    revokeUrl: "https://oauth2.googleapis.com/revoke",
    scopes: [
      "https://www.googleapis.com/auth/youtube.upload",
      "https://www.googleapis.com/auth/youtube.readonly",
    ],
    clientIdParam: "client_id",
    tokenMethod: "POST",
    pkce: true,
    extraAuthorizeParams: {
      access_type: "offline",
      prompt: "consent",
      include_granted_scopes: "true",
    },
    async resolveIdentity(accessToken) {
      const body = await getJson(
        "https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true",
        { headers: { authorization: `Bearer ${accessToken}` } },
      );
      const items = Array.isArray(body.items) ? body.items : [];
      const first = items[0] as Record<string, unknown> | undefined;
      const snippet = (first?.snippet ?? {}) as Record<string, unknown>;
      const accountId = str(first?.id);
      if (!accountId) throw new Error("no YouTube channel on this account");
      return {
        accountId,
        handle: str(snippet.customUrl) ?? str(snippet.title),
      };
    },
  },

  // ── Facebook Pages ──────────────────────────────────────────────────────
  facebook: {
    network: "facebook",
    label: "Facebook",
    blurb: "Publish posts to a Facebook Page you manage.",
    clientIdEnv: "FACEBOOK_OAUTH_CLIENT_ID",
    clientSecretEnv: "FACEBOOK_OAUTH_CLIENT_SECRET",
    authorizeUrl: "https://www.facebook.com/v21.0/dialog/oauth",
    tokenUrl: "https://graph.facebook.com/v21.0/oauth/access_token",
    scopes: ["pages_show_list", "pages_manage_posts", "pages_read_engagement"],
    clientIdParam: "client_id",
    tokenMethod: "GET",
    pkce: false,
    async resolveIdentity(accessToken) {
      const body = await getJson(
        `https://graph.facebook.com/v21.0/me?fields=id,name&access_token=${encodeURIComponent(accessToken)}`,
        {},
      );
      const accountId = str(body.id);
      if (!accountId) throw new Error("Facebook did not identify the account");
      return { accountId, handle: str(body.name) };
    },
  },

  // ── Instagram (through Facebook Login) ──────────────────────────────────
  // Instagram professional accounts authorise through Meta's dialog, which is
  // why this shares Facebook's endpoints and differs only in scopes. It is
  // still its own row: the customer connects "Instagram", the scopes are
  // different, and the connection can be revoked independently.
  instagram: {
    network: "instagram",
    label: "Instagram",
    blurb: "Publish Reels and posts to a connected professional account.",
    clientIdEnv: "INSTAGRAM_OAUTH_CLIENT_ID",
    clientSecretEnv: "INSTAGRAM_OAUTH_CLIENT_SECRET",
    authorizeUrl: "https://www.facebook.com/v21.0/dialog/oauth",
    tokenUrl: "https://graph.facebook.com/v21.0/oauth/access_token",
    // ⛔ The scope set is a REVIEW SURFACE, not a convenience list. Meta names
    // "requesting a permission you might need later" as a rejection reason, and
    // every extra scope is another thing the screencast must be seen using.
    // `pages_read_engagement` is here because Meta documents it as a dependency
    // of both `instagram_basic` and `instagram_content_publish`; without it the
    // grant is incomplete and publishing fails after approval, not before.
    // `business_management` was removed: it is not part of the organic publish
    // path, so it bought scrutiny and nothing else.
    scopes: [
      "instagram_basic",
      "instagram_content_publish",
      "pages_show_list",
      "pages_read_engagement",
    ],
    clientIdParam: "client_id",
    tokenMethod: "GET",
    pkce: false,
    async resolveIdentity(accessToken) {
      const body = await getJson(
        `https://graph.facebook.com/v21.0/me?fields=id,name&access_token=${encodeURIComponent(accessToken)}`,
        {},
      );
      const accountId = str(body.id);
      if (!accountId) throw new Error("Instagram did not identify the account");
      return { accountId, handle: str(body.name) };
    },
  },

  // ── TikTok ──────────────────────────────────────────────────────────────
  // The quirky one, and the reason `clientIdParam` and `pkce` are fields
  // rather than assumptions: TikTok calls the client id `client_key` in both
  // the authorize URL and the token exchange, and it rejects an authorize
  // request with no PKCE challenge.
  tiktok: {
    network: "tiktok",
    label: "TikTok",
    blurb: "Publish short-form video to your TikTok account.",
    clientIdEnv: "TIKTOK_OAUTH_CLIENT_KEY",
    clientSecretEnv: "TIKTOK_OAUTH_CLIENT_SECRET",
    authorizeUrl: "https://www.tiktok.com/v2/auth/authorize/",
    tokenUrl: "https://open.tiktokapis.com/v2/oauth/token/",
    revokeUrl: "https://open.tiktokapis.com/v2/oauth/revoke/",
    scopes: ["user.info.basic", "video.publish"],
    clientIdParam: "client_key",
    tokenMethod: "POST",
    pkce: true,
    async resolveIdentity(accessToken) {
      const body = await getJson(
        "https://open.tiktokapis.com/v2/user/info/?fields=open_id,display_name",
        { headers: { authorization: `Bearer ${accessToken}` } },
      );
      const data = (body.data ?? {}) as Record<string, unknown>;
      const user = (data.user ?? {}) as Record<string, unknown>;
      const accountId = str(user.open_id);
      if (!accountId) throw new Error("TikTok did not identify the account");
      return { accountId, handle: str(user.display_name) };
    },
  },

  // ── LinkedIn ────────────────────────────────────────────────────────────
  linkedin: {
    network: "linkedin",
    label: "LinkedIn",
    blurb: "Publish posts to your LinkedIn profile.",
    clientIdEnv: "LINKEDIN_OAUTH_CLIENT_ID",
    clientSecretEnv: "LINKEDIN_OAUTH_CLIENT_SECRET",
    authorizeUrl: "https://www.linkedin.com/oauth/v2/authorization",
    tokenUrl: "https://www.linkedin.com/oauth/v2/accessToken",
    scopes: ["openid", "profile", "w_member_social"],
    clientIdParam: "client_id",
    tokenMethod: "POST",
    pkce: false,
    async resolveIdentity(accessToken) {
      const body = await getJson("https://api.linkedin.com/v2/userinfo", {
        headers: { authorization: `Bearer ${accessToken}` },
      });
      const accountId = str(body.sub);
      if (!accountId) throw new Error("LinkedIn did not identify the account");
      return { accountId, handle: str(body.name) };
    },
  },
};

export function networkDef(network: Network): NetworkDef {
  return DEFS[network];
}

/** The customer-facing name ("YouTube", "LinkedIn"). Exported through the port
 *  so other modules can name a network without importing the whole def. */
export function networkLabel(network: Network): string {
  return DEFS[network].label;
}

export interface NetworkCredentials {
  clientId: string;
  clientSecret: string;
}

/**
 * This network's client id and secret, or null when either is absent.
 *
 * Null is the whole contract of the Channels screen: a network without
 * credentials renders DISABLED with a plain "not configured yet" line. A
 * Connect button that fails after the click is worse than one that never
 * offered — it wastes the customer's trust and, on a platform-review
 * recording, it is the frame the reviewer remembers.
 */
export function credentialsFor(network: Network): NetworkCredentials | null {
  const def = DEFS[network];
  const clientId = process.env[def.clientIdEnv]?.trim();
  const clientSecret = process.env[def.clientSecretEnv]?.trim();
  if (!clientId || !clientSecret) return null;
  return { clientId, clientSecret };
}

/**
 * Where this provider sends the customer back to.
 *
 * Built from APP_URL — the app's own public base URL — and NOT from the
 * incoming request's Host header. A redirect_uri derived from a header an
 * attacker controls is how an authorization code gets delivered somewhere
 * else. It must also match the value registered with the provider byte for
 * byte, which a request-derived value cannot promise.
 */
export function redirectUriFor(network: Network): string {
  return new URL(`/api/channels/callback/${network}`, env().APP_URL).toString();
}

/** Everything the Channels screen needs to draw one card, before any DB read. */
export interface NetworkAvailability {
  network: Network;
  label: string;
  blurb: string;
  configured: boolean;
  /** Plain sentence for the disabled tooltip. Null when it IS configured. */
  reason: string | null;
}

export function availability(network: Network): NetworkAvailability {
  const def = DEFS[network];
  const hasClient = credentialsFor(network) !== null;
  const hasKey = sealingAvailable();
  // Order matters for the message: a missing sealing key blocks EVERY
  // network, so saying "no client id" first would send Cory to fix the wrong
  // thing five times over.
  const reason = !hasKey
    ? "Token encryption is not set up yet, so no channel can be connected."
    : !hasClient
      ? `Not configured yet. Needs ${def.clientIdEnv} and ${def.clientSecretEnv}.`
      : null;
  return {
    network,
    label: def.label,
    blurb: def.blurb,
    configured: reason === null,
    reason,
  };
}
