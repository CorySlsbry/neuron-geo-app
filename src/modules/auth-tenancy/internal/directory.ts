import "server-only";
import { withUid, withTenant } from "@/lib/db/tenant";

export type Role = "owner" | "admin" | "staff" | "bookkeeper" | "viewer";

export interface Membership {
  membershipId: string;
  tenantId: string;
  tenantName: string;
  tenantSlug: string;
  role: Role;
}

export interface ResolvedScope {
  uid: string;
  tenantId: string;
  role: Role;
  /** Department keys granted to this member in this tenant. */
  departments: string[];
}

/**
 * The directory is the ONLY source of authorization truth. Everything here is
 * resolved from memberships / member_department_access under RLS — never from
 * a cookie or token claim.
 */
/**
 * The user's current revocation epoch, creating it on first sight.
 *
 * Read inside the uid-scoped transaction the directory already opens, so this
 * costs no extra round trip on the authenticated path. Fails CLOSED: if the
 * row cannot be read or created, callers treat the session as revoked rather
 * than assume it is fine.
 */
export async function currentEpoch(uid: string): Promise<number> {
  return withUid(uid, async (c) => {
    const { rows } = await c.query<{ epoch: number }>(
      `INSERT INTO user_session_epochs (user_id) VALUES ($1)
       ON CONFLICT (user_id) DO UPDATE SET user_id = EXCLUDED.user_id
       RETURNING epoch`,
      [uid],
    );
    return rows[0]!.epoch;
  });
}

/**
 * Invalidate every session this user holds, on every device, immediately.
 * Called on logout and available for offboarding / incident response.
 */
export async function bumpEpoch(uid: string): Promise<void> {
  await withUid(uid, async (c) => {
    await c.query(
      `INSERT INTO user_session_epochs (user_id, epoch) VALUES ($1, 2)
       ON CONFLICT (user_id) DO UPDATE
         SET epoch = user_session_epochs.epoch + 1, updated_at = now()`,
      [uid],
    );
  });
}

export async function listMemberships(uid: string): Promise<Membership[]> {
  return withUid(uid, async (c) => {
    const { rows } = await c.query<Membership>(
      `SELECT m.id AS "membershipId", m.tenant_id AS "tenantId",
              t.name AS "tenantName", t.slug AS "tenantSlug",
              m.role AS "role"
         FROM memberships m JOIN tenants t ON t.id = m.tenant_id
        WHERE m.user_id = app.current_uid()
        ORDER BY t.name`,
    );
    return rows;
  });
}

/**
 * Verifies `uid` is a member of `tenantId` and returns the full scope
 * (role + department grants). Returns null when there is no membership —
 * callers translate that into 403, never a silent fallback.
 */
export async function resolveScope(
  uid: string,
  tenantId: string,
): Promise<ResolvedScope | null> {
  // Membership check runs uid-only (pre-tenant, self-read policy).
  const membership = (await listMemberships(uid)).find(
    (m) => m.tenantId === tenantId,
  );
  if (!membership) return null;

  // Department grants live behind tenant RLS. Owners/admins administer the
  // walls, so their grant set expands to ALL tenant departments at resolution
  // time (no wildcard logic anywhere downstream — the GUC always carries real
  // keys). Everyone else gets exactly their per-person grants.
  const isTenantAdmin = membership.role === "owner" || membership.role === "admin";
  const departments = await withTenant({ uid, tenantId }, async (c) => {
    const { rows } = isTenantAdmin
      ? await c.query<{ key: string }>("SELECT key FROM departments")
      : await c.query<{ key: string }>(
          `SELECT d.key
             FROM member_department_access mda
             JOIN departments d ON d.id = mda.department_id
            WHERE mda.membership_id = $1`,
          [membership.membershipId],
        );
    return rows.map((r) => r.key);
  });

  return { uid, tenantId, role: membership.role, departments };
}

/** Fresh-start signup: provision a tenant + owner membership atomically. */
export async function provisionTenant(
  uid: string,
  name: string,
  slug: string,
): Promise<string> {
  return withUid(uid, async (c) => {
    const { rows } = await c.query<{ id: string }>(
      "SELECT app.provision_tenant($1, $2, $3) AS id",
      [name, slug, uid],
    );
    const id = rows[0]?.id;
    if (!id) throw new Error("provision_tenant returned no id");
    return id;
  });
}
