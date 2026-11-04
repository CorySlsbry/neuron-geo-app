import type { Network } from "@/modules/channels";
import { prepare, type SendRequest } from "./senders";

/**
 * Every gate between "a job was claimed" and "a real post is created", as ONE
 * pure function.
 *
 * ⛔ WHY IT IS PURE, AND WHY THAT IS THE SECURITY ARGUMENT.
 * The decision to contact a live platform is the single highest-consequence
 * branch in this codebase. Buried inside the worker loop it would be testable
 * only against a database, a network and a clock — which in practice means
 * tested once, by hand, and never again. Here it is a function from plain data
 * to a verdict, so every refusal has a test that runs on every commit, and the
 * test "a dry run never produces a live action" is an assertion about a value
 * rather than a hope about control flow.
 *
 * The worker performs this verdict and makes no judgements of its own.
 */

export interface DecisionInput {
  job: { mode: "dry_run" | "live" };
  /** The content item, RE-READ after the claim. Deliberately re-read: the
   *  enqueue-time status check is stale by the time a worker gets here, and a
   *  customer who hits Reject after approving must not be published anyway. */
  item: {
    status: string;
    title: string;
    body: string;
    mediaUri: string | null;
  } | null;
  channel: {
    status: string;
    network: Network;
    accountId: string;
  } | null;
  /** The decrypted access token, or null when there is no credential row or it
   *  would not open with the current key. The distinction between those two
   *  does not matter here: neither can publish. */
  accessToken: string | null;
  /** `PUBLISH_LIVE_ENABLED === "true"`. Read once, by the caller, so this stays
   *  pure — and so the test suite can prove the switch is load-bearing. */
  liveEnabled: boolean;
}

export type Decision =
  /** Terminal. Nothing about a retry could change the answer. */
  | { action: "abandon"; reason: string }
  /** The rehearsal: everything built, nothing sent. */
  | { action: "dry_run"; note: string }
  /** The only branch that reaches the network. */
  | { action: "live"; request: SendRequest; note: string };

export function decidePublish(input: DecisionInput): Decision {
  const { job, item, channel, accessToken, liveEnabled } = input;

  // ---- conditions that cannot resolve on a retry, cheapest first ----------
  if (!item) {
    return {
      action: "abandon",
      reason: "the content item no longer exists in this tenant",
    };
  }

  // The re-read. `approved` is the only status that may be published, and it
  // is checked HERE rather than trusted from enqueue time.
  if (item.status !== "approved") {
    return {
      action: "abandon",
      reason:
        `the item is no longer approved (status is "${item.status}") — ` +
        "publishing a rejected or already-published item is never correct",
    };
  }

  if (!channel) {
    return { action: "abandon", reason: "the channel no longer exists in this tenant" };
  }

  if (channel.status !== "connected") {
    return {
      action: "abandon",
      reason: `the ${channel.network} channel is ${channel.status}, not connected`,
    };
  }

  const request: SendRequest = {
    network: channel.network,
    accountId: channel.accountId,
    // Placeholder for the rehearsal. Replaced below on the live branch, and
    // only there — a dry run must not need a real token to be worth running,
    // and must not hold one it does not need.
    accessToken: "",
    title: item.title,
    body: item.body,
    mediaUri: item.mediaUri,
  };

  // ---- the rehearsal ------------------------------------------------------
  // Note what it still does: `prepare()` builds the full request, so a wrong
  // field name or an over-long caption fails here, for free, before any
  // credential exists. And note what it does NOT do: it never looks at
  // liveEnabled or the token, so a dry run cannot be turned into a send by
  // flipping a switch somewhere else.
  if (job.mode === "dry_run") {
    const plan = prepare(request);
    return {
      action: "dry_run",
      note:
        `dry run, nothing sent: ${plan.summary}. ` +
        `(${plan.method} ${plan.url})`,
    };
  }

  // ---- the live branch: three independent gates, all fail-closed ---------
  if (!liveEnabled) {
    return {
      action: "abandon",
      reason:
        "live publishing is switched off (PUBLISH_LIVE_ENABLED is not \"true\"). " +
        "This is a code guard, not a comment: the job stops here.",
    };
  }

  if (!accessToken) {
    return {
      action: "abandon",
      reason:
        "no usable credential for this channel — either none is stored, or it " +
        "will not open with the current CHANNEL_TOKEN_KEY. Reconnect the channel.",
    };
  }

  const plan = prepare(request);
  return {
    action: "live",
    request: { ...request, accessToken },
    note: `live publish: ${plan.summary}`,
  };
}
