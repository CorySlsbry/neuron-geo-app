import { describe, expect, it } from "vitest";
import { assessFleet, type FleetSnapshot } from "./health";

/**
 * A health check is trusted precisely when it is quiet, which makes "can it
 * ever say no" the only question worth asking of it. Every unhealthy shape
 * below has an assertion; the "ok" case has exactly one.
 */

function snap(over: Partial<FleetSnapshot> = {}): FleetSnapshot {
  return {
    workers: [{ workerId: "w1", hostname: "laptop", lastSeenSecondsAgo: 10, currentJob: null }],
    queue: { queued: 0, running: 0, succeeded: 5, failed: 0, dead: 0 },
    oldestQueuedSeconds: null,
    expiredLeases: 0,
    ...over,
  };
}

describe("silence is only an emergency when something is waiting", () => {
  it("is DOWN when no worker ever checked in and work is queued", () => {
    const h = assessFleet(snap({ workers: [], queue: { queued: 3, running: 0, succeeded: 0, failed: 0, dead: 0 } }));
    expect(h.level).toBe("down");
    expect(h.lines[0]).toMatch(/No worker has ever checked in/i);
    expect(h.lines[0]).toMatch(/Nothing will publish/i);
  });

  it("is only WARN when no worker exists but nothing is waiting", () => {
    // An idle deployment is a normal state, not an outage. Paging on it is how
    // a health check teaches people to ignore it.
    const h = assessFleet(snap({ workers: [] }));
    expect(h.level).toBe("warn");
    expect(h.lines[0]).toMatch(/nothing is stuck/i);
  });

  it("is DOWN when every worker has gone silent and work is queued", () => {
    const h = assessFleet(
      snap({
        workers: [{ workerId: "w1", hostname: "laptop", lastSeenSecondsAgo: 3_600, currentJob: null }],
        queue: { queued: 2, running: 0, succeeded: 0, failed: 0, dead: 0 },
      }),
    );
    expect(h.level).toBe("down");
    expect(h.lines[0]).toMatch(/silent/i);
    expect(h.lines[0]).toMatch(/60m ago/);
  });

  it("counts a worker inside the staleness window as alive", () => {
    const h = assessFleet(
      snap({
        workers: [{ workerId: "w1", hostname: "laptop", lastSeenSecondsAgo: 299, currentJob: null }],
        queue: { queued: 2, running: 0, succeeded: 0, failed: 0, dead: 0 },
      }),
    );
    expect(h.level).toBe("ok");
  });
});

describe("the states that need a person", () => {
  it("warns on an expired lease, because a worker died mid-job", () => {
    const h = assessFleet(snap({ expiredLeases: 2 }));
    expect(h.level).toBe("warn");
    expect(h.lines[0]).toMatch(/expired lease/i);
  });

  it("warns on a backlog even when workers are healthy", () => {
    // Alive AND not draining is a different fault from dead, and it is the one
    // a naive "is the worker up" check misses completely.
    const h = assessFleet(
      snap({ queue: { queued: 1, running: 0, succeeded: 0, failed: 0, dead: 0 }, oldestQueuedSeconds: 4_000 }),
    );
    expect(h.level).toBe("warn");
    expect(h.lines[0]).toMatch(/refusing to drain/i);
  });

  it("warns on dead letters, which exist to be looked at", () => {
    const h = assessFleet(snap({ queue: { queued: 0, running: 0, succeeded: 1, failed: 0, dead: 3 } }));
    expect(h.level).toBe("warn");
    expect(h.lines[0]).toMatch(/dead-lettered/i);
  });

  it("reports DOWN ahead of WARN when both are true", () => {
    const h = assessFleet(
      snap({
        workers: [],
        queue: { queued: 1, running: 0, succeeded: 0, failed: 0, dead: 4 },
        expiredLeases: 1,
      }),
    );
    expect(h.level).toBe("down");
    expect(h.lines[0]).toMatch(/No worker has ever checked in/i);
    expect(h.lines.length).toBeGreaterThan(1);
  });
});

describe("healthy is healthy", () => {
  it("says so once, without inventing a number it does not have", () => {
    const h = assessFleet(snap());
    expect(h.level).toBe("ok");
    expect(h.lines).toHaveLength(1);
    expect(h.lines[0]).toMatch(/1 worker\(s\) reporting/);
  });
});
