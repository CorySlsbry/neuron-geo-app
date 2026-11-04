import { describe, expect, it } from "vitest";
import {
  PAST_DUE_GRACE_DAYS,
  subscriptionAccess,
  type GateRow,
} from "./subscription-gate";

/**
 * The paywall matrix — status × clock, every cell pinned. This function is
 * the entire write-access decision (requireScope({write:true}) throws 402 on
 * anything but "full"), so the matrix IS the paywall's behavior spec:
 *
 *   status     | condition                       | writes | reads
 *   -----------+---------------------------------+--------+------
 *   active     | always                          | yes    | yes
 *   trialing   | trial_ends_at in the future     | yes    | yes
 *   trialing   | trial_ends_at passed (or absent)| no     | yes
 *   past_due   | within 7-day grace              | yes    | yes
 *   past_due   | grace exhausted (or no anchor)  | no     | yes
 *   canceled   | always                          | no     | yes
 *   (unknown)  | always — fail closed            | no     | yes
 *
 * Reads are never blocked anywhere: that column is enforced by the ABSENCE
 * of the gate on read paths, which is why every read_only row here still
 * describes a working, viewable tenant.
 */

const NOW = new Date("2026-08-14T12:00:00Z");
const DAY = 24 * 60 * 60 * 1000;

function iso(offsetDays: number): string {
  return new Date(NOW.getTime() + offsetDays * DAY).toISOString();
}

function row(partial: Partial<GateRow> & { status: string }): GateRow {
  return {
    trialEndsAt: null,
    currentPeriodEnd: null,
    updatedAt: iso(-1),
    ...partial,
  };
}

describe("subscriptionAccess", () => {
  it("active is full access", () => {
    const a = subscriptionAccess(row({ status: "active", currentPeriodEnd: iso(20) }), NOW);
    expect(a).toEqual({ state: "full", reason: "active", until: iso(20) });
  });

  it("a live trial is full access, until its end date", () => {
    const a = subscriptionAccess(row({ status: "trialing", trialEndsAt: iso(10) }), NOW);
    expect(a).toEqual({ state: "full", reason: "trialing", until: iso(10) });
  });

  it("an EXPIRED trial is read-only", () => {
    const a = subscriptionAccess(row({ status: "trialing", trialEndsAt: iso(-1) }), NOW);
    expect(a.state).toBe("read_only");
    expect(a.reason).toBe("trial_expired");
  });

  it("a trial expiring THIS instant is already read-only (boundary is closed)", () => {
    const a = subscriptionAccess(
      row({ status: "trialing", trialEndsAt: NOW.toISOString() }),
      NOW,
    );
    expect(a.state).toBe("read_only");
  });

  it("a trialing row with NO end date fails closed", () => {
    const a = subscriptionAccess(row({ status: "trialing", trialEndsAt: null }), NOW);
    expect(a.state).toBe("read_only");
    expect(a.reason).toBe("trial_expired");
  });

  it("past_due inside the grace window keeps full access", () => {
    // Period ended 3 days ago; grace is 7 — four days of runway left.
    const a = subscriptionAccess(row({ status: "past_due", currentPeriodEnd: iso(-3) }), NOW);
    expect(a.state).toBe("full");
    expect(a.reason).toBe("past_due_grace");
    expect(a.until).toBe(iso(-3 + PAST_DUE_GRACE_DAYS));
  });

  it("past_due beyond the grace window is read-only", () => {
    const a = subscriptionAccess(
      row({ status: "past_due", currentPeriodEnd: iso(-(PAST_DUE_GRACE_DAYS + 1)) }),
      NOW,
    );
    expect(a.state).toBe("read_only");
    expect(a.reason).toBe("past_due_lapsed");
  });

  it("past_due with no period end anchors grace on updated_at", () => {
    const inGrace = subscriptionAccess(
      row({ status: "past_due", currentPeriodEnd: null, updatedAt: iso(-2) }),
      NOW,
    );
    expect(inGrace.state).toBe("full");
    const lapsed = subscriptionAccess(
      row({ status: "past_due", currentPeriodEnd: null, updatedAt: iso(-8) }),
      NOW,
    );
    expect(lapsed.state).toBe("read_only");
  });

  it("past_due with NO anchor at all fails closed", () => {
    const a = subscriptionAccess(
      row({ status: "past_due", currentPeriodEnd: null, updatedAt: null }),
      NOW,
    );
    expect(a.state).toBe("read_only");
  });

  it("canceled is read-only", () => {
    const a = subscriptionAccess(row({ status: "canceled" }), NOW);
    expect(a).toEqual({ state: "read_only", reason: "canceled", until: null });
  });

  it("a status this code has never heard of gets NO write access", () => {
    const a = subscriptionAccess(row({ status: "comped_forever" }), NOW);
    expect(a.state).toBe("read_only");
    expect(a.reason).toBe("unknown_status");
  });

  it("garbage timestamps read as absent, never as valid clocks", () => {
    const a = subscriptionAccess(
      row({ status: "trialing", trialEndsAt: "not-a-date" }),
      NOW,
    );
    expect(a.state).toBe("read_only");
  });
});
