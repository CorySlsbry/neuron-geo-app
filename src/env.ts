import "server-only";
import { z } from "zod";

/**
 * Runtime environment validation. Parsed lazily (on first `env()` call) rather
 * than at import time, so `next build` never requires DB/secret values — build
 * secrets are supplied at deploy, not bake time.
 */
const EnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  // App-connection DSN (non-superuser app role in prod). Optional at build.
  DATABASE_URL: z.string().url().optional(),
  // Public base URL of the deployed app (used for absolute links, webhooks).
  APP_URL: z.string().url().default("http://localhost:3000"),
  /**
   * Origin used to build Stripe return URLs (checkout success/cancel, billing
   * portal, customer payment links).
   *
   * Declared here because it was previously read straight from process.env in
   * three places with a `?? "http://localhost:3010"` fallback and appeared in
   * no schema, no .env.example and no docs. It IS set correctly on Cloud Run
   * today — but nothing would have caught it being dropped, and the failure
   * mode is silent and awful: a paying customer redirected to localhost after
   * handing over a card.
   */
  APP_ORIGIN: z.string().url().default("http://localhost:3010"),
  /**
   * Auth provider. "dev" = local email-only login (NEVER in production —
   * enforced in code); "identity-platform" = GCP Identity Platform ID-token
   * verification + TOTP (requires GCP provisioning; see docs/NEEDS-CORY.md).
   */
  AUTH_MODE: z.enum(["dev", "identity-platform"]).default("dev"),
  /** iron-session cookie encryption secret (>=32 chars). Required in prod. */
  SESSION_SECRET: z.string().min(32).optional(),
  /**
   * GCP project that mints Identity Platform ID tokens. Required when
   * AUTH_MODE=identity-platform: it is BOTH the expected `iss` suffix and the
   * expected `aud`. Without the aud check, a token minted for any other
   * Firebase project verifies against the same Google keys and would be
   * accepted — so this is a security control, not just configuration.
   */
  GCP_PROJECT_ID: z.string().min(1).optional(),
  /**
   * Identity Platform Web API key. NOT a secret (it identifies the project to
   * Google's auth endpoints; it grants nothing on its own) — but it is still
   * served at runtime rather than NEXT_PUBLIC_-baked, so the same key rotation
   * story applies to it as to the Stripe publishable key.
   */
  IDENTITY_PLATFORM_API_KEY: z.string().min(1).optional(),

  // ── channel connections ────────────────────────────────────────────────
  /**
   * The key that seals every stored OAuth token (Fernet — 32 bytes,
   * base64url). Absent = no network can be connected at all, and the
   * Channels screen says so on every card BEFORE the customer clicks.
   * Generate one with `node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"`.
   */
  CHANNEL_TOKEN_KEY: z.string().min(1).optional(),

  /**
   * The address on the PUBLIC data-deletion page (/data-deletion), which is
   * the URL Meta's App Review asks for and which every reviewer clicks.
   *
   * ⚠️ It has to be a mailbox somebody actually reads. A deletion-request
   * address that bounces is worse than none: it is a written promise the
   * product does not keep, on a page submitted to a platform as evidence.
   */
  SUPPORT_EMAIL: z.string().email().default("privacy@neuron-hq.com"),

  /**
   * Per-network OAuth clients. All optional and all absent by default: a
   * network without both halves renders DISABLED with an honest reason.
   *
   * ⚠️ These are DECLARED here and READ by name in
   * `modules/channels/internal/networks.ts`, where each network's definition
   * carries the env-var names it needs — a keyed lookup cannot go through a
   * fixed zod shape. This block is the declaration of record anyway: the
   * lesson APP_ORIGIN taught (see its comment above) is that an env var
   * appearing in no schema, no .env.example and no docs is one nobody can
   * notice going missing. If you add a network there, add its two keys here.
   */
  YOUTUBE_OAUTH_CLIENT_ID: z.string().optional(),
  YOUTUBE_OAUTH_CLIENT_SECRET: z.string().optional(),
  FACEBOOK_OAUTH_CLIENT_ID: z.string().optional(),
  FACEBOOK_OAUTH_CLIENT_SECRET: z.string().optional(),
  INSTAGRAM_OAUTH_CLIENT_ID: z.string().optional(),
  INSTAGRAM_OAUTH_CLIENT_SECRET: z.string().optional(),
  TIKTOK_OAUTH_CLIENT_KEY: z.string().optional(),
  TIKTOK_OAUTH_CLIENT_SECRET: z.string().optional(),
  LINKEDIN_OAUTH_CLIENT_ID: z.string().optional(),
  LINKEDIN_OAUTH_CLIENT_SECRET: z.string().optional(),
}).superRefine((e, ctx) => {
  // Defaults that are correct in dev and dangerous in production. A localhost
  // APP_ORIGIN in prod means Stripe sends a customer who just paid to a page
  // that does not exist — and nothing else in the system would notice.
  if (e.NODE_ENV === "production" && new URL(e.APP_ORIGIN).hostname === "localhost") {
    ctx.addIssue({
      code: "custom",
      path: ["APP_ORIGIN"],
      message: "APP_ORIGIN must be the real public origin in production",
    });
  }
  if (e.NODE_ENV === "production") {
    // Fail at BOOT, not at first login. devLogin() already refuses to run in
    // production, but that check fires when someone tries to sign in — by
    // which point the service deployed, passed its health check, and looks
    // fine. A misconfigured AUTH_MODE should stop the deploy, not the user.
    if (e.AUTH_MODE !== "identity-platform") {
      ctx.addIssue({
        code: "custom",
        path: ["AUTH_MODE"],
        message: "AUTH_MODE must be identity-platform in production",
      });
    }
    // Same reasoning: identity-platform mode without its project pin or API
    // key renders every login "not configured" — an outage that would
    // otherwise only be discovered by a customer.
    if (!e.GCP_PROJECT_ID) {
      ctx.addIssue({
        code: "custom",
        path: ["GCP_PROJECT_ID"],
        message: "GCP_PROJECT_ID is required in production",
      });
    }
    if (!e.IDENTITY_PLATFORM_API_KEY) {
      ctx.addIssue({
        code: "custom",
        path: ["IDENTITY_PLATFORM_API_KEY"],
        message: "IDENTITY_PLATFORM_API_KEY is required in production",
      });
    }
  }
});

export type Env = z.infer<typeof EnvSchema>;

let _env: Env | undefined;

export function env(): Env {
  if (!_env) {
    const parsed = EnvSchema.safeParse(process.env);
    if (!parsed.success) {
      // Never print values — only which keys failed.
      const keys = parsed.error.issues.map((i) => i.path.join(".")).join(", ");
      throw new Error(`Invalid environment configuration: ${keys}`);
    }
    _env = parsed.data;
  }
  return _env;
}

export function requireDatabaseUrl(): string {
  const url = env().DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");
  return url;
}
