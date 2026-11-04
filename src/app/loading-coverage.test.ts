import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * ⛔ EVERY CLIENT PAGE THAT FETCHES ON MOUNT SHOWS A WIREFRAME WHILE IT LOADS.
 *
 * The skeleton system once shipped across 26 screens and four were missed
 * (in the parent codebase this app was forked from). Missing one is invisible
 * in review — the page works, it just blinks blank first — and it is worst
 * exactly on a first impression.
 *
 * So coverage is asserted rather than remembered. A new page that fetches on
 * mount and forgets its loading state fails the build.
 *
 * Exemptions are LISTED WITH A REASON, not inferred. "It doesn't need one" has
 * to be a decision somebody wrote down, because that is exactly the sentence
 * that hides the four this test was written to find.
 */

const APP = join(process.cwd(), "src", "app");

/** Pages that legitimately have no loading state, and why. */
const EXEMPT: Record<string, string> = {
  "src/app/login/page.tsx":
    "renders instantly from static markup — a skeleton here is pure flash",
  "src/app/page.tsx": "static shell, no fetch on mount",
  "src/app/data-deletion/page.tsx":
    "public server component, no fetch on mount — a reviewer opens it in a clean browser and it renders identically for everyone",
  "src/app/reset-password/page.tsx":
    "static form; the config fetch gates only the submit button, same as login",
};

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (entry === "page.tsx") out.push(full);
  }
  return out;
}

const pages = walk(APP).map((f) => ({
  rel: f.slice(process.cwd().length + 1).replace(/\\/g, "/"),
  src: readFileSync(f, "utf8"),
}));

/** Does this page load data after mount? Then a person waits, and sees something. */
function fetchesOnMount(src: string): boolean {
  return /useEffect\(/.test(src) && /\bapi<|\bapi\(|fetch\(/.test(src);
}

function hasWireframe(src: string): boolean {
  // SkeletonRegion and the bare <Skel> primitive count too — /book/[slug]
  // uses those rather than the PageSkeleton preset, and a detector that
  // missed them would have reported a page that IS covered.
  return /PageSkeleton|SkeletonRegion|<Skel|Skel(Rows|Table|Stats|Form|Text)/.test(src);
}

describe("wireframe loading coverage", () => {
  const clientPages = pages.filter((p) => p.src.startsWith('"use client"'));

  it("finds the app's client pages at all (guards against a broken glob)", () => {
    // Without this, a bad path would make every assertion below pass vacuously
    // over an empty list.
    // The P0 spine keeps 7 client pages (dashboard, account, billing,
    // security, team, memberships, login); the bound guards the glob, not
    // the product's eventual size.
    expect(clientPages.length).toBeGreaterThan(5);
  });

  it("⛔ every client page that fetches on mount renders a wireframe", () => {
    const gaps = clientPages
      .filter((p) => fetchesOnMount(p.src) && !hasWireframe(p.src) && !EXEMPT[p.rel])
      .map((p) => p.rel);
    expect(
      gaps,
      "these pages fetch after mount and show nothing while they wait — add PageSkeleton + useFirstLoad, or list them in EXEMPT with a reason",
    ).toEqual([]);
  });

  it("a page with a wireframe also LATCHES it, so saving never re-flashes", () => {
    // useFirstLoad latches: the skeleton shows once per visit, never again
    // after a mutation's refetch. Without it, every save strobes the page and
    // a screen reader re-announces "loading" each time.
    const unlatched = clientPages
      .filter((p) => hasWireframe(p.src) && !/useFirstLoad/.test(p.src))
      .map((p) => p.rel);
    expect(unlatched).toEqual([]);
  });

  it("every exemption names a real file", () => {
    // A stale exemption silently re-opens the hole it was written to allow.
    const all = new Set(pages.map((p) => p.rel));
    expect(Object.keys(EXEMPT).filter((f) => !all.has(f))).toEqual([]);
  });
});

/**
 * ⛔ GRID PROPERTIES DO NOTHING INSIDE A FLEX CONTAINER.
 *
 * `.stepup` was written with `grid-column: 1 / -1` to span the shell's width.
 * `.app` is `display: flex`, so the declaration was inert and the bar became
 * an ordinary flex ITEM in the sidebar+content row — taking ~1000px, shoving
 * the sidebar to the right edge, and collapsing the page content to ZERO
 * width. The whole app rendered as an empty page on every desktop viewport,
 * on the PUBLIC DEMO, and nothing caught it because the bar only renders for
 * the demo seat or a 2FA prompt.
 *
 * The rule generalises: a layout property that belongs to the OTHER layout
 * mode is not a no-op you can leave lying around — it is a silent lie about
 * what the element will do.
 */
describe("no grid properties on flex children", () => {
  // Comments stripped first. The rule now carries a comment EXPLAINING the
  // grid-column bug, and a test that fails on its own prose is a test nobody
  // trusts. (Second time today — worth remembering as a habit, not a one-off.)
  const css = readFileSync(join(APP, "globals.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

  it("`.app` is still the flex row these rules assume", () => {
    expect(css).toMatch(/\.app\s*\{[^}]*display:\s*flex/);
  });

  it("⛔ .stepup does not try to span with grid-column", () => {
    const rule = /\.stepup\s*\{[^}]*\}/.exec(css)?.[0] ?? "";
    expect(rule).not.toMatch(/grid-column|grid-row|grid-area/);
  });
});
