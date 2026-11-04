import "server-only";
import { withTenant, type TenantScope } from "@/lib/db/tenant";
import type { PoolClient } from "pg";

/** The web tier's half of publishing: asking for it, and reading what happened. */

export class PublishError extends Error {}

export type JobStatus = "queued" | "running" | "succeeded" | "failed" | "dead";

export interface PublishJob {
  id: string;
  mode: "dry_run" | "live";
  status: JobStatus;
  contentItemId: string;
  channelId: string;
  attempts: number;
  lastError: string | null;
  resultNote: string | null;
  createdAt: string;
  finishedAt: string | null;
}

const SELECT_COLUMNS = `
  id, mode, status, content_item_id, channel_id, attempts,
  last_error, result_note,
  created_at::text AS created_at,
  finished_at::text AS finished_at`;

interface JobRow {
  id: string;
  mode: string;
  status: string;
  content_item_id: string;
  channel_id: string;
  attempts: number;
  last_error: string | null;
  result_note: string | null;
  created_at: string;
  finished_at: string | null;
}

function toJob(r: JobRow): PublishJob {
  return {
    id: r.id,
    mode: r.mode === "live" ? "live" : "dry_run",
    status: (["queued", "running", "succeeded", "failed", "dead"] as const).find(
      (s) => s === r.status,
    ) ?? "queued",
    contentItemId: r.content_item_id,
    channelId: r.channel_id,
    attempts: r.attempts,
    lastError: r.last_error,
    resultNote: r.result_note,
    createdAt: r.created_at,
    finishedAt: r.finished_at,
  };
}

/**
 * Queue a publish for an approved item.
 *
 * ⛔ `mode` DEFAULTS TO "dry_run" HERE TOO, not only in the database. Two
 * defaults for one decision looks redundant until you notice they protect
 * against different mistakes: the column default catches a row inserted by
 * some future path that forgot the field, and this one catches a caller that
 * passes `undefined` because a form field was missing. Neither is a substitute
 * for the other, and the expensive direction of this particular mistake is
 * a real post on a customer's account.
 *
 * Idempotent by construction: `app.enqueue_publish` conflicts on
 * (tenant, content item, channel, mode), so a double-clicked Approve returns
 * the job that already exists.
 */
export async function enqueuePublish(
  scope: TenantScope,
  contentItemId: string,
  channelId: string,
  mode: "dry_run" | "live" = "dry_run",
): Promise<string> {
  return withTenant(scope, async (c) => {
    try {
      const { rows } = await c.query<{ enqueue_publish: string }>(
        "SELECT app.enqueue_publish($1, $2, $3)",
        [contentItemId, channelId, mode],
      );
      const id = rows[0]?.enqueue_publish;
      if (!id) throw new PublishError("the queue did not return a job id");
      return id;
    } catch (cause) {
      // The function raises for the two conditions a customer can actually
      // cause, and both deserve the plain sentence rather than a 500.
      const message = cause instanceof Error ? cause.message : String(cause);
      if (message.includes("only approved content")) {
        throw new PublishError("Only approved content can be published.");
      }
      if (message.includes("not found in this tenant")) {
        throw new PublishError("That content item is not in this workspace.");
      }
      // A cross-tenant channel is refused by the composite foreign key, not by
      // a check we wrote. Translate it rather than leaking a constraint name.
      if (message.includes("foreign key") || message.includes("23503")) {
        throw new PublishError("That channel is not connected to this workspace.");
      }
      throw cause;
    }
  });
}

/**
 * The same enqueue, on a caller-supplied client.
 *
 * ⛔ EXISTS SO APPROVAL AND QUEUEING CAN BE ONE TRANSACTION. `enqueuePublish`
 * opens its own, which is right for a standalone call and wrong when the
 * approval that authorises the post is being written in the same breath. Split
 * across two transactions there are two ways to end up lying to a customer: an
 * item marked approved with nothing queued (the post silently never happens),
 * or a job queued against an approval that rolled back.
 *
 * The caller is responsible for the client already being tenant-scoped — every
 * current caller gets that from `withTenant`.
 */
export async function enqueuePublishOn(
  client: PoolClient,
  contentItemId: string,
  channelId: string,
  mode: "dry_run" | "live",
): Promise<string> {
  const { rows } = await client.query<{ enqueue_publish: string }>(
    "SELECT app.enqueue_publish($1, $2, $3)",
    [contentItemId, channelId, mode],
  );
  const id = rows[0]?.enqueue_publish;
  if (!id) throw new PublishError("the queue did not return a job id");
  return id;
}

/**
 * What mode newly queued jobs should carry.
 *
 * ⛔ IT REFLECTS WHAT THE SYSTEM CAN ACTUALLY DO, WHICH IS THE HONEST CHOICE.
 * Approving IS approval to post (Cory, 2026-08-15), so when live publishing is
 * switched on, an approval queues a real publish. When it is off, queueing
 * `live` anyway would mean every approval produced a dead job carrying the
 * message "live publishing is switched off" — noise that teaches an operator
 * to ignore dead jobs, which is the opposite of what a dead-letter is for.
 *
 * So the queue records the strongest thing this deployment can honestly
 * attempt. The worker re-checks the switch independently at claim time and is
 * the authoritative gate; this only decides what to write down.
 */
export function publishModeForNewJobs(): "dry_run" | "live" {
  return process.env.PUBLISH_LIVE_ENABLED === "true" ? "live" : "dry_run";
}

/** Publish history for one content item, newest first. */
export async function jobsForItem(
  scope: TenantScope,
  contentItemId: string,
): Promise<PublishJob[]> {
  return withTenant(scope, async (c: PoolClient) => {
    const { rows } = await c.query<JobRow>(
      `SELECT ${SELECT_COLUMNS} FROM jobs
        WHERE content_item_id = $1
        ORDER BY created_at DESC`,
      [contentItemId],
    );
    return rows.map(toJob);
  });
}

/**
 * The queue as the workspace sees it, newest first.
 *
 * Honest by omission: there is no "estimated time" and no progress bar. The
 * worker is a batch process on a laptop, and a countdown the system cannot
 * honour is worse than a status that simply says what state the row is in.
 */
export async function recentJobs(scope: TenantScope, limit = 25): Promise<PublishJob[]> {
  return withTenant(scope, async (c) => {
    const { rows } = await c.query<JobRow>(
      `SELECT ${SELECT_COLUMNS} FROM jobs ORDER BY created_at DESC LIMIT $1`,
      [Math.min(Math.max(limit, 1), 100)],
    );
    return rows.map(toJob);
  });
}
