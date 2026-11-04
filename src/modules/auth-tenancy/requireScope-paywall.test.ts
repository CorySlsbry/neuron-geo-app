import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The paywall at the ROUTE LAYER: requireScope({ write: true }) refuses an
 * expired-trial tenant's writes with 402 subscription_required, and reads
 * stay untouched. The gate's decision table lives in subscription-gate.test;
 * this file pins the WIRING — that the decision actually stops a request.
 *
 * There is deliberately no DB-layer enforcement to test: RLS scopes WHO can
 * touch WHICH rows, and the paywall is about WHETHER the tenant may write at
 * all — a route-layer concern, enforced in the one place every data route
 * already goes through.
 */

const mocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  currentEpoch: vi.fn(),
  resolveScope: vi.fn(),
  resolveSubscriptionAccess: vi.fn(),
}));

vi.mock("./internal/session", () => ({ getSession: mocks.getSession }));
vi.mock("./internal/directory", () => ({
  currentEpoch: mocks.currentEpoch,
  bumpEpoch: vi.fn(),
  listMemberships: vi.fn(async () => []),
  provisionTenant: vi.fn(),
  resolveScope: mocks.resolveScope,
}));
vi.mock("./internal/paywall", () => ({
  resolveSubscriptionAccess: mocks.resolveSubscriptionAccess,
}));

import { AuthError, requireScope } from "./index";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getSession.mockResolvedValue({
    uid: "uid-1",
    epoch: 3,
    activeTenantId: "tenant-1",
    aal: "aal2",
  });
  mocks.currentEpoch.mockResolvedValue(3);
  mocks.resolveScope.mockResolvedValue({
    uid: "uid-1",
    tenantId: "tenant-1",
    role: "owner",
    departments: [],
  });
});

describe("requireScope + the paywall", () => {
  it("denies a WRITE for an expired-trial tenant with 402 subscription_required", async () => {
    mocks.resolveSubscriptionAccess.mockResolvedValue({
      state: "read_only",
      reason: "trial_expired",
      until: "2026-08-01T00:00:00Z",
    });
    const err = await requireScope({ write: true }).catch((e) => e as AuthError);
    expect(err).toBeInstanceOf(AuthError);
    expect((err as AuthError).status).toBe(402);
    expect((err as AuthError).code).toBe("subscription_required");
  });

  it("allows a WRITE while the subscription is in good standing", async () => {
    mocks.resolveSubscriptionAccess.mockResolvedValue({
      state: "full",
      reason: "trialing",
      until: "2026-09-01T00:00:00Z",
    });
    const scope = await requireScope({ write: true });
    expect(scope.tenantId).toBe("tenant-1");
    expect(mocks.resolveSubscriptionAccess).toHaveBeenCalledWith("uid-1", "tenant-1");
  });

  it("never consults the paywall for READS — reads only degrade, they don't block", async () => {
    const scope = await requireScope();
    expect(scope.role).toBe("owner");
    expect(mocks.resolveSubscriptionAccess).not.toHaveBeenCalled();
  });

  it("reports the paywall as the FIRST reason a write is refused", async () => {
    // A viewer on an expired tenant: the honest refusal is the subscription,
    // not the role — fixing the role would still not make the write work.
    mocks.resolveScope.mockResolvedValue({
      uid: "uid-1",
      tenantId: "tenant-1",
      role: "viewer",
      departments: [],
    });
    mocks.resolveSubscriptionAccess.mockResolvedValue({
      state: "read_only",
      reason: "trial_expired",
      until: null,
    });
    const err = await requireScope({ write: true, roles: ["owner", "admin"] }).catch(
      (e) => e as AuthError,
    );
    expect((err as AuthError).code).toBe("subscription_required");
  });

  it("past_due within grace still writes; past_due lapsed does not", async () => {
    mocks.resolveSubscriptionAccess.mockResolvedValueOnce({
      state: "full",
      reason: "past_due_grace",
      until: "2026-08-20T00:00:00Z",
    });
    await expect(requireScope({ write: true })).resolves.toMatchObject({
      tenantId: "tenant-1",
    });
    mocks.resolveSubscriptionAccess.mockResolvedValueOnce({
      state: "read_only",
      reason: "past_due_lapsed",
      until: null,
    });
    await expect(requireScope({ write: true })).rejects.toMatchObject({
      status: 402,
      code: "subscription_required",
    });
  });
});
