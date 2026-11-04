import { afterEach, describe, expect, it, vi } from "vitest";
import { __resetRateLimits, clientKey, consume } from "./rate-limit";

afterEach(() => {
  __resetRateLimits();
  vi.useRealTimers();
});

describe("consume", () => {
  const rule = { limit: 3, windowMs: 1000 };

  it("allows up to the limit then blocks", () => {
    expect(consume("k", rule).allowed).toBe(true);
    expect(consume("k", rule).allowed).toBe(true);
    expect(consume("k", rule).allowed).toBe(true);
    expect(consume("k", rule).allowed).toBe(false);
  });

  it("keys are independent", () => {
    for (let i = 0; i < 3; i++) consume("a", rule);
    expect(consume("a", rule).allowed).toBe(false);
    expect(consume("b", rule).allowed).toBe(true);
  });

  it("refills over time", () => {
    vi.useFakeTimers();
    for (let i = 0; i < 3; i++) consume("k", rule);
    expect(consume("k", rule).allowed).toBe(false);
    vi.advanceTimersByTime(400); // ~1.2 tokens back
    expect(consume("k", rule).allowed).toBe(true);
  });

  it("reports a usable Retry-After", () => {
    for (let i = 0; i < 3; i++) consume("k", rule);
    const r = consume("k", rule);
    expect(r.allowed).toBe(false);
    expect(r.retryAfter).toBeGreaterThanOrEqual(0);
  });

  /**
   * Continuous refill, not fixed windows: a fixed-window limiter lets a caller
   * spend the whole allowance at the end of one window and again at the start
   * of the next — 2x the intended rate, right when it matters.
   */
  it("does not permit a double burst across a window boundary", () => {
    vi.useFakeTimers();
    for (let i = 0; i < 3; i++) expect(consume("k", rule).allowed).toBe(true);
    vi.advanceTimersByTime(1000);
    let allowed = 0;
    for (let i = 0; i < 6; i++) if (consume("k", rule).allowed) allowed++;
    expect(allowed).toBeLessThanOrEqual(3);
  });
});

describe("clientKey", () => {
  /**
   * Take the LAST x-forwarded-for entry, not the first. Callers can prepend
   * anything they like; only the trailing hop is appended by infrastructure
   * they don't control. Reading from the left is the classic way to ship a
   * limiter anyone can bypass with one header.
   */
  it("uses the last forwarded-for hop, not a caller-supplied one", () => {
    const h = new Headers({ "x-forwarded-for": "1.1.1.1, 2.2.2.2, 3.3.3.3" });
    expect(clientKey(h)).toBe("3.3.3.3");
  });

  it("falls back to x-real-ip, then a constant", () => {
    expect(clientKey(new Headers({ "x-real-ip": "9.9.9.9" }))).toBe("9.9.9.9");
    expect(clientKey(new Headers())).toBe("unknown");
  });

  it("ignores an empty forwarded-for", () => {
    expect(clientKey(new Headers({ "x-forwarded-for": "" }))).toBe("unknown");
  });
});
