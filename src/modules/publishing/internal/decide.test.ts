import { describe, expect, it } from "vitest";
import { decidePublish, type DecisionInput } from "./decide";
import { NETWORKS } from "@/modules/channels";

/**
 * The decision to contact a live platform is the highest-consequence branch in
 * this codebase, so it is tested as a function from data to a verdict rather
 * than inferred from control flow.
 *
 * The question every test here answers is the same one a platform reviewer
 * will ask: can this thing post to my account when it should not?
 */

/** Everything present and correct: the only input that may ever yield "live". */
function ready(over: Partial<DecisionInput> = {}): DecisionInput {
  return {
    job: { mode: "live" },
    item: {
      status: "approved",
      title: "How to choose a bookkeeper",
      body: "A short body.",
      mediaUri: "https://example.com/a.mp4",
    },
    channel: { status: "connected", network: "youtube", accountId: "UC_test" },
    accessToken: "ya29.test-token",
    liveEnabled: true,
    ...over,
  };
}

describe("a dry run is a rehearsal and cannot become a send", () => {
  it("stops at dry_run even when every live precondition is satisfied", () => {
    // The dangerous case: a fully armed environment, and only the job's own
    // mode column saying no. If the mode were checked last, or checked with a
    // truthy test, this is where it would leak.
    const d = decidePublish(ready({ job: { mode: "dry_run" } }));
    expect(d.action).toBe("dry_run");
  });

  it("still rehearses when live publishing is off and no token exists", () => {
    const d = decidePublish(
      ready({ job: { mode: "dry_run" }, liveEnabled: false, accessToken: null }),
    );
    expect(d.action).toBe("dry_run");
  });

  it("describes what it would have done, without leaking the token", () => {
    const d = decidePublish(ready({ job: { mode: "dry_run" } }));
    if (d.action !== "dry_run") throw new Error("expected a rehearsal");
    expect(d.note).toContain("nothing sent");
    expect(d.note).toContain("UC_test");
    // The note lands in a database column and a build log. A credential must
    // never be able to arrive there by accident.
    expect(d.note).not.toContain("ya29.test-token");
  });

  it("rehearses every network without throwing", () => {
    for (const network of NETWORKS) {
      const d = decidePublish(
        ready({
          job: { mode: "dry_run" },
          channel: { status: "connected", network, accountId: `acct_${network}` },
        }),
      );
      expect(d.action, `${network} should rehearse`).toBe("dry_run");
    }
  });
});

describe("the live branch has three gates and each one closes on its own", () => {
  it("refuses when PUBLISH_LIVE_ENABLED is off", () => {
    const d = decidePublish(ready({ liveEnabled: false }));
    expect(d.action).toBe("abandon");
    if (d.action !== "abandon") return;
    expect(d.reason).toContain("PUBLISH_LIVE_ENABLED");
  });

  it("refuses when there is no usable credential", () => {
    const d = decidePublish(ready({ accessToken: null }));
    expect(d.action).toBe("abandon");
    if (d.action !== "abandon") return;
    expect(d.reason).toContain("no usable credential");
  });

  it("goes live only when all three hold, and carries the token through", () => {
    const d = decidePublish(ready());
    expect(d.action).toBe("live");
    if (d.action !== "live") return;
    expect(d.request.accessToken).toBe("ya29.test-token");
    expect(d.request.accountId).toBe("UC_test");
  });
});

describe("the item is re-read, because approval can be withdrawn", () => {
  // Enqueue checked the status too. That check is stale the moment it returns:
  // a customer can hit Reject in the seconds before a worker picks the job up,
  // and the whole point of an approval queue is that Reject means it.
  it.each(["draft", "in_review", "rejected", "published", "failed"])(
    "refuses to publish an item whose status is %s",
    (status) => {
      const d = decidePublish(ready({ item: { ...ready().item!, status } }));
      expect(d.action).toBe("abandon");
      if (d.action !== "abandon") return;
      expect(d.reason).toContain("no longer approved");
    },
  );

  it("refuses when the item has vanished from the tenant", () => {
    const d = decidePublish(ready({ item: null }));
    expect(d.action).toBe("abandon");
  });
});

describe("the channel must still be there and still be connected", () => {
  it("refuses a disconnected channel", () => {
    const d = decidePublish(
      ready({ channel: { status: "disconnected", network: "youtube", accountId: "UC_test" } }),
    );
    expect(d.action).toBe("abandon");
    if (d.action !== "abandon") return;
    expect(d.reason).toContain("disconnected");
  });

  it("refuses a channel in the error state", () => {
    const d = decidePublish(
      ready({ channel: { status: "error", network: "youtube", accountId: "UC_test" } }),
    );
    expect(d.action).toBe("abandon");
  });

  it("refuses when the channel has vanished", () => {
    const d = decidePublish(ready({ channel: null }));
    expect(d.action).toBe("abandon");
  });
});

describe("today's real-world answer", () => {
  it("is a refusal for every network, because no credential exists yet", () => {
    // This is the state of the deployed system: OAuth clients are not
    // provisioned, so nothing has ever stored a token. If this test ever
    // starts failing, a credential became reachable — which is a thing to
    // notice deliberately, not to discover from a customer's timeline.
    for (const network of NETWORKS) {
      const d = decidePublish(
        ready({
          channel: { status: "connected", network, accountId: `acct_${network}` },
          accessToken: null,
        }),
      );
      expect(d.action, `${network} must not be publishable without a token`).toBe(
        "abandon",
      );
    }
  });
});
