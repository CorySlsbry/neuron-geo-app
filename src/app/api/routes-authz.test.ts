import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The authorization POSTURE of every route added for the demo path, asserted
 * by calling the real handlers.
 *
 * viewer-readonly.test.ts already proves each mutating route states SOME role
 * requirement. That is the floor. This file pins the specific decisions,
 * because three of them are judgement calls that a future reader would
 * reasonably "fix" in the wrong direction:
 *
 *   1. Connecting a channel IS paywalled (it is the act that grants this
 *      product the power to post as the customer's brand) but is NOT aal2 —
 *      a TOTP prompt in the middle of the platform-review recording buys no
 *      security and costs the video.
 *   2. DISCONNECTING IS NOT PAYWALLED. It is how a customer withdraws a
 *      permission they granted, and holding a revocation hostage to a lapsed
 *      card is the behaviour every platform policy on this list forbids.
 *   3. Reads are open to any member, including a viewer whose workspace has
 *      gone read-only — you can always see, and leave.
 */

const mocks = vi.hoisted(() => ({
  requireScope: vi.fn(),
  buildAuthorizeUrl: vi.fn(),
  disconnectChannel: vi.fn(),
  listChannelCards: vi.fn(),
  takePending: vi.fn(),
  exchangeCode: vi.fn(),
  resolveIdentity: vi.fn(),
  saveConnection: vi.fn(),
  clearPending: vi.fn(),
  decide: vi.fn(),
  seedSamples: vi.fn(),
  listQueue: vi.fn(),
  listDecided: vi.fn(),
  counts: vi.fn(),
  connectedChannelCount: vi.fn(),
  getBrand: vi.fn(),
  saveBrand: vi.fn(),
}));

vi.mock("@/modules/auth-tenancy", () => ({
  requireScope: mocks.requireScope,
  getBrand: mocks.getBrand,
  saveBrand: mocks.saveBrand,
  WRITE_ROLES: ["owner", "admin", "staff"] as const,
}));

vi.mock("@/modules/channels", () => ({
  buildAuthorizeUrl: mocks.buildAuthorizeUrl,
  disconnectChannel: mocks.disconnectChannel,
  listChannelCards: mocks.listChannelCards,
  connectedChannelCount: mocks.connectedChannelCount,
  takePending: mocks.takePending,
  exchangeCode: mocks.exchangeCode,
  resolveIdentity: mocks.resolveIdentity,
  saveConnection: mocks.saveConnection,
  clearPending: mocks.clearPending,
  isNetwork: (v: string) =>
    ["youtube", "instagram", "facebook", "tiktok", "linkedin"].includes(v),
}));

vi.mock("@/modules/content", () => ({
  decide: mocks.decide,
  seedSamples: mocks.seedSamples,
  listQueue: mocks.listQueue,
  listDecided: mocks.listDecided,
  counts: mocks.counts,
}));

import { POST as connect } from "./channels/connect/route";
import { GET as channels } from "./channels/route";
import { POST as disconnect } from "./channels/[id]/disconnect/route";
import { GET as callback } from "./channels/callback/[network]/route";
import { POST as decideRoute } from "./content/[id]/decide/route";
import { POST as samples } from "./content/samples/route";
import { GET as content } from "./content/route";
import { GET as overview } from "./overview/route";
import { POST as brandPost } from "./brand/route";

const SCOPE = {
  uid: "uid-1",
  tenantId: "tenant-1",
  role: "owner" as const,
  departments: [],
  aal: "aal1" as const,
};

const UUID = "11111111-2222-4333-8444-555555555555";

/** A request object carrying only what the handler under test reads. */
function req(body?: unknown, url = "https://app.test/x"): never {
  return {
    json: async () => {
      if (body === undefined) throw new Error("no body");
      return body;
    },
    nextUrl: new URL(url),
  } as never;
}

const params = <T,>(value: T) => ({ params: Promise.resolve(value) });

/** The requirements object the handler passed to requireScope. */
function reqs(): Record<string, unknown> {
  return (mocks.requireScope.mock.calls[0]?.[0] ?? {}) as Record<string, unknown>;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireScope.mockResolvedValue(SCOPE);
  mocks.listChannelCards.mockResolvedValue([]);
  mocks.listQueue.mockResolvedValue([]);
  mocks.listDecided.mockResolvedValue([]);
  mocks.counts.mockResolvedValue({
    awaitingReview: 0,
    approved: 0,
    published: 0,
    sample: 0,
    total: 0,
  });
  mocks.connectedChannelCount.mockResolvedValue(0);
  mocks.getBrand.mockResolvedValue({ name: "Brand", domain: null, onboardedAt: null });
});

describe("channel connect", () => {
  it("requires a write role and a subscription, and does NOT demand aal2", async () => {
    mocks.buildAuthorizeUrl.mockResolvedValue("https://accounts.google.com/x");
    const res = await connect(req({ network: "youtube" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ authorizeUrl: "https://accounts.google.com/x" });

    const r = reqs();
    expect(r.roles).toEqual(["owner", "admin", "staff"]);
    expect(r.write).toBe(true);
    expect(r.aal2).toBeUndefined();
  });

  it("hands back a URL rather than redirecting, so refusals can be rendered", async () => {
    mocks.buildAuthorizeUrl.mockResolvedValue("https://accounts.google.com/x");
    const res = await connect(req({ network: "youtube" }));
    // A 3xx here would put a JSON error envelope in the address bar on every
    // 402/403/503 — mid-demo.
    expect(res.status).toBeLessThan(300);
  });

  it("rejects an unknown network before any scope work", async () => {
    const res = await connect(req({ network: "myspace" }));
    expect(res.status).toBe(400);
    expect(mocks.requireScope).not.toHaveBeenCalled();
  });

  it("passes the SERVER-resolved tenant to the authorize builder", async () => {
    mocks.buildAuthorizeUrl.mockResolvedValue("https://x");
    await connect(req({ network: "youtube" }));
    expect(mocks.buildAuthorizeUrl).toHaveBeenCalledWith("youtube", "tenant-1");
  });
});

describe("channel disconnect", () => {
  it("is NOT paywalled — revoking access can never depend on a paid card", async () => {
    mocks.disconnectChannel.mockResolvedValue({ revokedAtProvider: true });
    const res = await disconnect(req(), params({ id: UUID }));
    expect(res.status).toBe(200);

    const r = reqs();
    expect(r.roles).toEqual(["owner", "admin", "staff"]);
    expect(r.write).toBeUndefined();
  });

  it("refuses a malformed id without touching the store", async () => {
    const res = await disconnect(req(), params({ id: "not-a-uuid" }));
    expect(res.status).toBe(400);
    expect(mocks.disconnectChannel).not.toHaveBeenCalled();
  });
});

describe("the OAuth callback", () => {
  it("resolves the tenant from the session and never from the callback", async () => {
    mocks.takePending.mockResolvedValue({ n: "youtube", s: "st", t: "tenant-1" });
    mocks.exchangeCode.mockResolvedValue({
      accessToken: "at",
      refreshToken: null,
      expiresAt: null,
      scopes: [],
    });
    mocks.resolveIdentity.mockResolvedValue({ accountId: "UC1", handle: "@x" });
    mocks.saveConnection.mockResolvedValue({});

    const res = await callback(
      req(undefined, "https://app.test/api/channels/callback/youtube?code=c&state=st"),
      params({ network: "youtube" }),
    );

    // The state is checked against the tenant requireScope resolved, not
    // against anything the provider or the query string asserted.
    expect(mocks.takePending).toHaveBeenCalledWith("youtube", "st", "tenant-1");
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toContain("/channels?connected=youtube");
  });

  it("redirects — never returns JSON — when the customer declines consent", async () => {
    const res = await callback(
      req(
        undefined,
        "https://app.test/api/channels/callback/youtube?error=access_denied",
      ),
      params({ network: "youtube" }),
    );
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toContain("error=consent_declined");
    expect(mocks.requireScope).not.toHaveBeenCalled();
  });

  it("redirects with a plain code when the state does not match", async () => {
    const { ChannelError } = await import("@/lib/http/errors").then((m) => ({
      ChannelError: class extends m.HttpError {},
    }));
    mocks.takePending.mockRejectedValue(new ChannelError(403, "state_mismatch"));
    const res = await callback(
      req(undefined, "https://app.test/api/channels/callback/youtube?code=c&state=bad"),
      params({ network: "youtube" }),
    );
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toContain("error=state_mismatch");
    expect(mocks.saveConnection).not.toHaveBeenCalled();
  });

  it("swallows an unexpected failure into a generic code, leaking nothing", async () => {
    mocks.takePending.mockResolvedValue({ n: "youtube", s: "st", t: "tenant-1" });
    mocks.exchangeCode.mockRejectedValue(
      new Error("client_secret=hunter2 rejected by https://oauth2.googleapis.com"),
    );
    const res = await callback(
      req(undefined, "https://app.test/api/channels/callback/youtube?code=c&state=st"),
      params({ network: "youtube" }),
    );
    const location = res.headers.get("location") ?? "";
    expect(location).toContain("error=connect_failed");
    expect(location).not.toContain("hunter2");
  });

  it("clears the in-flight state on every path, success or not", async () => {
    await callback(
      req(undefined, "https://app.test/api/channels/callback/youtube"),
      params({ network: "youtube" }),
    );
    expect(mocks.clearPending).toHaveBeenCalled();
  });
});

describe("review decisions", () => {
  it("requires a write role and a subscription, without aal2", async () => {
    mocks.decide.mockResolvedValue({ id: UUID, status: "approved" });
    const res = await decideRoute(req({ decision: "approve" }), params({ id: UUID }));
    expect(res.status).toBe(200);

    const r = reqs();
    expect(r.roles).toEqual(["owner", "admin", "staff"]);
    expect(r.write).toBe(true);
    expect(r.aal2).toBeUndefined();
  });

  it("accepts only approve and reject", async () => {
    const res = await decideRoute(req({ decision: "publish" }), params({ id: UUID }));
    expect(res.status).toBe(400);
    expect(mocks.decide).not.toHaveBeenCalled();
  });

  it("seeding samples is a gated write, not something signup does", async () => {
    mocks.seedSamples.mockResolvedValue(3);
    const res = await samples();
    expect(res.status).toBe(201);
    const r = reqs();
    expect(r.roles).toEqual(["owner", "admin", "staff"]);
    expect(r.write).toBe(true);
  });
});

describe("reads", () => {
  it("channels, content and overview ask only for membership", async () => {
    for (const handler of [channels, content, overview]) {
      vi.clearAllMocks();
      mocks.requireScope.mockResolvedValue(SCOPE);
      mocks.listChannelCards.mockResolvedValue([]);
      mocks.listQueue.mockResolvedValue([]);
      mocks.listDecided.mockResolvedValue([]);
      mocks.counts.mockResolvedValue({
        awaitingReview: 0,
        approved: 0,
        published: 0,
        sample: 0,
        total: 0,
      });
      mocks.connectedChannelCount.mockResolvedValue(0);
      mocks.getBrand.mockResolvedValue({ name: "B", domain: null, onboardedAt: null });

      const res = await handler();
      expect(res.status).toBe(200);
      // No requirements at all: a read-only workspace can still be looked at.
      expect(mocks.requireScope).toHaveBeenCalledWith();
    }
  });

  it("overview reports only counted rows, with no invented fields", async () => {
    mocks.counts.mockResolvedValue({
      awaitingReview: 2,
      approved: 1,
      published: 0,
      sample: 3,
      total: 3,
    });
    mocks.connectedChannelCount.mockResolvedValue(1);
    const body = (await (await overview()).json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      channelsConnected: 1,
      awaitingReview: 2,
      approved: 1,
      published: 0,
      sampleContent: 3,
    });
    // Nothing resembling an estimate, projection or forecast.
    for (const key of Object.keys(body)) {
      expect(key).not.toMatch(/estimate|projected|forecast|reach|impressions/i);
    }
  });
});

describe("brand / onboarding", () => {
  it("is a paywalled write with no aal2 gate on the first screen", async () => {
    mocks.saveBrand.mockResolvedValue({
      name: "Neuron",
      domain: "neuron-hq.com",
      onboardedAt: "2026-08-14T00:00:00Z",
    });
    const res = await brandPost(req({ name: "Neuron", domain: "neuron-hq.com" }));
    expect(res.status).toBe(200);
    const r = reqs();
    expect(r.roles).toEqual(["owner", "admin", "staff"]);
    expect(r.write).toBe(true);
    expect(r.aal2).toBeUndefined();
  });

  it("refuses an empty brand name before it reaches the store", async () => {
    const res = await brandPost(req({ name: "   ", domain: "neuron-hq.com" }));
    expect(res.status).toBe(400);
    expect(mocks.saveBrand).not.toHaveBeenCalled();
  });
});
