/**
 * What happened when an item was approved, in one sentence, from real counts.
 *
 * ⛔ EXTRACTED FROM THE PAGE SO IT CAN BE TESTED. This sentence is the only
 * place the product tells a customer whether their content went out, and the
 * expensive mistake is describing a REHEARSAL as a post. Inside a "use client"
 * component that claim is untestable in this repo (vitest runs no DOM here);
 * as a pure function it has an exhaustive test that runs on every commit.
 *
 * The wording deliberately distinguishes three different truths that a naive
 * version would blur into "published":
 *   - a dry run finished  → "test run finished ... nothing sent"
 *   - a live job finished → "posted to N of M"
 *   - nothing was queued  → says so, rather than staying silent
 */
export interface PublishLineItem {
  status: string;
  publish?: {
    total: number;
    done: number;
    pending: number;
    failed: number;
    /** True when ANY job for this item was a real publish, not a rehearsal. */
    anyLive: boolean;
    latestNote: string | null;
  };
}

export function publishLine(item: PublishLineItem): string | null {
  const p = item.publish;

  if (!p || p.total === 0) {
    // An approved item with no jobs is not a silent success. The customer
    // authorised a post and none was queued, and the reason is always the
    // same one: they have not connected anything yet.
    return item.status === "approved"
      ? "No channel was connected, so nothing was queued to post."
      : null;
  }

  const bits: string[] = [];
  if (p.done > 0) {
    bits.push(
      p.anyLive
        ? `posted to ${p.done} of ${p.total}`
        : `test run finished on ${p.done} of ${p.total}, nothing sent`,
    );
  }
  if (p.pending > 0) bits.push(`${p.pending} still queued`);
  if (p.failed > 0) bits.push(`${p.failed} stopped, see the log`);

  return bits.length > 0 ? `${bits.join(" · ")}.` : null;
}
