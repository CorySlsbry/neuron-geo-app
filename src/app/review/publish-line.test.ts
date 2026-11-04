import { describe, expect, it } from "vitest";
import { publishLine, type PublishLineItem } from "./publish-line";

/**
 * The sentence a customer reads after approving something.
 *
 * ⛔ THE ONE THING IT MUST NEVER DO is claim a post that did not happen. Every
 * job in this system is a rehearsal today (no OAuth client exists, so no
 * credential is stored, so `PUBLISH_LIVE_ENABLED` has nothing to enable), and
 * a screen that says "posted" over a dry run is exactly the lie the dry-run
 * mode was built to prevent — on the recording a platform reviewer watches.
 */

function item(over: Partial<PublishLineItem> = {}): PublishLineItem {
  return {
    status: "approved",
    publish: { total: 2, done: 2, pending: 0, failed: 0, anyLive: false, latestNote: null },
    ...over,
  };
}

describe("a rehearsal is never described as a post", () => {
  it("says test run, and says nothing was sent", () => {
    const line = publishLine(item())!;
    expect(line).toMatch(/test run/i);
    expect(line).toMatch(/nothing sent/i);
    expect(line).not.toMatch(/\bposted\b/i);
  });

  it("only says posted when a job was genuinely live", () => {
    const line = publishLine(
      item({ publish: { total: 2, done: 2, pending: 0, failed: 0, anyLive: true, latestNote: null } }),
    )!;
    expect(line).toMatch(/posted to 2 of 2/);
  });

  it("never claims a post for ANY combination of counts while anyLive is false", () => {
    // Exhaustive over the small space rather than a couple of examples: this is
    // the assertion that has to survive someone editing the wording later.
    for (const total of [1, 2, 3]) {
      for (let done = 0; done <= total; done++) {
        for (let failed = 0; failed <= total - done; failed++) {
          const pending = total - done - failed;
          const line = publishLine(
            item({ publish: { total, done, pending, failed, anyLive: false, latestNote: null } }),
          );
          if (line) expect(line, `${total}/${done}/${pending}/${failed}`).not.toMatch(/\bposted\b/i);
        }
      }
    }
  });
});

describe("zero is a real answer and gets said out loud", () => {
  it("explains an approval that queued nothing", () => {
    const line = publishLine(
      item({ publish: { total: 0, done: 0, pending: 0, failed: 0, anyLive: false, latestNote: null } }),
    );
    expect(line).toMatch(/no channel was connected/i);
  });

  it("stays silent for a rejected item, which was never going anywhere", () => {
    expect(
      publishLine(
        item({
          status: "rejected",
          publish: { total: 0, done: 0, pending: 0, failed: 0, anyLive: false, latestNote: null },
        }),
      ),
    ).toBeNull();
  });
});

describe("work still in flight is reported as in flight", () => {
  it("counts what is queued", () => {
    const line = publishLine(
      item({ publish: { total: 3, done: 1, pending: 2, failed: 0, anyLive: false, latestNote: null } }),
    )!;
    expect(line).toMatch(/2 still queued/);
  });

  it("names failures instead of rounding them away", () => {
    const line = publishLine(
      item({ publish: { total: 3, done: 2, pending: 0, failed: 1, anyLive: false, latestNote: null } }),
    )!;
    expect(line).toMatch(/1 stopped/);
  });
});
