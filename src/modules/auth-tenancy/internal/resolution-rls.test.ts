import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * The law this file exists to hold: A TABLE USED TO RESOLVE TENANCY CANNOT BE
 * FORCE-SCOPED BY TENANCY.
 *
 * `SECURITY DEFINER` runs as the table's owner. `FORCE ROW LEVEL SECURITY` is
 * exactly the setting that makes policies bind the owner too. Every resolution
 * function answers a question asked BEFORE a session exists — so
 * `app.current_tenant` is unset, the policy matches nothing, and the function
 * returns NULL. Not an error. Not a log line. Just NULL, which every caller
 * then handles politely as "not found".
 *
 * It cost the parent codebase (topbuilder-os) three production outages —
 * inbound SMS routing, the customer portal, and the Stripe billing webhook's
 * tenant lookup all died silently to the same cause (its migrations 0040/0041).
 *
 * Three times is not a fluke, and a comment did not stop it. pgTAP would be the
 * natural home for this, but the pgTAP runner needs Docker and CI does not have
 * it — so the check lives here, reads the migrations, and runs on every commit.
 *
 * ── Adding a SECURITY DEFINER function? ───────────────────────────────────
 * This test will fail until you list it below and state which tables it reads.
 * That is the point: the decision gets made in writing, once, by a person.
 */

const MIGRATIONS = join(process.cwd(), "migrations");

/** Every SECURITY DEFINER function in the schema, and what it touches. */
const DEFINER_FUNCTIONS: Record<
  string,
  {
    /** Tables it reads BEFORE a tenant scope exists. These must never be FORCE. */
    resolves: string[];
    why: string;
  }
> = {
  // ---- resolution: reached with no session at all -------------------------
  tenant_by_stripe_customer: {
    resolves: ["subscriptions"],
    why: "Stripe payload tenant ids are not trusted, so this lookup IS the resolution",
  },

  provision_tenant: {
    resolves: ["tenants", "memberships"],
    why: "signup: it CREATES the tenant, so there is nothing to scope by yet",
  },

  redeem_invite: {
    resolves: ["invites", "memberships"],
    why: "invite redemption: the redeeming user is NOT yet a member — the token is the authorization, so the lookup runs pre-scope",
  },

  // ---- the worker definers (0005): pre-scope, but scoped by ROLE ----------
  // ⛔ READ THIS BEFORE ADDING ANOTHER ONE.
  //
  // `resolves` means "tables this reads before a tenant scope exists, which
  // therefore must never be FORCE". These six read `jobs` with no tenant GUC
  // set, so the naive entry would be `resolves: ["jobs"]` — and that would
  // demand `jobs` stop being FORCE, which would be a real weakening for a
  // table holding every tenant's queue.
  //
  // They are listed as `resolves: []` because 0005 solves the FORCE trap a
  // different way: the functions are OWNED BY app_worker, and `jobs` carries
  // an explicit `TO app_worker USING (true)` policy alongside the tenant-
  // scoped `TO app_user` one. The owner is bound by policies under FORCE, as
  // always — it just has a policy that matches. Scoped by role, not by GUC.
  //
  // That escape hatch is only true while the ownership and the policy both
  // exist, so neither is left to a comment: the "worker definers" describe
  // block below asserts both, and `resolves: []` is honest only because it
  // passes.
  claim_next_job: {
    resolves: [],
    why: "reads jobs pre-scope, but is owned by app_worker which has an explicit policy on jobs; sets the tenant GUC from the claimed row before anything else is touched",
  },
  heartbeat_job: {
    resolves: [],
    why: "touches only jobs/job_workers by id, as app_worker; extends a lease it already holds",
  },
  worker_checkin: {
    resolves: [],
    why: "job_workers only — fleet liveness, no tenant data of any kind",
  },
  complete_publish: {
    resolves: [],
    why: "reads its own job row as app_worker, then SETS the tenant GUC from that row before touching content_items",
  },
  fail_job: {
    resolves: [],
    why: "same shape as complete_publish: job row first, then scope, then the content item",
  },
  reap_expired_leases: {
    resolves: [],
    why: "jobs only, by lease expiry; touches no tenant-owned table at all",
  },
  abandon_job: {
    resolves: [],
    why: "terminal failure (0006): job row first as app_worker, then scope, then one event row",
  },

  // ---- not resolution: called with a scope already established ------------
  purge_current_tenant: { resolves: [], why: "acts on the ALREADY-scoped tenant" },
  enforce_seat_cap: { resolves: [], why: "trigger, runs inside the caller's scoped transaction" },
  assert_valid_timezone: { resolves: [], why: "trigger; validates the row being written" },
  can_see_department: { resolves: [], why: "reads the request's own GUCs" },
  current_tenant: { resolves: [], why: "reads the GUC" },
  current_uid: { resolves: [], why: "reads the GUC" },
  current_departments: { resolves: [], why: "reads the GUC" },
};

function migrationFiles(): string[] {
  return readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith(".sql"))
    .sort();
}

function allSql(): string {
  return migrationFiles()
    .map((f) => readFileSync(join(MIGRATIONS, f), "utf8"))
    .join("\n");
}

/**
 * The FINAL force state of a table, replaying migrations in order — because
 * `ALTER TABLE x NO FORCE` in a later migration must beat `FORCE` in an
 * earlier one. Reading the whole corpus for the word FORCE would get this
 * exactly backwards.
 */
function finalForceState(table: string): "force" | "no-force" | "absent" {
  let state: "force" | "no-force" | "absent" = "absent";
  const force = new RegExp(`ALTER\\s+TABLE\\s+${table}\\s+FORCE\\s+ROW\\s+LEVEL\\s+SECURITY`, "i");
  const noForce = new RegExp(
    `ALTER\\s+TABLE\\s+${table}\\s+NO\\s+FORCE\\s+ROW\\s+LEVEL\\s+SECURITY`,
    "i",
  );
  for (const f of migrationFiles()) {
    const sql = readFileSync(join(MIGRATIONS, f), "utf8");
    // NO FORCE first: "ALTER TABLE x FORCE" is a substring of "…NO FORCE…"
    // only in the reader's head, but the regexes must still be applied in an
    // order where the more specific one wins per file.
    if (noForce.test(sql)) state = "no-force";
    else if (force.test(sql)) state = "force";
  }
  return state;
}

const RESOLUTION_TABLES = [
  ...new Set(Object.values(DEFINER_FUNCTIONS).flatMap((d) => d.resolves)),
];

describe("resolution tables are never FORCE-scoped", () => {
  it.each(RESOLUTION_TABLES)("%s is not FORCE", (table) => {
    const state = finalForceState(table);
    expect(
      state,
      `${table} is read by a SECURITY DEFINER function before a session exists.\n` +
        `FORCE makes RLS bind the owner, so that lookup returns NOTHING and the\n` +
        `feature fails silently. Use ENABLE + a policy, never FORCE. See 0041.`,
    ).not.toBe("force");
  });

  // The matching "RLS is still ENABLED and a policy still exists" assertion is
  // deliberately NOT here. Some tables get theirs through dynamic SQL (0020
  // enables RLS for three tables in a FOREACH loop), so grepping the source
  // reports a false failure — which is the exact class of mistake this file
  // exists to prevent. That assertion belongs against reality, and it lives in
  // migration 0041's verification block, which reads pg_class and pg_policies
  // and refuses to finish if either is wrong.
});

describe("every SECURITY DEFINER function is accounted for", () => {
  it("no unlisted definer function exists", () => {
    const sql = allSql();
    const found = new Set<string>();
    // CREATE [OR REPLACE] FUNCTION app.<name>( … ) … SECURITY DEFINER
    const re = /CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+app\.(\w+)\s*\(([\s\S]*?)\$(\w*)\$/gi;
    let m: RegExpExecArray | null;
    while ((m = re.exec(sql)) !== null) {
      if (/SECURITY\s+DEFINER/i.test(m[2]!)) found.add(m[1]!);
    }
    const unlisted = [...found].filter((n) => !(n in DEFINER_FUNCTIONS));
    expect(
      unlisted,
      `these SECURITY DEFINER functions are not listed in DEFINER_FUNCTIONS:\n` +
        `  ${unlisted.join("\n  ")}\n` +
        `Add each one with the tables it reads BEFORE a tenant scope exists.\n` +
        `If it reads none, say so — an empty list is a decision on the record.`,
    ).toEqual([]);
  });

  it("the list has no stale entries", () => {
    const sql = allSql();
    const stale = Object.keys(DEFINER_FUNCTIONS).filter(
      (n) => !new RegExp(`FUNCTION\\s+app\\.${n}\\s*\\(`, "i").test(sql),
    );
    expect(stale, `listed functions that no longer exist: ${stale.join(", ")}`).toEqual([]);
  });
});

/**
 * The worker definers (0005) claim `resolves: []` while genuinely reading a
 * FORCE table with no tenant GUC. That claim rests on two facts, and this
 * block is what keeps them facts.
 *
 * Take either one away — reassign a function to the migration role, or drop
 * the app_worker policy on `jobs` — and those functions silently start
 * returning nothing on Cloud SQL while continuing to pass locally, because a
 * local superuser owner bypasses RLS outright. That is precisely the
 * dev-green/prod-dead failure the file above exists to prevent, so it gets
 * asserted rather than described.
 */
describe("the worker definers are scoped by role, not left to chance", () => {
  const WORKER_DEFINERS = [
    "claim_next_job",
    "heartbeat_job",
    "worker_checkin",
    "complete_publish",
    "fail_job",
    "reap_expired_leases",
    "abandon_job",
  ];

  it.each(WORKER_DEFINERS)("app.%s is owned by app_worker", (fn) => {
    const sql = allSql();
    const owned = new RegExp(
      `ALTER\\s+FUNCTION\\s+app\\.${fn}\\s*\\([^)]*\\)\\s*OWNER\\s+TO\\s+app_worker`,
      "i",
    ).test(sql);
    expect(
      owned,
      `app.${fn} is SECURITY DEFINER and reads a FORCE table before any tenant\n` +
        `scope exists. It is only safe because it runs as app_worker, which has\n` +
        `an explicit policy on jobs. Without the OWNER TO app_worker it runs as\n` +
        `the migration role, matches no policy on Cloud SQL, and returns NULL —\n` +
        `passing every local test on the way.`,
    ).toBe(true);
  });

  it("jobs carries the app_worker policy those functions depend on", () => {
    const sql = allSql();
    expect(
      /CREATE\s+POLICY\s+\w+\s+ON\s+jobs[\s\S]{0,120}?TO\s+app_worker/i.test(sql),
      "jobs must keep a policy TO app_worker; it is what makes the definers' " +
        "`resolves: []` true instead of merely convenient.",
    ).toBe(true);
  });

  it("jobs is still FORCE — the role policy is not an excuse to relax it", () => {
    expect(finalForceState("jobs")).toBe("force");
  });
});
