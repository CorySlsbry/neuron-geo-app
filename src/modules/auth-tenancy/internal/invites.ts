import "server-only";
import { createHash, randomBytes } from "node:crypto";
import { withTenant, withUid, type TenantScope } from "@/lib/db/tenant";
import { AuthError } from "./guards";
import type { Role } from "./directory";

/**
 * Join-by-link team invites (v1 — see migrations/0003_invites.sql for the
 * whole doctrine). The raw token exists in exactly two places: the creation
 * response and the link the owner copies. Here it is hashed on the way in
 * and never read back — the SELECT grant physically excludes token_hash.
 */

/** Owner is never granted by link; ownership moves person-to-person. */
export type InviteRole = Exclude<Role, "owner">;

export interface PendingInvite {
  id: string;
  email: string;
  role: InviteRole;
  invitedBy: string;
  expiresAt: string;
  createdAt: string;
  /** Kept in the list so the UI can say "expired" instead of hiding it. */
  expired: boolean;
}

export function hashInviteToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/**
 * Create an invite and hand back the ONE copy of the raw token that will
 * ever exist. 32 random bytes → base64url: unguessable at any rate limit,
 * and the accept endpoint is rate-limited anyway.
 */
export async function createInvite(
  scope: TenantScope,
  email: string,
  role: InviteRole,
): Promise<{ token: string; expiresAt: string }> {
  const token = randomBytes(32).toString("base64url");
  const row = await withTenant(scope, async (c) => {
    const { rows } = await c.query<{ expires_at: string }>(
      `INSERT INTO invites (tenant_id, email, role, token_hash, invited_by)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING expires_at::text AS expires_at`,
      [scope.tenantId, email.trim().toLowerCase(), role, hashInviteToken(token), scope.uid],
    );
    return rows[0]!;
  });
  return { token, expiresAt: row.expires_at };
}

/** Unaccepted invites, newest first — expired ones flagged, not hidden. */
export async function listInvites(scope: TenantScope): Promise<PendingInvite[]> {
  return withTenant(scope, async (c) => {
    const { rows } = await c.query<{
      id: string;
      email: string;
      role: InviteRole;
      invited_by: string;
      expires_at: string;
      created_at: string;
      expired: boolean;
    }>(
      `SELECT id, email, role, invited_by, expires_at::text AS expires_at,
              created_at::text AS created_at, (expires_at <= now()) AS expired
         FROM invites
        WHERE accepted_at IS NULL
        ORDER BY created_at DESC`,
    );
    return rows.map((r) => ({
      id: r.id,
      email: r.email,
      role: r.role,
      invitedBy: r.invited_by,
      expiresAt: r.expires_at,
      createdAt: r.created_at,
      expired: r.expired,
    }));
  });
}

/** Revoke = delete. A spent invite can't be revoked (it's a membership now —
 *  remove the PERSON on the team screen instead). */
export async function revokeInvite(scope: TenantScope, inviteId: string): Promise<void> {
  await withTenant(scope, async (c) => {
    const r = await c.query(
      `DELETE FROM invites WHERE id = $1 AND accepted_at IS NULL`,
      [inviteId],
    );
    if (r.rowCount === 0) throw new AuthError(404, "invite_not_found");
  });
}

/**
 * Redeem a raw token for the authenticated uid. Returns the joined tenant id.
 * Throws:
 *   - 410 invite_invalid   — unknown, spent, or expired (one answer, so a
 *                            probing caller learns nothing about which)
 *   - 402 seat_limit_reached — the plan is full (the memberships trigger is
 *                            the single enforcement point; we translate it)
 */
export async function redeemInvite(uid: string, token: string): Promise<string> {
  let tenantId: string | null;
  try {
    tenantId = await withUid(uid, async (c) => {
      const { rows } = await c.query<{ tenant_id: string | null }>(
        `SELECT app.redeem_invite($1, $2) AS tenant_id`,
        [hashInviteToken(token), uid],
      );
      return rows[0]?.tenant_id ?? null;
    });
  } catch (err) {
    // The seat-cap trigger raises check_violation with this message.
    if (
      err instanceof Error &&
      "code" in err &&
      (err as Error & { code?: string }).code === "23514" &&
      err.message.includes("seat_limit_reached")
    ) {
      throw new AuthError(402, "seat_limit_reached");
    }
    throw err;
  }
  if (!tenantId) throw new AuthError(410, "invite_invalid");
  return tenantId;
}
