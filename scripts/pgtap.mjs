/**
 * Runs every `test/db/*.test.sql` pgTAP suite against the local Postgres
 * container. Cross-platform (Node + `docker exec`), so it works the same
 * locally and in CI.
 *
 *   pnpm test:db
 *
 * ⚠️ This runner USED TO FAIL OPEN, and did so silently for real commits.
 *
 * It counted `not ok` lines and failed only when it found one. A file that
 * aborted on its FIRST statement produced no `ok` lines and no `not ok` lines,
 * so it reported "0 assertions, 0 failed" and the run ended in "all passed".
 * That is exactly what happened to 0020_financial_depth.test.sql after
 * migration 0028 dropped `payroll_runs`: six real assertions — append-only
 * enforcement and cross-tenant isolation among them — stopped running, and
 * every "pgTAP: all passed" afterwards was a lie.
 *
 * The rule now: a suite must run EXACTLY the number of assertions it declared
 * in `plan(N)`, that number must be > 0, and any psql ERROR fails the run.
 * Absence of failure is not evidence of success — you have to count.
 */
import { readdirSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const container = process.env.PGTAP_CONTAINER ?? "neurongeo-db";
/**
 * Which database to assert against. Overridable so the FRESH-REPLAY gate can
 * be run for real: create an empty database, `pnpm migrate` the whole chain
 * from 0000 into it, then point this at it. Asserting only against the
 * long-lived dev database proves the schema works after the migrations it
 * happens to have received in the order it happened to receive them — not
 * that the chain replays.
 */
const database = process.env.PGTAP_DB ?? "neurongeo";
const dir = "test/db";

let failed = false;
const files = readdirSync(dir)
  .filter((f) => f.endsWith(".test.sql"))
  .sort();

if (files.length === 0) {
  // An empty suite directory is itself a failure signal: `pnpm test:db` is a
  // required gate, and a gate that passes because it found nothing to check
  // is the same fail-open bug in a different costume.
  console.error("pgTAP: no suites found in test/db/ — refusing to report success");
  process.exit(1);
}

/** The assertion count the suite DECLARES, read from its own `plan(N)`. */
function declaredPlan(sql) {
  const m = sql.match(/\bplan\s*\(\s*(\d+)\s*\)/i);
  return m ? Number(m[1]) : null;
}

for (const file of files) {
  const sql = readFileSync(`${dir}/${file}`, "utf8");
  const planned = declaredPlan(sql);
  let out = "";
  let crashed = false;
  try {
    out = execFileSync(
      "docker",
      [
        "exec",
        "-i",
        container,
        "psql",
        "-U",
        "postgres",
        "-d",
        database,
        "-tAq",
        // Stop at the first error so psql exits non-zero instead of limping
        // on inside an aborted transaction emitting nothing.
        "-v",
        "ON_ERROR_STOP=1",
      ],
      { input: sql, encoding: "utf8" },
    );
  } catch (err) {
    out = `${err.stdout ?? ""}${err.stderr ?? ""}`;
    crashed = true;
  }

  const results = out.split("\n").filter((l) => /^(not )?ok \d/.test(l));
  const failures = results.filter((l) => l.startsWith("not ok"));
  const errors = out
    .split("\n")
    .filter((l) => /^(psql:)?\s*ERROR:/i.test(l) || /^ERROR:/i.test(l));

  const problems = [];
  if (crashed) problems.push("psql exited non-zero");
  if (errors.length > 0) problems.push(`${errors.length} SQL error(s)`);
  if (planned === null) {
    problems.push("no plan(N) declared — cannot verify the suite ran");
  } else if (results.length !== planned) {
    // The check that would have caught 0020: declared 6, ran 0.
    problems.push(`ran ${results.length} of ${planned} planned assertions`);
  } else if (planned === 0) {
    problems.push("plan(0) — a suite that asserts nothing cannot pass");
  }
  if (failures.length > 0) problems.push(`${failures.length} assertion(s) failed`);

  const status = problems.length === 0 ? "PASS" : "FAIL";
  console.log(
    `== ${file} — ${status}: ${results.length}/${planned ?? "?"} assertions` +
      (problems.length ? ` — ${problems.join("; ")}` : ""),
  );
  for (const l of failures) console.log(`   ${l}`);
  for (const l of errors.slice(0, 5)) console.log(`   ${l.trim()}`);
  if (problems.length > 0) failed = true;
}

console.log(failed ? "pgTAP: FAILURES" : "pgTAP: all passed");
process.exit(failed ? 1 : 0);
