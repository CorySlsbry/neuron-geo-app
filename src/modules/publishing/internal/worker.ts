import "server-only";
import { withWorker, withWorkerTenant } from "@/lib/db/worker";
import { isNetwork, readAccessToken, type Network } from "@/modules/channels";
import { decidePublish, type Decision } from "./decide";
import { send, SendError, type Fetcher } from "./senders";

/**
 * One turn of the publishing worker.
 *
 * ⛔ THE TRANSACTION BOUNDARIES ARE LOAD-BEARING. There are three, not one:
 *
 *   1. claim — commits immediately, so the lease is visible to every other
 *      worker. Held open, a second worker would either block on the row or
 *      skip it depending on isolation luck, and "luck" is not a concurrency
 *      design.
 *   2. load  — reads the item, the channel and the credential under the
 *      job's own tenant scope, then commits.
 *   3. finish — records the outcome.
 *
 * The network call happens BETWEEN 2 and 3, holding no connection and no
 * lock. A provider that takes 40 seconds to answer must not be holding one of
 * four worker connections and an open transaction while it thinks.
 */

export interface ClaimedJob {
  id: string;
  tenantId: string;
  mode: "dry_run" | "live";
  contentItemId: string;
  channelId: string;
  attempts: number;
}

export interface RunResult {
  /** False when the queue had nothing eligible — the normal idle answer. */
  claimed: boolean;
  jobId?: string;
  outcome?: "published" | "rehearsed" | "abandoned" | "retrying";
  detail?: string;
}

export interface RunOptions {
  workerId: string;
  leaseSeconds?: number;
  /** Injected so tests can assert a dry run never reaches the network. */
  fetcher?: Fetcher;
  /** Defaults to reading the environment. Explicit in tests. */
  liveEnabled?: boolean;
}

function liveIsEnabled(): boolean {
  // Exact string match, not a truthiness check: "false", "0" and "no" must all
  // mean off, and so must a typo.
  return process.env.PUBLISH_LIVE_ENABLED === "true";
}

/** Announce this worker before claiming anything, so the operator console can
 *  tell "no work" apart from "no worker". */
export async function checkIn(workerId: string, hostname: string): Promise<void> {
  await withWorker(async (c) => {
    await c.query("SELECT app.worker_checkin($1, $2)", [workerId, hostname]);
  });
}

async function claim(
  workerId: string,
  leaseSeconds: number,
): Promise<ClaimedJob | null> {
  return withWorker(async (c) => {
    const { rows } = await c.query<{
      id: string | null;
      tenant_id: string;
      mode: string;
      content_item_id: string;
      channel_id: string;
      attempts: number;
    }>("SELECT * FROM app.claim_next_job($1, $2)", [workerId, leaseSeconds]);

    // A composite-returning function that returns NULL still yields one row,
    // with every column null. The id is the tell.
    const r = rows[0];
    if (!r?.id) return null;

    return {
      id: r.id,
      tenantId: r.tenant_id,
      mode: r.mode === "live" ? "live" : "dry_run",
      contentItemId: r.content_item_id,
      channelId: r.channel_id,
      attempts: r.attempts,
    };
  });
}

interface JobContext {
  item: { status: string; title: string; body: string; mediaUri: string | null } | null;
  channel: { status: string; network: Network; accountId: string } | null;
  accessToken: string | null;
}

/**
 * Read everything the decision needs, under the job's tenant scope.
 *
 * Every query here is unqualified by tenant on purpose — RLS is doing that,
 * from the GUC set out of the claimed row. If the scope were somehow missing,
 * these return nothing and the job is abandoned with "no longer exists", which
 * is the fail-closed direction.
 */
async function loadContext(job: ClaimedJob): Promise<JobContext> {
  return withWorkerTenant(job.tenantId, async (c) => {
    const item = await c.query<{
      status: string;
      title: string;
      body: string;
      media_uri: string | null;
    }>(
      `SELECT status, title, body, media_uri FROM content_items WHERE id = $1`,
      [job.contentItemId],
    );

    const channel = await c.query<{
      status: string;
      network: string;
      account_id: string;
    }>(`SELECT status, network, account_id FROM tenant_channels WHERE id = $1`, [
      job.channelId,
    ]);

    const credential = await c.query<{ enc_token: Buffer | null }>(
      `SELECT enc_token FROM tenant_credentials WHERE channel_id = $1`,
      [job.channelId],
    );

    const ch = channel.rows[0];
    const it = item.rows[0];
    const sealed = credential.rows[0]?.enc_token ?? null;

    // Deliberately the CHANNELS module's reader, not a local copy: the sealed
    // payload's field name is knowledge that must live in exactly one place.
    // A second reader written from memory used `accessToken` instead of
    // `access`, which type-checks, never throws, and silently refuses every
    // valid credential.
    const accessToken = sealed ? readAccessToken(sealed) : null;

    return {
      item: it
        ? { status: it.status, title: it.title, body: it.body, mediaUri: it.media_uri }
        : null,
      channel:
        ch && isNetwork(ch.network)
          ? { status: ch.status, network: ch.network, accountId: ch.account_id }
          : null,
      accessToken,
    };
  });
}

async function finishSucceeded(
  job: ClaimedJob,
  workerId: string,
  url: string | null,
  note: string,
): Promise<void> {
  await withWorker(async (c) => {
    await c.query("SELECT app.complete_publish($1, $2, $3, $4)", [
      job.id,
      workerId,
      url,
      note,
    ]);
  });
}

async function finishAbandoned(
  job: ClaimedJob,
  workerId: string,
  reason: string,
): Promise<void> {
  await withWorker(async (c) => {
    await c.query("SELECT app.abandon_job($1, $2, $3)", [job.id, workerId, reason]);
  });
}

async function finishFailed(
  job: ClaimedJob,
  workerId: string,
  error: string,
): Promise<string> {
  return withWorker(async (c) => {
    const { rows } = await c.query<{ fail_job: string }>(
      "SELECT app.fail_job($1, $2, $3)",
      [job.id, workerId, error],
    );
    return rows[0]?.fail_job ?? "queued";
  });
}

/**
 * Claim one job and see it through. Returns `{claimed: false}` when the queue
 * is empty, which is the loop's signal to sleep rather than spin.
 */
export async function runOnce(opts: RunOptions): Promise<RunResult> {
  const { workerId, leaseSeconds = 300, fetcher } = opts;
  const liveEnabled = opts.liveEnabled ?? liveIsEnabled();

  const job = await claim(workerId, leaseSeconds);
  if (!job) return { claimed: false };

  let decision: Decision;
  try {
    const ctx = await loadContext(job);
    decision = decidePublish({
      job: { mode: job.mode },
      item: ctx.item,
      channel: ctx.channel,
      accessToken: ctx.accessToken,
      liveEnabled,
    });
  } catch (cause) {
    // Reading the job's own context failed — a dropped connection, most
    // likely. That is weather, so it retries.
    const next = await finishFailed(job, workerId, `could not load job context: ${String(cause)}`);
    return { claimed: true, jobId: job.id, outcome: next === "dead" ? "abandoned" : "retrying" };
  }

  if (decision.action === "abandon") {
    await finishAbandoned(job, workerId, decision.reason);
    return { claimed: true, jobId: job.id, outcome: "abandoned", detail: decision.reason };
  }

  if (decision.action === "dry_run") {
    // ⛔ No `send()`, no fetcher, no token. The rehearsal ends here, and
    // `complete_publish` leaves the content item exactly as it found it —
    // the database refuses to mark a dry run published even if this code
    // asked it to.
    await finishSucceeded(job, workerId, null, decision.note);
    return { claimed: true, jobId: job.id, outcome: "rehearsed", detail: decision.note };
  }

  try {
    const result = await send(decision.request, fetcher);
    await finishSucceeded(job, workerId, result.url, `${decision.note} → ${result.platformId}`);
    return { claimed: true, jobId: job.id, outcome: "published", detail: result.url };
  } catch (cause) {
    const retryable = cause instanceof SendError ? cause.retryable : true;
    const message = cause instanceof Error ? cause.message : String(cause);

    if (!retryable) {
      await finishAbandoned(job, workerId, message);
      return { claimed: true, jobId: job.id, outcome: "abandoned", detail: message };
    }
    const next = await finishFailed(job, workerId, message);
    return {
      claimed: true,
      jobId: job.id,
      outcome: next === "dead" ? "abandoned" : "retrying",
      detail: message,
    };
  }
}

/** Return abandoned work to the queue. Called on each idle turn. */
export async function reapExpired(): Promise<number> {
  return withWorker(async (c) => {
    const { rows } = await c.query<{ reap_expired_leases: number }>(
      "SELECT app.reap_expired_leases()",
    );
    return rows[0]?.reap_expired_leases ?? 0;
  });
}
