import "server-only";
import { withTenant, type TenantScope } from "@/lib/db/tenant";
import { enqueuePublishOn, publishModeForNewJobs } from "@/modules/publishing";
import { HttpError } from "@/lib/http/errors";

export class ContentError extends HttpError {
  constructor(status: 404 | 409 | 422, code: string) {
    super(status, code);
  }
}

export type ContentKind = "post" | "reel" | "answer_page";
export type ContentStatus =
  | "draft"
  | "in_review"
  | "approved"
  | "published"
  | "failed"
  | "rejected";

export interface ContentItem {
  id: string;
  kind: ContentKind;
  title: string;
  body: string;
  mediaUri: string | null;
  status: ContentStatus;
  channelId: string | null;
  /** The channel's network + handle, so the queue can say where it would go. */
  channelNetwork: string | null;
  channelHandle: string | null;
  publishedUrl: string | null;
  publishedAt: string | null;
  /** TRUE for seeded demo rows. The UI labels these everywhere they appear. */
  isSample: boolean;
  reviewedBy: string | null;
  reviewedAt: string | null;
  createdAt: string;
  /** What approving produced. Counted from jobs, never inferred from status. */
  publish: PublishSummary;
}

interface Row {
  id: string;
  kind: string;
  title: string;
  body: string;
  media_uri: string | null;
  status: string;
  channel_id: string | null;
  channel_network: string | null;
  channel_handle: string | null;
  published_url: string | null;
  published_at: string | null;
  is_sample: boolean;
  reviewed_by: string | null;
  reviewed_at: string | null;
  created_at: string;
  pub_total: number | null;
  pub_done: number | null;
  pub_pending: number | null;
  pub_failed: number | null;
  pub_any_live: boolean | null;
  pub_latest_note: string | null;
}

/** What approving this item actually produced, counted from the jobs table. */
export interface PublishSummary {
  /** Jobs created for this item. Zero means approving queued nothing. */
  total: number;
  done: number;
  pending: number;
  failed: number;
  /** True when any job was a real publish rather than a rehearsal. */
  anyLive: boolean;
  /** The most recent job's own words, e.g. what a dry run would have sent. */
  latestNote: string | null;
}

/**
 * ⛔ THE PUBLISH SUMMARY IS COUNTED FROM `jobs`, NEVER ASSUMED FROM STATUS.
 *
 * An item's own `status` cannot answer "what happened when I approved this":
 * it stays `approved` through a rehearsal (correctly — a dry run publishes
 * nothing), and it says nothing about three channels succeeding while a fourth
 * dead-lettered. The screen has to show what actually happened per channel, so
 * the numbers come from real rows and the honest answer is sometimes "no jobs".
 */
const SELECT = `
  ci.id, ci.kind, ci.title, ci.body, ci.media_uri, ci.status, ci.channel_id,
  ch.network AS channel_network, ch.handle AS channel_handle,
  ci.published_url, ci.published_at::text AS published_at, ci.is_sample,
  ci.reviewed_by, ci.reviewed_at::text AS reviewed_at,
  ci.created_at::text AS created_at,
  pub.total AS pub_total, pub.done AS pub_done, pub.pending AS pub_pending,
  pub.failed AS pub_failed, pub.any_live AS pub_any_live,
  pub.latest_note AS pub_latest_note
  FROM content_items ci
  LEFT JOIN tenant_channels ch ON ch.id = ci.channel_id
  LEFT JOIN LATERAL (
    SELECT count(*)::int AS total,
           count(*) FILTER (WHERE j.status = 'succeeded')::int AS done,
           count(*) FILTER (WHERE j.status IN ('queued','running'))::int AS pending,
           count(*) FILTER (WHERE j.status IN ('dead','failed'))::int AS failed,
           bool_or(j.mode = 'live') AS any_live,
           (array_agg(j.result_note ORDER BY j.created_at DESC)
              FILTER (WHERE j.result_note IS NOT NULL))[1] AS latest_note
      FROM jobs j WHERE j.content_item_id = ci.id
  ) pub ON true`;

function toItem(r: Row): ContentItem {
  return {
    id: r.id,
    kind: r.kind as ContentKind,
    title: r.title,
    body: r.body,
    mediaUri: r.media_uri,
    status: r.status as ContentStatus,
    channelId: r.channel_id,
    channelNetwork: r.channel_network,
    channelHandle: r.channel_handle,
    publishedUrl: r.published_url,
    publishedAt: r.published_at,
    isSample: r.is_sample,
    reviewedBy: r.reviewed_by,
    reviewedAt: r.reviewed_at,
    createdAt: r.created_at,
    publish: {
      total: r.pub_total ?? 0,
      done: r.pub_done ?? 0,
      pending: r.pub_pending ?? 0,
      failed: r.pub_failed ?? 0,
      anyLive: r.pub_any_live ?? false,
      latestNote: r.pub_latest_note,
    },
  };
}

/** The approval queue: everything still waiting on a person. */
export async function listQueue(scope: TenantScope): Promise<ContentItem[]> {
  return withTenant(scope, async (c) => {
    const { rows } = await c.query<Row>(
      `SELECT ${SELECT}
        WHERE ci.status IN ('draft','in_review')
        ORDER BY ci.created_at DESC`,
    );
    return rows.map(toItem);
  });
}

/** Everything that has already been decided, newest first. */
export async function listDecided(
  scope: TenantScope,
  limit = 20,
): Promise<ContentItem[]> {
  return withTenant(scope, async (c) => {
    const { rows } = await c.query<Row>(
      `SELECT ${SELECT}
        WHERE ci.status NOT IN ('draft','in_review')
        ORDER BY coalesce(ci.reviewed_at, ci.created_at) DESC
        LIMIT $1`,
      [limit],
    );
    return rows.map(toItem);
  });
}

export type ReviewDecision = "approve" | "reject";

/**
 * Move an item out of the queue.
 *
 * ⛔ THE TRANSITION IS ENFORCED IN THE `WHERE` CLAUSE, not by reading the row
 * first and then writing it. Read-then-write is a lost-update race: two
 * reviewers with the queue open in two tabs both read `draft`, both decide
 * they may proceed, and the second click silently overwrites the first
 * person's decision. `AND status IN ('draft','in_review')` makes the database
 * the arbiter — exactly one UPDATE matches a row, and the loser gets zero
 * rows back and is told the item was already handled.
 *
 * ⛔ APPROVING IS APPROVAL TO POST (Cory, 2026-08-15). It moves the item to
 * `approved` AND queues a publish for every connected channel, in this same
 * transaction. It still does not write `published`: only the worker's
 * `app.complete_publish()` can, and only after a real send reported a real
 * destination URL. An approve that marked something published would be the
 * single most damaging thing this product could do on a platform recording.
 */
/**
 * What a review decision did. `queued` and `queuedNote` exist because
 * approving now also authorises the post, and the screen must be able to say
 * truthfully what that produced — including when the honest answer is nothing.
 */
export interface ReviewOutcome {
  item: ContentItem;
  /** Publish jobs created. Zero is legitimate: no channel connected yet. */
  queued: number;
  /** A plain sentence for the customer when the outcome needs explaining. */
  queuedNote: string | null;
}

export async function decide(
  scope: TenantScope,
  itemId: string,
  decision: ReviewDecision,
): Promise<ReviewOutcome> {
  const next: ContentStatus = decision === "approve" ? "approved" : "rejected";

  return withTenant(scope, async (c) => {
    const { rows } = await c.query<{ id: string }>(
      `UPDATE content_items
          SET status = $2, reviewed_by = $3, reviewed_at = now(), updated_at = now()
        WHERE id = $1 AND status IN ('draft','in_review')
        RETURNING id`,
      [itemId, next, scope.uid],
    );

    if (rows.length === 0) {
      // Nothing moved. Either the item is not ours / does not exist, or
      // somebody already decided it. Those deserve different sentences, so
      // ask which — under the same RLS scope, so "not ours" still reads as
      // "not found".
      const { rows: existing } = await c.query<{ status: string }>(
        `SELECT status FROM content_items WHERE id = $1`,
        [itemId],
      );
      if (existing.length === 0) throw new ContentError(404, "item_not_found");
      throw new ContentError(409, "already_reviewed");
    }

    await c.query(
      `INSERT INTO events (tenant_id, name, subject_type, subject_id, actor_uid, payload)
       VALUES ($1, $2, 'content_item', $3, $4, $5::jsonb)`,
      [
        scope.tenantId,
        decision === "approve" ? "content_approved" : "content_rejected",
        itemId,
        scope.uid,
        JSON.stringify({ status: next }),
      ],
    );

    // ⛔ APPROVING IS APPROVAL TO POST (Cory, 2026-08-15). Queued HERE, in the
    // same transaction as the status change, because the two must not be able
    // to disagree: an approved item with nothing queued means the post silently
    // never happens, and a job queued against an approval that rolled back
    // means a post nobody authorised.
    let queued = 0;
    let queuedNote: string | null = null;

    if (decision === "approve") {
      // Where to. An item may name its own channel; otherwise this is a
      // publish to every account the customer has actually connected, which is
      // what "post it" means for a brand running several channels.
      const { rows: targets } = await c.query<{ id: string }>(
        `SELECT ch.id
           FROM tenant_channels ch
          WHERE ch.status = 'connected'
            AND ch.id = COALESCE(
                  (SELECT channel_id FROM content_items WHERE id = $1), ch.id)
          ORDER BY ch.network`,
        [itemId],
      );

      const mode = publishModeForNewJobs();
      for (const t of targets) {
        await enqueuePublishOn(c, itemId, t.id, mode);
        queued += 1;
      }

      // Zero is a legitimate answer and the screen has to be able to say so.
      // Silently queueing nothing is how a product ends up implying it posted.
      if (queued === 0) {
        queuedNote =
          "Approved. Nothing was queued to post because no channel is connected yet.";
      } else if (mode === "dry_run") {
        queuedNote =
          queued === 1
            ? "Approved and queued as a test run. Nothing will be sent to the platform until live publishing is turned on."
            : `Approved and queued as test runs on ${queued} channels. Nothing will be sent to the platforms until live publishing is turned on.`;
      }
    }

    const { rows: fresh } = await c.query<Row>(`SELECT ${SELECT} WHERE ci.id = $1`, [
      itemId,
    ]);
    const item = fresh[0];
    if (!item) throw new ContentError(404, "item_not_found");
    return { item: toItem(item), queued, queuedNote };
  });
}

/** The real numbers Home shows. Counted from rows, never estimated. */
export interface ContentCounts {
  awaitingReview: number;
  approved: number;
  published: number;
  /** How many of the above are seeded samples — so the UI can say so. */
  sample: number;
  total: number;
}

export async function counts(scope: TenantScope): Promise<ContentCounts> {
  return withTenant(scope, async (c) => {
    const { rows } = await c.query<{
      awaiting: string;
      approved: string;
      published: string;
      sample: string;
      total: string;
    }>(
      `SELECT
         count(*) FILTER (WHERE status IN ('draft','in_review'))::text AS awaiting,
         count(*) FILTER (WHERE status = 'approved')::text  AS approved,
         count(*) FILTER (WHERE status = 'published')::text AS published,
         count(*) FILTER (WHERE is_sample)::text            AS sample,
         count(*)::text                                     AS total
       FROM content_items`,
    );
    const r = rows[0];
    return {
      awaitingReview: Number(r?.awaiting ?? 0),
      approved: Number(r?.approved ?? 0),
      published: Number(r?.published ?? 0),
      sample: Number(r?.sample ?? 0),
      total: Number(r?.total ?? 0),
    };
  });
}

/**
 * The three sample items, written exactly as they appear.
 *
 * ⛔ EVERY ONE OF THEM SAYS "Sample" IN ITS OWN TITLE, on top of carrying
 * `is_sample = true`. Belt and braces, because these rows exist to be
 * screen-recorded: if a frame of a platform-review video shows this queue,
 * the label has to survive being read at 480p by someone who has never seen
 * the product, with no legend to consult. The bodies describe what the
 * product WOULD generate; none of them claims to be published work.
 */
const SAMPLES: { kind: ContentKind; title: string; body: string }[] = [
  {
    kind: "post",
    title: "Sample: What does a GEO agency actually do?",
    body:
      "This is sample content, created so you can try the approval flow before your first real draft arrives.\n\n" +
      "A finished answer post opens with the question a buyer actually types, answers it in the first two lines, " +
      "and then backs the answer with numbers a language model can quote. That structure is what gets a brand " +
      "cited rather than merely crawled.\n\n" +
      "Approve or reject this the same way you would the real thing. Nothing is published either way.",
  },
  {
    kind: "reel",
    title: "Sample: 30-second explainer script",
    body:
      "This is sample content, created so you can try the approval flow.\n\n" +
      "Hook: most brands are invisible to the tools their buyers now ask first.\n" +
      "Middle: the fix is not more blog posts, it is answering the exact questions buyers type, with facts that " +
      "can be quoted.\n" +
      "Close: check where you get cited today, then fill the gaps.\n\n" +
      "A real script would arrive with its media attached and a channel selected.",
  },
  {
    kind: "answer_page",
    title: "Sample: How much does GEO cost?",
    body:
      "This is sample content, created so you can try the approval flow.\n\n" +
      "An answer page takes one high-intent question and answers it completely, with the price ranges, the " +
      "assumptions behind them, and the cases where the answer changes. Completeness is the ranking factor that " +
      "matters here, because a model that has to visit two sources to answer a question tends to cite neither.",
  },
];

/**
 * Put the sample items in, once.
 *
 * Deliberately an EXPLICIT action the customer takes from the empty Review
 * screen, not something signup does behind their back. Rows that appear in a
 * workspace without anyone asking are indistinguishable from the product
 * inventing work it did not do — which is the one thing Home's counts must
 * never be able to say. Idempotent: a second click adds nothing.
 */
export async function seedSamples(scope: TenantScope): Promise<number> {
  return withTenant(scope, async (c) => {
    const { rows: already } = await c.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM content_items WHERE is_sample`,
    );
    if (Number(already[0]?.n ?? 0) > 0) return 0;

    let inserted = 0;
    for (const s of SAMPLES) {
      const r = await c.query(
        `INSERT INTO content_items (tenant_id, kind, title, body, status, is_sample)
         VALUES ($1, $2, $3, $4, 'in_review', true)`,
        [scope.tenantId, s.kind, s.title, s.body],
      );
      inserted += r.rowCount ?? 0;
    }
    await c.query(
      `INSERT INTO events (tenant_id, name, actor_uid, payload)
       VALUES ($1, 'sample_content_seeded', $2, $3::jsonb)`,
      [scope.tenantId, scope.uid, JSON.stringify({ inserted })],
    );
    return inserted;
  });
}
