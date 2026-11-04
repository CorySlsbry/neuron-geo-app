import "server-only";
import { cookies } from "next/headers";
import { getIronSession, type IronSession } from "iron-session";
import { env } from "@/env";

/**
 * The cookie carries IDENTITY ONLY (who you are + how strongly you proved it),
 * never authorization. Tenant, role, and departments are resolved fresh from
 * the directory on every request (see directory.ts) — a stale or tampered
 * cookie can never grant scope the directory doesn't.
 */
export interface SessionData {
  uid?: string;
  email?: string;
  /** Authentication assurance level. aal2 ONLY after a verified 2nd factor. */
  aal?: "aal1" | "aal2";
  /** Pointer to the tenant the user is acting in (membership re-verified). */
  activeTenantId?: string;
  /**
   * The revocation epoch this session was minted at. Compared against
   * user_session_epochs on every authenticated request; a mismatch means the
   * session was revoked server-side (logout, offboarding, incident response).
   */
  epoch?: number;
}

const COOKIE_NAME = "tb_session";

/**
 * Twelve hours, not iron-session's fourteen-day default.
 *
 * The default was never chosen — it was inherited by not passing `ttl`, and
 * combined with a stateless cookie it meant a stolen session stayed good for a
 * fortnight. Twelve hours covers a full working day without a
 * mid-afternoon re-login, and `touchSession()` slides it on real activity so
 * an active user is never interrupted.
 */
const SESSION_TTL_SECONDS = 12 * 60 * 60;

function sessionPassword(): string {
  const secret = env().SESSION_SECRET;
  if (secret) return secret;
  if (env().NODE_ENV === "production") {
    throw new Error("SESSION_SECRET must be set in production");
  }
  // Dev/test fallback only — never reachable in production.
  return "dev-only-insecure-session-secret-0000000000";
}

export async function getSession(): Promise<IronSession<SessionData>> {
  return getIronSession<SessionData>(await cookies(), {
    cookieName: COOKIE_NAME,
    password: sessionPassword(),
    ttl: SESSION_TTL_SECONDS,
    cookieOptions: {
      httpOnly: true,
      sameSite: "lax",
      secure: env().NODE_ENV === "production",
      path: "/",
      maxAge: SESSION_TTL_SECONDS,
    },
  });
}
