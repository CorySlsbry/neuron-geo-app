// auth-tenancy module — public port.
//
// Identity lives in an httpOnly cookie (uid + aal only). Authorization —
// tenant, role, departments — is resolved FRESH from the directory on every
// request (memberships / member_department_access under RLS), never from a
// cookie or token claim. aal2 comes only from a verified second factor.
import "server-only";
import { env } from "@/env";
import { verifyIdToken } from "./internal/identity-platform";
import { getSession } from "./internal/session";
import {
  bumpEpoch,
  currentEpoch,
  listMemberships,
  provisionTenant,
  resolveScope,
  type Membership,
  type ResolvedScope,
  type Role,
} from "./internal/directory";
import { AuthError, checkScope, type ScopeRequirements } from "./internal/guards";
import { resolveSubscriptionAccess } from "./internal/paywall";
import type { SubscriptionAccess } from "./internal/subscription-gate";

export {
  AuthError,
  BOOKS_ROLES,
  checkScope,
  holdsDepartments,
  WRITE_ROLES,
} from "./internal/guards";
export type { Membership, ResolvedScope, Role, ScopeRequirements };
export type { AccessState, SubscriptionAccess } from "./internal/subscription-gate";

export interface Principal {
  uid: string;
  email?: string;
  aal: "aal1" | "aal2";
}

/**
 * Sign-in methods this application accepts. Extend DELIBERATELY — every entry
 * is a way in. Enabling a provider in the GCP console is not enough, and that
 * is the point.
 */
const ALLOWED_SIGN_IN_PROVIDERS = new Set(["password"]);

/** The authenticated principal, or 401. Authentication only — no authz. */
export async function requireAuth(): Promise<Principal> {
  const session = await getSession();
  if (!session.uid) throw new AuthError(401, "unauthenticated");
  await assertNotRevoked(session.uid, session.epoch);
  return { uid: session.uid, email: session.email, aal: session.aal ?? "aal1" };
}

/**
 * A stateless cookie proves who minted it, not that it should still be
 * honoured. Compare the epoch it carries against the user's current one, so
 * logout and offboarding actually END a session instead of merely deleting the
 * client's copy of it. Fails CLOSED — an unreadable epoch is a revoked session.
 */
async function assertNotRevoked(uid: string, epoch: number | undefined): Promise<void> {
  if (epoch === undefined) throw new AuthError(401, "session_revoked");
  let current: number;
  try {
    current = await currentEpoch(uid);
  } catch {
    throw new AuthError(401, "session_revoked");
  }
  if (current !== epoch) throw new AuthError(401, "session_revoked");
}

/**
 * The full authorization gate for tenant surfaces: authenticate, re-verify
 * membership in the active tenant, resolve role + department grants from the
 * directory, then enforce `req`. Every data route goes through this.
 */
export async function requireScope(
  req: ScopeRequirements = {},
): Promise<ResolvedScope & { aal: "aal1" | "aal2" }> {
  const session = await getSession();
  if (!session.uid) throw new AuthError(401, "unauthenticated");
  await assertNotRevoked(session.uid, session.epoch);
  if (!session.activeTenantId) throw new AuthError(403, "no_active_tenant");

  const resolved = await resolveScope(session.uid, session.activeTenantId);
  if (!resolved) throw new AuthError(403, "not_a_member");
  const scope = resolved;

  // The paywall runs FIRST among the requirement checks, on purpose: when a
  // trial has ended, "your plan is read-only" is the true reason a write is
  // refused — reporting a missing role or second factor instead would send
  // the user to fix the wrong thing. 402, the one HTTP code that says
  // exactly this.
  if (req.write) {
    const access = await resolveSubscriptionAccess(session.uid, session.activeTenantId);
    if (access.state !== "full") throw new AuthError(402, "subscription_required");
  }

  const aal = session.aal ?? "aal1";
  checkScope(scope, aal, req);
  return { ...scope, aal };
}

/**
 * The tenant's paywall state, for surfaces that ANNOUNCE it (/api/me → the
 * shell's read-only banner) rather than enforce it. Enforcement is
 * requireScope({ write: true }); this is the honest sign on the door.
 */
export async function subscriptionStateFor(
  scope: Pick<ResolvedScope, "uid" | "tenantId">,
): Promise<SubscriptionAccess> {
  return resolveSubscriptionAccess(scope.uid, scope.tenantId);
}

export async function myMemberships(): Promise<Membership[]> {
  const { uid } = await requireAuth();
  return listMemberships(uid);
}

/**
 * Fresh-start signup — the GEO shape: an EMPTY tenant + its owner membership
 * + a 30-day trial subscription row, and nothing else. No chart of accounts,
 * no departments, no domain seed of any kind. The department-wall MECHANISM
 * stays (departments / member_department_access / the app.current_departments
 * GUC), but a new tenant starts with zero departments until an owner creates
 * one.
 */
export async function signup(name: string, slug: string): Promise<string> {
  const { uid } = await requireAuth();
  const tenantId = await provisionTenant(uid, name, slug);
  // Start the 30-day trial the moment the tenant exists (matches the offer).
  await (await import("@/lib/db/tenant")).withTenant({ uid, tenantId }, async (c) => {
    await c.query(
      `INSERT INTO subscriptions (tenant_id, plan, seat_cap, status, trial_ends_at)
       VALUES ($1,'start',2,'trialing', now() + interval '30 days')
       ON CONFLICT (tenant_id) DO NOTHING`,
      [tenantId],
    );
  });
  const session = await getSession();
  session.activeTenantId = tenantId;
  await session.save();
  return tenantId;
}

/** Switch the acting tenant — membership verified before the pointer moves. */
export async function selectTenant(tenantId: string): Promise<void> {
  const { uid } = await requireAuth();
  const scope = await resolveScope(uid, tenantId);
  if (!scope) throw new AuthError(403, "not_a_member");
  const session = await getSession();
  session.activeTenantId = tenantId;
  await session.save();
}

/**
 * Dev-only login (email → deterministic uid). Hard-disabled outside
 * AUTH_MODE=dev, and AUTH_MODE=dev itself refuses to run in production.
 * The Identity Platform provider (ID-token verify + TOTP → aal2) replaces
 * this once GCP is provisioned — see docs/NEEDS-CORY.md.
 */
export async function devLogin(email: string): Promise<Principal> {
  if (env().AUTH_MODE !== "dev" || env().NODE_ENV === "production") {
    throw new AuthError(401, "dev_login_disabled");
  }
  const normalized = email.trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(normalized)) {
    throw new AuthError(401, "invalid_email");
  }
  const session = await getSession();
  session.uid = `dev:${normalized}`;
  session.email = normalized;
  session.aal = "aal1"; // dev logins NEVER claim a second factor
  session.activeTenantId = undefined;
  session.epoch = await currentEpoch(session.uid);
  await session.save();
  return { uid: session.uid, email: normalized, aal: "aal1" };
}

/**
 * Identity Platform login: exchange a verified ID token for our session.
 *
 * The ID token proves WHO you are and HOW STRONGLY you proved it, and that is
 * all we take from it. Tenant, role and departments are still resolved fresh
 * from the directory on every request, so a token cannot grant scope — the
 * same rule that already applies to the dev path.
 *
 * The session is re-minted from scratch (no merge into an existing session),
 * so signing in as a different user can never inherit the previous user's
 * activeTenantId — a session-fixation shape that is easy to leave behind when
 * you only overwrite the fields you happen to think about.
 */
export async function identityLogin(idToken: string): Promise<Principal> {
  if (env().AUTH_MODE !== "identity-platform") {
    throw new AuthError(401, "identity_login_disabled");
  }
  let verified;
  try {
    verified = await verifyIdToken(idToken);
  } catch {
    // Opaque on purpose — see identity-platform.ts.
    throw new AuthError(401, "invalid_credentials");
  }

  // The token proving WHO you are is not the same as this application
  // agreeing to let that identity in.
  //
  // /api/auth/config serves the Identity Platform Web API key to anyone (by
  // design — it identifies the project and grants nothing on its own), and
  // Identity Platform's Email/Password provider permits self-service
  // accounts:signUp. So anyone can mint a genuine, correctly-signed ID token
  // for a throwaway address. RLS keeps them out of everyone else's data, but
  // without these two checks that token is a session here.
  //
  // Pinning the provider is the load-bearing half: the day anonymous auth or
  // a federated IdP is switched on in the GCP console — a click, in a
  // different system, by someone not reading this file — the allowlist is
  // what stops it from silently becoming an authentication bypass.
  if (!ALLOWED_SIGN_IN_PROVIDERS.has(verified.signInProvider ?? "")) {
    throw new AuthError(401, "invalid_credentials");
  }
  if (!verified.emailVerified) {
    // Distinct code: this one the user can actually fix, and telling them to
    // check their inbox is not an information leak — they already proved they
    // control the password for this address.
    throw new AuthError(403, "email_not_verified");
  }

  const session = await getSession();
  session.destroy();
  const fresh = await getSession();
  fresh.uid = verified.uid;
  fresh.email = verified.email;
  fresh.aal = verified.aal;
  fresh.activeTenantId = undefined;
  // Stamp the CURRENT revocation epoch. Every later request compares against
  // it, so a prior logout cannot be undone by replaying an older cookie.
  fresh.epoch = await currentEpoch(verified.uid);
  await fresh.save();
  return { uid: verified.uid, email: verified.email, aal: verified.aal };
}

export async function logout(): Promise<void> {
  const session = await getSession();
  // Bump FIRST: destroying the cookie only removes the client's copy, and a
  // copy taken before this call would otherwise stay valid for the full TTL.
  if (session.uid) await bumpEpoch(session.uid).catch(() => {});
  session.destroy();
}

export {
  createDepartment,
  deleteDepartment,
  isProtectedDepartment,
  listTeam,
  renameDepartment,
  setMemberDepartments,
  setMemberRole,
} from "./internal/team";
export type { TeamMember } from "./internal/team";

export { getBrand, normalizeDomain, saveBrand } from "./internal/brand";
export type { Brand } from "./internal/brand";

export {
  createInvite,
  listInvites,
  redeemInvite,
  revokeInvite,
} from "./internal/invites";
export type { InviteRole, PendingInvite } from "./internal/invites";
