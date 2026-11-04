import "server-only";
import { withTenant, type TenantScope } from "@/lib/db/tenant";
import { AuthError } from "./guards";
import type { Role } from "./directory";

// Team management — the per-person wall toggles. Every write requires
// owner/admin at the route AND runs under tenant RLS. Down to a one-person
// company this stays honest: the owner implicitly holds every wall, and the
// first hire starts with none until a wall is switched on for them.

/**
 * GEO shape: NOTHING seeds departments. The wall MECHANISM is fully alive —
 * departments / member_department_access flow into scope.departments and the
 * app.current_departments GUC, and any route or RLS policy can gate on a key —
 * but a new tenant starts with zero departments and an owner creates the ones
 * their org actually has. No key is protected until a guard names one; when a
 * future surface gates on a key, add it here so it can't be deleted out from
 * under the guard.
 */
const PROTECTED_KEYS = new Set<string>();

/** Keys are slugs: short, lowercase, url- and GUC-safe (the GUC is CSV). */
const DEPT_KEY_RE = /^[a-z][a-z0-9-]{1,29}$/;

export function isProtectedDepartment(key: string): boolean {
  return PROTECTED_KEYS.has(key);
}

export async function createDepartment(
  scope: TenantScope,
  key: string,
  name: string,
): Promise<void> {
  const k = key.trim().toLowerCase();
  const n = name.trim();
  if (!DEPT_KEY_RE.test(k)) throw new AuthError(422, "department_key_invalid");
  if (!n || n.length > 60) throw new AuthError(422, "department_name_invalid");
  await withTenant(scope, async (c) => {
    const r = await c.query(
      `INSERT INTO departments (tenant_id, key, name) VALUES ($1,$2,$3)
       ON CONFLICT (tenant_id, key) DO NOTHING`,
      [scope.tenantId, k, n],
    );
    if (r.rowCount === 0) throw new AuthError(409, "department_exists");
  });
}

export async function renameDepartment(
  scope: TenantScope,
  key: string,
  name: string,
): Promise<void> {
  const n = name.trim();
  if (!n || n.length > 60) throw new AuthError(422, "department_name_invalid");
  await withTenant(scope, async (c) => {
    const r = await c.query(
      `UPDATE departments SET name = $3 WHERE tenant_id = $1 AND key = $2`,
      [scope.tenantId, key, n],
    );
    if (r.rowCount === 0) throw new AuthError(404, "department_not_found");
  });
}

/**
 * Deleting is allowed only for CUSTOM departments with nobody granted —
 * "unassign everyone first" beats silently stripping access as a side effect
 * of an org-chart cleanup. The standard three are refused outright: guards
 * name them.
 */
export async function deleteDepartment(scope: TenantScope, key: string): Promise<void> {
  if (isProtectedDepartment(key)) throw new AuthError(409, "department_protected");
  await withTenant(scope, async (c) => {
    const grants = await c.query<{ n: string }>(
      `SELECT count(*)::text AS n
         FROM member_department_access mda
         JOIN departments d ON d.id = mda.department_id
        WHERE d.tenant_id = $1 AND d.key = $2`,
      [scope.tenantId, key],
    );
    if (Number(grants.rows[0]!.n) > 0) throw new AuthError(409, "department_in_use");
    const r = await c.query(
      `DELETE FROM departments WHERE tenant_id = $1 AND key = $2`,
      [scope.tenantId, key],
    );
    if (r.rowCount === 0) throw new AuthError(404, "department_not_found");
  });
}

export interface TeamMember {
  userId: string;
  role: Role;
  departments: string[];
  isYou: boolean;
}

export async function listTeam(scope: TenantScope): Promise<{
  members: TeamMember[];
  departments: { key: string; name: string }[];
}> {
  return withTenant(scope, async (c) => {
    const deps = await c.query<{ key: string; name: string }>(
      `SELECT key, name FROM departments ORDER BY key`,
    );
    const { rows } = await c.query<{
      user_id: string;
      role: Role;
      departments: string[];
    }>(
      `SELECT m.user_id, m.role,
              COALESCE(ARRAY_AGG(d.key ORDER BY d.key)
                       FILTER (WHERE d.key IS NOT NULL), '{}') AS departments
         FROM memberships m
         LEFT JOIN member_department_access mda ON mda.membership_id = m.id
         LEFT JOIN departments d ON d.id = mda.department_id
        WHERE m.tenant_id = $1
        GROUP BY m.id, m.user_id, m.role
        ORDER BY m.created_at`,
      [scope.tenantId],
    );
    return {
      departments: deps.rows,
      members: rows.map((r) => ({
        userId: r.user_id,
        role: r.role,
        departments: r.departments,
        isYou: r.user_id === scope.uid,
      })),
    };
  });
}

/** Replace one member's wall grants with exactly `departmentKeys`. */
export async function setMemberDepartments(
  scope: TenantScope,
  userId: string,
  departmentKeys: string[],
): Promise<void> {
  await withTenant(scope, async (c) => {
    const m = await c.query<{ id: string; role: Role }>(
      `SELECT id, role FROM memberships WHERE tenant_id = $1 AND user_id = $2`,
      [scope.tenantId, userId],
    );
    const member = m.rows[0];
    if (!member) throw new AuthError(404, "member_not_found");

    // Verify every key EXISTS before touching anything. The old version
    // silently dropped unknown keys via the INSERT..SELECT join — a typo'd
    // key looked like success while granting nothing, which is the worst kind
    // of access bug: invisible until someone can't see what you told them
    // they could.
    if (departmentKeys.length > 0) {
      const found = await c.query<{ key: string }>(
        `SELECT key FROM departments WHERE tenant_id = $1 AND key = ANY($2)`,
        [scope.tenantId, departmentKeys],
      );
      if (found.rowCount !== new Set(departmentKeys).size) {
        throw new AuthError(422, "unknown_department");
      }
    }

    await c.query(`DELETE FROM member_department_access WHERE membership_id = $1`, [
      member.id,
    ]);
    for (const key of departmentKeys) {
      await c.query(
        `INSERT INTO member_department_access (tenant_id, membership_id, department_id)
         SELECT $1, $2, d.id FROM departments d WHERE d.tenant_id = $1 AND d.key = $3
         ON CONFLICT (membership_id, department_id) DO NOTHING`,
        [scope.tenantId, member.id, key],
      );
    }
  });
}

/** Change a member's role. Owner-only at the route; the last owner is
 *  protected here — a tenant can never lock itself out. */
export async function setMemberRole(
  scope: TenantScope,
  userId: string,
  role: Role,
): Promise<void> {
  await withTenant(scope, async (c) => {
    if (role !== "owner") {
      const owners = await c.query<{ n: string }>(
        `SELECT count(*) AS n FROM memberships
          WHERE tenant_id = $1 AND role = 'owner' AND user_id <> $2`,
        [scope.tenantId, userId],
      );
      if (Number(owners.rows[0]!.n) === 0) {
        const target = await c.query(
          `SELECT 1 FROM memberships WHERE tenant_id = $1 AND user_id = $2 AND role = 'owner'`,
          [scope.tenantId, userId],
        );
        if (target.rows.length > 0) throw new AuthError(409, "last_owner");
      }
    }
    const r = await c.query(
      `UPDATE memberships SET role = $3 WHERE tenant_id = $1 AND user_id = $2`,
      [scope.tenantId, userId, role],
    );
    if (r.rowCount === 0) throw new AuthError(404, "member_not_found");
  });
}

/**
 * ⛔ `addMember` WAS HERE AND HAS BEEN RETIRED (2026-08-14). Do not bring it
 * back without reading this.
 *
 * It inserted straight into `memberships` from app_user — and app_user has
 * never held an INSERT grant on that table (migration 0001 grants SELECT and
 * UPDATE only). So the function could not succeed: every call ended in a
 * permission error rendered as a generic 500. It survived because the Team
 * screen never called it; the only caller was an `add-member` action on
 * /api/team that no UI ever posted.
 *
 * It is not fixable by adding the grant, and that is the interesting part.
 * Adding a person is exactly the operation that has to enforce the seat cap,
 * carry a role, and be attributable — and there is precisely ONE way into a
 * tenant that does all three: `app.redeem_invite`, a SECURITY DEFINER
 * function whose seat check is the memberships trigger itself. Granting
 * app_user a direct INSERT would open a second door into a room whose lock is
 * on the first one.
 *
 * The honest replacement already exists and is what the product uses:
 * join-by-link invites (createInvite / redeemInvite, migration 0003).
 */
