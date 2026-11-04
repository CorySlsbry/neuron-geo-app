// Pure authorization guards — no I/O, unit-tested exhaustively.
import { HttpError } from "@/lib/http/errors";
import type { ResolvedScope, Role } from "./directory";

export class AuthError extends HttpError {
  constructor(status: 401 | 402 | 403 | 404 | 409 | 410 | 422, code: string) {
    super(status, code);
  }
}

export interface ScopeRequirements {
  /** Restrict to these roles (e.g. ["owner","admin"]). Empty = any member. */
  roles?: readonly Role[];
  /** Require access to ALL of these department keys. */
  departments?: readonly string[];
  /** Require a verified second factor (financial/HR surfaces). */
  aal2?: boolean;
  /**
   * This request CHANGES tenant data, so it requires a subscription in good
   * standing (active / trialing / past_due within grace) — the paywall.
   * Reads never set it: a lapsed card degrades a tenant to read-only, it
   * never holds the data hostage. Billing and account routes never set it
   * either, or the customer couldn't pay their way back in or leave.
   */
  write?: boolean;
}

/**
 * The one place scope requirements are checked. Owner/admin implicitly hold
 * every department wall (they administer them); other roles need explicit
 * per-person grants. Throws AuthError(403) — never returns a partial scope.
 */
/**
 * Roles allowed to CHANGE anything.
 *
 * `viewer` is sold as look-don't-touch on the Team screen, and `bookkeeper` is
 * the CPA's read + financials seat. Neither is enforced by RLS — the policies
 * are tenant-scoped, not role-scoped — so in the parent codebase, before this
 * existed, a viewer could POST to a mutating route and change records the
 * Team screen promised they couldn't touch. Write authorization has to be
 * stated, not assumed default-open.
 *
 * Surfaces where a bookkeeper legitimately writes (financial workflows) name
 * the roles they accept explicitly instead of using this.
 */
export const WRITE_ROLES = ["owner", "admin", "staff"] as const;

/**
 * Roles that may change MONEY records — WRITE_ROLES plus the bookkeeper.
 *
 * The structural lesson (paid for in the parent codebase): twelve mutating
 * financial routes shipped with a department requirement and NO role
 * requirement, because WRITE_ROLES omits `bookkeeper` and the CPA
 * legitimately writes on financial surfaces — so rather than lock the CPA
 * out, the roles key got dropped entirely, and `viewer` ("look, don't
 * touch") could mutate money records. When a money surface exists here, it
 * names THIS set: everyone but the viewer.
 */
export const BOOKS_ROLES = ["owner", "admin", "staff", "bookkeeper"] as const;

/**
 * Does this scope stand on the far side of a department wall?
 *
 * Extracted because (in the parent codebase) a second caller appeared: a
 * surface that shows a NARROWER answer to someone without the wall instead
 * of refusing them — so it has to ASK the question rather than be stopped by
 * it.
 *
 * ⛔ It must be this exact rule, not a restatement. The owner/admin implicit
 * grant is easy to forget, and forgetting it hands the owner the redacted
 * partial view of their own data — a bug that reads as "the feature is
 * broken" rather than as an authz error, and so gets "fixed" by widening
 * something. One rule, every caller.
 */
export function holdsDepartments(
  scope: ResolvedScope,
  departments: readonly string[],
): boolean {
  if (departments.length === 0) return true;
  // Owner/admin implicitly hold every wall — they administer them.
  if (scope.role === "owner" || scope.role === "admin") return true;
  const held = new Set(scope.departments);
  return departments.every((d) => held.has(d));
}

export function checkScope(
  scope: ResolvedScope,
  aal: "aal1" | "aal2",
  req: ScopeRequirements = {},
): void {
  if (req.aal2 && aal !== "aal2") {
    throw new AuthError(403, "aal2_required");
  }
  if (req.roles && req.roles.length > 0 && !req.roles.includes(scope.role)) {
    throw new AuthError(403, "role_forbidden");
  }
  if (req.departments && req.departments.length > 0) {
    if (!holdsDepartments(scope, req.departments)) {
      throw new AuthError(403, "department_forbidden");
    }
  }
}
