import { describe, expect, it } from "vitest";
import { checkSeat, explainSubscription, isUpgrade, PLAN_LIST, PLANS, planFor } from "./plans";

describe("plan catalog", () => {
  it("is flat-priced with the locked numbers", () => {
    // $89 / $199 are Cory's prices (plan spicy-noodling-pixel, 2026-08-14).
    expect(PLANS.start.priceCents).toBe(8_900);
    expect(PLANS.start.seatCap).toBe(2);
    expect(PLANS.growth.priceCents).toBe(19_900);
    expect(PLANS.growth.seatCap).toBe(10);
  });

  it("every plan resolves to a DISTINCT Stripe lookup_key", () => {
    // ⛔ Prices are resolved at runtime by lookup_key. Two plans sharing one
    // key would silently bill the wrong amount, and it would look correct on
    // every screen because the display price comes from priceCents, not from
    // Stripe. The keys embed the amount so a stale one is visible on sight.
    const keys = PLAN_LIST.map((p) => p.lookupKey);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys).toEqual(["geo_start_89", "geo_growth_199"]);
  });

  it("⛔ a tier buys CAPACITY (seats + allowances), never a feature switch", () => {
    // The moment a tier gates a capability, the product becomes an add-on
    // ladder. Seats and the usage allowances (posts, reels, AI budget) are
    // capacity, not switches — this asserts nobody added a boolean gate.
    for (const p of PLAN_LIST) {
      expect(Object.keys(p).sort()).toEqual([
        "aiBudgetUsd",
        "blurb",
        "includedPosts",
        "includedReels",
        "key",
        "lookupKey",
        "name",
        "priceCents",
        "seatCap",
      ]);
      expect(p.includedPosts).toBeGreaterThan(0);
      expect(p.includedReels).toBeGreaterThan(0);
      expect(p.aiBudgetUsd).toBeGreaterThan(0);
    }
  });

  it("PLAN_LIST is ordered cheapest first, which checkSeat depends on", () => {
    const prices = PLAN_LIST.map((p) => p.priceCents);
    const caps = PLAN_LIST.map((p) => p.seatCap);
    expect(prices).toEqual([...prices].sort((a, b) => a - b));
    expect(caps).toEqual([...caps].sort((a, b) => a - b));
  });

  it("resolves by key and rejects garbage", () => {
    expect(planFor("start").name).toBe("Start");
    expect(planFor("growth").name).toBe("Growth");
    expect(() => planFor("enterprise")).toThrow();
    expect(() => planFor("crew")).toThrow(); // a parent-catalog key stays dead
  });
  it("knows which direction a plan change goes", () => {
    expect(isUpgrade("start", "growth")).toBe(true);
    expect(isUpgrade("growth", "start")).toBe(false);
  });
});

describe("checkSeat", () => {
  it("allows while spots remain and counts them honestly", () => {
    const r = checkSeat("growth", 7);
    expect(r.allowed).toBe(true);
    expect(r.message).toBe("3 of your 10 spots are open.");
  });
  it("⛔ the second person on Start does NOT trigger an upgrade", () => {
    // The whole point of a cap of 2: a founder plus the one person helping
    // them should never be pushed up a tier for existing.
    const r = checkSeat("start", 1);
    expect(r.allowed).toBe(true);
    expect(r.message).toBe("1 of your 2 spots is open.");
  });
  it("the third person moves them UP ONE rung", () => {
    const r = checkSeat("start", 2);
    expect(r.allowed).toBe(false);
    expect(r.suggestPlan).toBe("growth");
    expect(r.message).toContain("$199/mo");
    expect(r.message).toContain("10");
  });
  it("at the top plan it points to a human, not a dead end", () => {
    const r = checkSeat("growth", 10);
    expect(r.allowed).toBe(false);
    expect(r.suggestPlan).toBeNull();
    expect(r.message).toContain("Give us a call");
  });
});

describe("explainSubscription", () => {
  const base = {
    plan: "growth" as const,
    status: "active",
    cancelAtPeriodEnd: false,
    currentPeriodEnd: "2026-08-24T00:00:00Z",
    trialEndsAt: null,
  };
  it("states the active plan with figures verbatim", () => {
    expect(explainSubscription(base)).toBe(
      "You're on Growth: $199 a month, up to 10 people, everything included. Renews 2026-08-24.",
    );
  });
  it("states the bottom tier with its price verbatim too", () => {
    expect(explainSubscription({ ...base, plan: "start" })).toBe(
      "You're on Start: $89 a month, up to 2 people, everything included. Renews 2026-08-24.",
    );
  });
  it("a pending cancel says exactly when it ends and how to undo", () => {
    const t = explainSubscription({ ...base, cancelAtPeriodEnd: true });
    expect(t).toContain("ends 2026-08-24");
    expect(t).toContain("brings it back");
  });
  it("past due never implies data loss", () => {
    const t = explainSubscription({ ...base, status: "past_due" });
    expect(t).toMatch(/nothing has been deleted/i);
  });
  it("canceled still promises the data", () => {
    expect(explainSubscription({ ...base, status: "canceled" })).toContain("still yours");
  });
});
