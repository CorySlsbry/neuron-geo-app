import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

/**
 * "Viewer — look, don't touch" is a PROMISE ON THE TEAM SCREEN. This test is
 * what makes it true.
 *
 * Twelve mutating routes shipped with a department requirement and no role
 * requirement, so a viewer holding the financials wall could import a bank
 * statement, reconcile an account, create vendors and bills, and issue
 * invoices. The structural cause: WRITE_ROLES omits `bookkeeper`, the CPA
 * legitimately reconciles, so rather than lock the CPA out the roles key was
 * dropped entirely. BOOKS_ROLES is the set those routes actually meant.
 *
 * A unit test can't exercise Next route handlers without a server, so this
 * reads the SOURCE and asserts the invariant structurally: every mutating
 * handler must state a role requirement. That is exactly the drift a future
 * route would reintroduce silently.
 */

const API_DIR = join(process.cwd(), "src", "app", "api");

function routeFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) routeFiles(full, acc);
    else if (entry === "route.ts") acc.push(full);
  }
  return acc;
}

/**
 * Routes whose mutating handler legitimately has NO role requirement, each
 * with the reason. An exemption is a decision on the record.
 */
const EXEMPT = new Map<string, string>([
  ["auth/login", "pre-membership: this is how you get a scope at all"],
  ["auth/dev-login", "pre-membership, dev-only"],
  ["auth/signup", "pre-membership: creates the tenant + owner"],
  ["auth/logout", "any authenticated principal may end their own session"],
  ["auth/select-tenant", "membership is re-verified inside selectTenant()"],
  [
    "invites/accept",
    "pre-membership: redeeming the invite is how this user gets a role in the tenant at all — the single-use token is the authorization",
  ],
  ["webhooks/stripe/billing", "machine principal, HMAC-verified"],
  ["account/export", "owner/admin gate lives in the handler + aal2"],
]);

describe("viewer is genuinely read-only", () => {
  const files = routeFiles(API_DIR);

  it("every mutating route states a role requirement", () => {
    const offenders: string[] = [];
    for (const file of files) {
      const src = readFileSync(file, "utf8");
      const rel = relative(API_DIR, file).split(sep).slice(0, -1).join("/");
      if (EXEMPT.has(rel)) continue;
      // Both spellings. The regex used to match only `export const POST`,
      // which is the form every route happened to use — until the OAuth
      // callback needed `export async function GET` (it returns redirects,
      // not the JSON envelope, so it cannot use the `route()` wrapper). A
      // detector that only knows one spelling silently stops guarding the
      // moment somebody writes the other one, and the guard reports green
      // either way.
      const mutates =
        /export const (POST|PATCH|PUT|DELETE)\b/.test(src) ||
        /export async function (POST|PATCH|PUT|DELETE)\b/.test(src);
      if (!mutates) continue;
      // A role requirement anywhere in the file: WRITE_ROLES, BOOKS_ROLES, or
      // an explicit roles: [...] literal.
      const statesRole =
        /WRITE_ROLES|BOOKS_ROLES/.test(src) || /roles:\s*\[/.test(src);
      if (!statesRole) offenders.push(rel);
    }
    expect(
      offenders,
      `these mutating routes accept ANY member, including a viewer:\n  ${offenders.join("\n  ")}`,
    ).toEqual([]);
  });

  it("the exemption list has no stale entries", () => {
    const all = new Set(
      files.map((f) => relative(API_DIR, f).split(sep).slice(0, -1).join("/")),
    );
    const stale = [...EXEMPT.keys()].filter((r) => !all.has(r));
    expect(stale, `exempted routes that no longer exist: ${stale.join(", ")}`).toEqual([]);
  });
});
