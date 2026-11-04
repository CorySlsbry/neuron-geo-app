import "server-only";
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";
import { env } from "@/env";

/**
 * GCP Identity Platform ID-token verification.
 *
 * This function is the front door. Everything downstream — tenant scope,
 * department walls, RLS GUCs, the money surfaces — trusts the uid it returns.
 * A shortcut here is not a bug, it is a total authentication bypass, so every
 * check below is deliberate and none of them are optional:
 *
 *   - RS256 ONLY. Never accept `alg` from the token. A verifier that honours
 *     the header's alg accepts `alg: "none"`, or an HS256 token signed with the
 *     public key as the HMAC secret. jose pins it via `algorithms`.
 *   - Signature against GOOGLE's published keys, fetched over TLS and cached
 *     with rotation handled by createRemoteJWKSet.
 *   - `iss` must be exactly https://securetoken.google.com/<project>.
 *   - `aud` must be exactly <project>. Without this, a token minted for ANY
 *     other Firebase/Identity Platform project verifies fine — same signing
 *     keys, different tenant. This is the check people miss.
 *   - `sub` must be non-empty; it becomes our uid.
 *   - `exp`/`iat` with a small clock skew allowance.
 *   - `auth_time` must be in the past — a token claiming to have been
 *     authenticated in the future is not something to reason about.
 *
 * aal2 is derived ONLY from `firebase.sign_in_second_factor` being present.
 * It is never read from a client-settable field and never defaulted upward.
 */

const CLOCK_SKEW_SECONDS = 60;

/** Google's public keys for Identity Platform ID tokens (rotated by Google). */
let jwks: ReturnType<typeof createRemoteJWKSet> | null = null;
function keys(): ReturnType<typeof createRemoteJWKSet> {
  jwks ??= createRemoteJWKSet(
    new URL("https://www.googleapis.com/service_accounts/v1/jwk/person1@example.com"),
  );
  return jwks;
}

export interface VerifiedIdentity {
  uid: string;
  email?: string;
  emailVerified: boolean;
  /**
   * How the account authenticated: "password", "google.com", etc. Checked by
   * identityLogin against an explicit allowlist. Without it, enabling any
   * additional provider on the GCP project — anonymous auth, a federated IdP,
   * a custom token — would silently become a way into this application, with
   * no change to this codebase and nothing to review.
   */
  signInProvider?: string;
  /** aal2 ONLY when Identity Platform reports a verified second factor. */
  aal: "aal1" | "aal2";
}

export class IdentityError extends Error {
  constructor(public readonly code: string) {
    super(code);
  }
}

interface FirebaseClaims extends JWTPayload {
  email?: string;
  email_verified?: boolean;
  auth_time?: number;
  firebase?: {
    sign_in_provider?: string;
    sign_in_second_factor?: string;
    identities?: Record<string, unknown>;
  };
}

/**
 * Verify an Identity Platform ID token and return the identity it proves.
 * Throws IdentityError on ANY failure — there is no partial success here.
 */
export async function verifyIdToken(idToken: string): Promise<VerifiedIdentity> {
  const projectId = env().GCP_PROJECT_ID;
  if (!projectId) throw new IdentityError("identity_not_configured");
  if (!idToken || idToken.split(".").length !== 3) {
    throw new IdentityError("malformed_token");
  }

  let payload: FirebaseClaims;
  try {
    const result = await jwtVerify(idToken, keys(), {
      algorithms: ["RS256"],
      issuer: `https://securetoken.google.com/${projectId}`,
      audience: projectId,
      clockTolerance: CLOCK_SKEW_SECONDS,
    });
    payload = result.payload as FirebaseClaims;
  } catch {
    // Deliberately opaque: distinguishing "expired" from "bad signature" from
    // "wrong audience" tells an attacker which knob to turn.
    throw new IdentityError("invalid_token");
  }

  const uid = typeof payload.sub === "string" ? payload.sub.trim() : "";
  if (!uid) throw new IdentityError("invalid_token");

  // A token that claims it was authenticated in the future is not trustworthy.
  const now = Math.floor(Date.now() / 1000);
  if (typeof payload.auth_time === "number" && payload.auth_time > now + CLOCK_SKEW_SECONDS) {
    throw new IdentityError("invalid_token");
  }

  const secondFactor = payload.firebase?.sign_in_second_factor;
  return {
    uid,
    email: typeof payload.email === "string" ? payload.email : undefined,
    emailVerified: payload.email_verified === true,
    signInProvider:
      typeof payload.firebase?.sign_in_provider === "string"
        ? payload.firebase.sign_in_provider
        : undefined,
    aal: typeof secondFactor === "string" && secondFactor.length > 0 ? "aal2" : "aal1",
  };
}
