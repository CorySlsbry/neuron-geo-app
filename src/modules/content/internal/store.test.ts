import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The approve / reject transition.
 *
 * ⛔ WHAT IS ACTUALLY BEING PINNED HERE IS THE `WHERE` CLAUSE. The transition
 * could have been written as read-the-row, check-the-status, write-the-row —
 * and it would pass a happy-path test identically. It would also lose an
 * update every time two reviewers have the queue open: both read `draft`,
 * both decide they may proceed, and the second click quietly overwrites the
 * first person's decision. Making the database the arbiter
 * (`AND status IN ('draft','in_review')`) means exactly one UPDATE matches;
 * the loser gets zero rows and is TOLD. These assertions are what stop that
 * being refactored back into a race.
 *
 * The second thing pinned: approving writes `approved`, never `published`.
 * Nothing in this codebase publishes yet.
 */

const mocks = vi.hoisted(() => ({ withTenant: vi.fn() }));
vi.mock("@/lib/db/tenant", () => ({ withTenant: mocks.withTenant }));

import { ContentError, decide, seedSamples } from "./store";

const SCOPE = { uid: "uid-1", tenantId: "tenant-1" };

/**
 * A fake client that answers each query in the order the code issues them.
 * `queries` records everything so the assertions can read the real SQL.
 */
function fakeClient(answers: { rows: unknown[]; rowCount?: number }[]) {
  const queries: { sql: string; params: unknown[] }[] = [];
  let i = 0;
  const client = {
    query: vi.fn(async (sql: string, params: unknown[] = []) => {
      queries.push({ sql, params });
      return answers[i++] ?? { rows: [], rowCount: 0 };
    }),
  };
  return { client, queries };
}

function useClient(answers: { rows: unknown[]; rowCount?: number }[]) {
  const { client, queries } = fakeClient(answers);
  mocks.withTenant.mockImplementation(
    async (_scope: unknown, fn: (c: unknown) => Promise<unknown>) => fn(client),
  );
  return queries;
}

const ROW = {
  id: "item-1",
  kind: "post",
  title: "Sample: a title",
  body: "body",
  media_uri: null,
  status: "approved",
  channel_id: null,
  channel_network: null,
  channel_handle: null,
  published_url: null,
  published_at: null,
  is_sample: true,
  reviewed_by: "uid-1",
  reviewed_at: "2026-08-14T00:00:00Z",
  created_at: "2026-08-14T00:00:00Z",
};

beforeEach(() => vi.clearAllMocks());

describe("decide", () => {
  it("approves an item that is still in the queue", async () => {
    const queries = useClient([
      { rows: [{ id: "item-1" }] }, // the UPDATE
      { rows: [] }, // the audit event
      { rows: [] }, // connected channels: none
      { rows: [ROW] }, // re-read
    ]);
    const { item, queued, queuedNote } = await decide(SCOPE, "item-1", "approve");
    expect(item.status).toBe("approved");
    expect(item.reviewedBy).toBe("uid-1");
    // Approving is approval to post, but with no channel connected the honest
    // answer is zero — and the screen is given a sentence that says so rather
    // than implying a post is on its way.
    expect(queued).toBe(0);
    expect(queuedNote).toMatch(/no channel is connected/i);

    const update = queries[0]!;
    expect(update.sql).toMatch(/UPDATE content_items/);
    // The guard, in the statement itself.
    expect(update.sql).toMatch(/status IN \('draft','in_review'\)/);
    expect(update.params).toContain("approved");
  });

  it("rejects into 'rejected', not into any published state", async () => {
    // Only three results: rejecting must not even LOOK for channels to post to.
    const queries = useClient([
      { rows: [{ id: "item-1" }] },
      { rows: [] },
      { rows: [{ ...ROW, status: "rejected" }] },
    ]);
    const { item, queued } = await decide(SCOPE, "item-1", "reject");
    expect(item.status).toBe("rejected");
    expect(queued).toBe(0);
    // Assert on the thing that matters, not a proxy for it. An earlier version
    // of this checked that no query mentioned `tenant_channels` and failed —
    // because the re-read LEFT JOINs that table to name the item's channel.
    // The claim is "rejecting queues nothing", so test exactly that.
    expect(queries.some((q) => /enqueue_publish/.test(q.sql))).toBe(false);
    expect(queries.some((q) => /ch\.status = 'connected'/.test(q.sql))).toBe(false);
  });

  it("NEVER writes 'published' — only a real send may do that", async () => {
    // Approving now queues a publish. It still must not touch the published
    // state: that belongs to app.complete_publish(), after a real send
    // reported a real destination URL, and a database trigger refuses it from
    // anywhere else (migration 0005).
    const queries = useClient([
      { rows: [{ id: "item-1" }] },
      { rows: [] },
      { rows: [{ id: "ch-1" }] }, // one connected channel
      { rows: [{ enqueue_publish: "job-1" }] },
      { rows: [ROW] },
    ]);
    const { queued } = await decide(SCOPE, "item-1", "approve");
    expect(queued).toBe(1);
    for (const q of queries) {
      expect(JSON.stringify(q.params)).not.toContain("published");
    }
  });

  it("queues one publish per connected channel, in the SAME transaction", async () => {
    // Same transaction is the point: an approved item with nothing queued
    // means the post silently never happens, and a job queued against an
    // approval that rolled back means a post nobody authorised.
    const queries = useClient([
      { rows: [{ id: "item-1" }] },
      { rows: [] },
      { rows: [{ id: "ch-1" }, { id: "ch-2" }, { id: "ch-3" }] },
      { rows: [{ enqueue_publish: "job-1" }] },
      { rows: [{ enqueue_publish: "job-2" }] },
      { rows: [{ enqueue_publish: "job-3" }] },
      { rows: [ROW] },
    ]);
    const { queued } = await decide(SCOPE, "item-1", "approve");
    expect(queued).toBe(3);
    expect(queries.filter((q) => /enqueue_publish/.test(q.sql))).toHaveLength(3);
  });

  it("409s when someone already decided the item", async () => {
    useClient([
      { rows: [] }, // the UPDATE matched nothing
      { rows: [{ status: "approved" }] }, // ...but the row exists
    ]);
    const err = await decide(SCOPE, "item-1", "approve").catch((e) => e as ContentError);
    expect(err).toBeInstanceOf(ContentError);
    expect((err as ContentError).status).toBe(409);
    expect((err as ContentError).code).toBe("already_reviewed");
  });

  it("404s when the item is not ours or does not exist", async () => {
    // RLS makes another tenant's row invisible, so "not yours" arrives here
    // as "no such row" — which is the answer we want to give.
    useClient([{ rows: [] }, { rows: [] }]);
    const err = await decide(SCOPE, "item-1", "approve").catch((e) => e as ContentError);
    expect((err as ContentError).status).toBe(404);
    expect((err as ContentError).code).toBe("item_not_found");
  });

  it("records an audit event naming the decision", async () => {
    const queries = useClient([
      { rows: [{ id: "item-1" }] },
      { rows: [] },
      { rows: [{ ...ROW, status: "rejected" }] },
    ]);
    await decide(SCOPE, "item-1", "reject");
    const audit = queries[1]!;
    expect(audit.sql).toMatch(/INSERT INTO events/);
    expect(audit.params).toContain("content_rejected");
    expect(audit.params).toContain("uid-1");
  });
});

describe("seedSamples", () => {
  it("inserts nothing when samples are already present", async () => {
    const queries = useClient([{ rows: [{ n: "3" }] }]);
    expect(await seedSamples(SCOPE)).toBe(0);
    expect(queries).toHaveLength(1); // the count, and then it stopped
  });

  it("labels every seeded row as a sample, in the column AND in the title", async () => {
    const queries = useClient([
      { rows: [{ n: "0" }] },
      { rows: [], rowCount: 1 },
      { rows: [], rowCount: 1 },
      { rows: [], rowCount: 1 },
      { rows: [] },
    ]);
    expect(await seedSamples(SCOPE)).toBe(3);

    const inserts = queries.filter((q) => /INSERT INTO content_items/.test(q.sql));
    expect(inserts).toHaveLength(3);
    for (const q of inserts) {
      // is_sample is written as a literal `true` in the statement...
      expect(q.sql).toMatch(/is_sample/);
      expect(q.sql).toMatch(/true/);
      // ...and the title says it too, for anyone reading a 480p screen
      // recording with no legend to consult.
      expect(String(q.params[2])).toMatch(/^Sample: /);
    }
  });

  it("puts samples in the queue, not into an approved or published state", async () => {
    const queries = useClient([
      { rows: [{ n: "0" }] },
      { rows: [], rowCount: 1 },
      { rows: [], rowCount: 1 },
      { rows: [], rowCount: 1 },
      { rows: [] },
    ]);
    await seedSamples(SCOPE);
    for (const q of queries.filter((x) => /INSERT INTO content_items/.test(x.sql))) {
      expect(q.sql).toMatch(/'in_review'/);
      expect(q.sql).not.toMatch(/'published'/);
    }
  });
});
