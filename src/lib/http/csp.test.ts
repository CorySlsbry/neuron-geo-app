import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The CSP the application actually sends, asserted as text.
 *
 * This is a structural test rather than a runtime one because the header is
 * built in `proxy.ts`, which runs in the edge runtime and is awkward to invoke
 * from a unit test. Reading the source is enough: the failure mode being
 * guarded is somebody *deleting a line*, not somebody computing it wrongly.
 */
const PROXY = readFileSync(join(process.cwd(), "src", "proxy.ts"), "utf8");

describe("content security policy", () => {
  it("⛔ allows style ATTRIBUTES, or the whole UI silently loses its styling", () => {
    // A nonce cannot be attached to a style="…" attribute, and when
    // style-src-attr is absent it falls back to style-src. Without this line
    // every React style={{}} in the app is parsed and discarded: pages keep
    // their class-based layout and quietly lose spacing, progress-bar widths,
    // skeleton dimensions and the red/green on money figures.
    //
    // It reads like a loosening and is the opposite: it is what makes the
    // strict style-src above survivable.
    expect(PROXY).toContain("style-src-attr 'unsafe-inline'");
  });

  it("keeps stylesheets and <style> elements nonce-locked", () => {
    // The narrow allowance above must not become a blanket one.
    expect(PROXY).toContain("style-src 'self' 'nonce-${nonce}'");
    expect(PROXY).not.toContain("style-src 'self' 'unsafe-inline'");
  });

  it("keeps scripts on nonce + strict-dynamic", () => {
    expect(PROXY).toContain("'strict-dynamic'");
    // 'unsafe-inline' on scripts would be the actual security hole this file
    // exists to keep separate in everyone's mind from the style-attr line.
    expect(PROXY).not.toContain("script-src 'self' 'unsafe-inline'");
  });

  it("still refuses framing, plugins and stray base tags", () => {
    for (const directive of [
      "object-src 'none'",
      "base-uri 'self'",
      "form-action 'self'",
      "frame-ancestors 'none'",
      "upgrade-insecure-requests",
    ]) {
      expect(PROXY, directive).toContain(directive);
    }
  });
});
