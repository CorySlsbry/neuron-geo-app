import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

/**
 * ⛔ NEVER RE-DECLARE A SHAPE SOMEONE ELSE ALREADY READS.
 *
 * ── The bug this exists to prevent, which already happened ────────────────
 * The sealed OAuth payload's field is `access`. A second reader, written from
 * memory in a different module, said `accessToken`:
 *
 *     const payload = JSON.parse(open(sealed)) as { accessToken?: string };
 *     accessToken = payload.accessToken ?? null;      // always null
 *
 * That compiles. It never throws. It silently returns null — which every
 * caller correctly interprets as "no credential is stored". The result would
 * have been a publish path that refuses every valid token while reporting
 * exactly the message it reports when the customer has connected nothing at
 * all: a bug with no stack trace, no failing test, and a plausible-sounding
 * error message. It was found by an unrelated lint rule, by luck.
 *
 * The root cause is not a typo. It is that a type ASSERTION on parsed data is
 * a claim the compiler is instructed to stop checking, so an invented field
 * name is indistinguishable from a real one. The fix is structural: one named
 * type, declared beside the writer, imported by every reader.
 *
 * ── Why this is a test and not a note in a playbook ──────────────────────
 * A checklist depends on the person who skipped it. This runs on every commit.
 * The vault's PREFLIGHT rule (Coding-Standards § PREFLIGHT, P-1/P-2) says the
 * same thing in prose; this is the half that cannot be forgotten.
 */

const SRC = join(process.cwd(), "src");

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

/**
 * `JSON.parse(...) as { ... }` — an inline object literal asserted onto parsed
 * data. Matches across newlines, because the real-world version of this is
 * usually wrapped by a formatter.
 *
 * Deliberately NOT matched: `as SomeNamedType`. A named type is exactly the
 * remedy — it has one declaration, so a reader and a writer that disagree fail
 * to compile instead of disagreeing quietly.
 */
const INLINE_SHAPE_ASSERTION = /JSON\.parse\s*\([\s\S]{0,200}?\)\s*as\s*\{/g;

/**
 * The looser cousin: `as unknown as T`, which launders any value into any type
 * and defeats every check that would have caught a shape mismatch.
 */
const DOUBLE_ASSERTION = /\bas\s+unknown\s+as\s+/g;

describe("parsed data is never given an invented shape", () => {
  it("no file asserts an inline object literal onto JSON.parse", () => {
    const offenders: string[] = [];
    for (const file of walk(SRC)) {
      const src = readFileSync(file, "utf8");
      if (INLINE_SHAPE_ASSERTION.test(src)) offenders.push(relative(process.cwd(), file));
      INLINE_SHAPE_ASSERTION.lastIndex = 0;
    }

    expect(
      offenders,
      `These files assert an inline shape onto parsed data:\n` +
        offenders.map((f) => `  ${f}`).join("\n") +
        `\n\nAn inline \`as { ... }\` on JSON.parse tells the compiler to stop\n` +
        `checking, so a field name invented from memory looks exactly like a\n` +
        `real one and yields undefined at runtime. Find whatever WRITES this\n` +
        `payload, declare one exported type beside it, and use that type on\n` +
        `both sides. See SealedTokens in modules/channels/internal/store.ts\n` +
        `for the pattern, and Coding-Standards § PREFLIGHT P-1 for the rule.`,
    ).toEqual([]);
  });

  it("no file launders a value through `as unknown as`", () => {
    const offenders: string[] = [];
    for (const file of walk(SRC)) {
      const src = readFileSync(file, "utf8");
      if (DOUBLE_ASSERTION.test(src)) offenders.push(relative(process.cwd(), file));
      DOUBLE_ASSERTION.lastIndex = 0;
    }

    expect(
      offenders,
      `These files use \`as unknown as\`:\n` +
        offenders.map((f) => `  ${f}`).join("\n") +
        `\n\nThat is the strongest way to tell TypeScript it is wrong, and it is\n` +
        `almost never what you mean outside a test double. If a value genuinely\n` +
        `arrives untyped from outside the program, validate it at the boundary\n` +
        `instead of asserting it past one.`,
    ).toEqual([]);
  });
});

describe("the guard can actually catch what it claims to", () => {
  // A regex that matches nothing is a gate that passes because it found no
  // work to do. Same fail-open shape as the pgTAP runner's old bug, so the
  // patterns are tested against the exact code that caused the incident.
  it("matches the real bug", () => {
    const bug = `const payload = JSON.parse(open(sealed.toString("utf8"))) as {
        accessToken?: string;
      };`;
    expect(INLINE_SHAPE_ASSERTION.test(bug)).toBe(true);
    INLINE_SHAPE_ASSERTION.lastIndex = 0;
  });

  it("leaves the remedy alone", () => {
    const fixed = `const payload: SealedTokens = JSON.parse(open(sealed.toString("utf8")));`;
    const named = `pending = JSON.parse(raw) as PendingConnect;`;
    expect(INLINE_SHAPE_ASSERTION.test(fixed)).toBe(false);
    INLINE_SHAPE_ASSERTION.lastIndex = 0;
    expect(INLINE_SHAPE_ASSERTION.test(named)).toBe(false);
    INLINE_SHAPE_ASSERTION.lastIndex = 0;
  });

  it("matches a double assertion", () => {
    expect(DOUBLE_ASSERTION.test(`foo as unknown as Bar`)).toBe(true);
    DOUBLE_ASSERTION.lastIndex = 0;
  });
});
