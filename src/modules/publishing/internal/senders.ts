import "server-only";
import { networkLabel, type Network } from "@/modules/channels";

/**
 * The per-network send. One function, one shape, five providers' worth of
 * difference expressed as DATA — same posture as `networks.ts`, for the same
 * reason: a second code path per provider is a second place for a bug to hide.
 *
 * ⛔ NOTHING IN THIS FILE RUNS UNLESS THREE INDEPENDENT THINGS ARE TRUE.
 * The gate is in `worker.ts` and it is checked before this module is even
 * reached, but it is written down here too because this is the file someone
 * will open when they wonder what could possibly send a real post:
 *
 *   1. the job's `mode` column says 'live' (dry_run is the default, in the
 *      database, on every row);
 *   2. `PUBLISH_LIVE_ENABLED` is exactly "true" in the environment;
 *   3. a credential exists for the channel AND decrypts with the current key.
 *
 * (3) is currently false for every network — no OAuth client exists yet, so no
 * token has ever been stored. (2) is false by default and has to be turned on
 * deliberately. A cost/blast-radius switch that lives only in an env var the
 * code never reads is decoration; this one is read, and it fails closed.
 */

export interface SendRequest {
  network: Network;
  /** The provider's own id for the connected account. */
  accountId: string;
  /** Decrypted access token. Never logged, never returned. */
  accessToken: string;
  title: string;
  body: string;
  mediaUri: string | null;
}

export interface SendResult {
  /** Where it landed. A publish that cannot say where it published is not a
   *  publish — `app.complete_publish()` refuses a live completion without it. */
  url: string;
  /** The platform's own id for the created post, for later reconciliation. */
  platformId: string;
}

export class SendError extends Error {
  /** Whether retrying could plausibly work. Rate limits and 5xx are weather;
   *  a 401 or a malformed payload is a wall, and the worker abandons rather
   *  than burning five attempts on it. */
  readonly retryable: boolean;
  constructor(message: string, retryable: boolean) {
    super(message);
    this.retryable = retryable;
  }
}

/** What a live send WOULD be. Building this is the whole of a dry run, which
 *  is what makes a rehearsal worth running: everything except the fetch. */
export interface PreparedSend {
  method: string;
  url: string;
  /** Header names only. The values carry the bearer token and must never be
   *  rendered, logged, or persisted — a dry run's whole output is safe to
   *  paste into a build log, and it stays that way by not holding secrets. */
  headerNames: string[];
  /** The body as it would be sent, with no credential in it. */
  body: unknown;
  /** Human sentence for the job's result_note. */
  summary: string;
}

/**
 * Build the request without performing it.
 *
 * Split out from `send()` on purpose: it is the part a dry run exercises, and
 * a rehearsal that skipped payload construction would prove almost nothing —
 * the payload is exactly where a wrong field name or an over-long caption
 * lives.
 */
export function prepare(req: SendRequest): PreparedSend {
  const label = networkLabel(req.network);
  const caption = captionFor(req);

  switch (req.network) {
    case "youtube":
      return {
        method: "POST",
        url: "https://www.googleapis.com/upload/youtube/v3/videos?part=snippet,status",
        headerNames: ["authorization", "content-type"],
        body: {
          snippet: { title: req.title.slice(0, 100), description: req.body },
          status: { privacyStatus: "private" },
        },
        summary:
          `would upload a video to ${label} account ${req.accountId}, ` +
          `titled "${req.title.slice(0, 60)}", created PRIVATE`,
      };

    case "facebook":
      return {
        method: "POST",
        url: `https://graph.facebook.com/v21.0/${req.accountId}/feed`,
        headerNames: ["authorization", "content-type"],
        body: { message: caption, ...(req.mediaUri ? { link: req.mediaUri } : {}) },
        summary: `would post ${caption.length} characters to ${label} page ${req.accountId}`,
      };

    case "instagram":
      return {
        method: "POST",
        url: `https://graph.facebook.com/v21.0/${req.accountId}/media`,
        headerNames: ["authorization", "content-type"],
        body: { caption, ...(req.mediaUri ? { image_url: req.mediaUri } : {}) },
        summary:
          `would create an ${label} media container for ${req.accountId}, ` +
          `then publish it (media_publish) and read back its permalink` +
          (req.mediaUri ? "" : " (NO media attached — Instagram would reject this)"),
      };

    case "tiktok":
      return {
        method: "POST",
        url: "https://open.tiktokapis.com/v2/post/publish/video/init/",
        headerNames: ["authorization", "content-type"],
        body: {
          post_info: { title: req.title.slice(0, 150), privacy_level: "SELF_ONLY" },
          source_info: { source: "PULL_FROM_URL", video_url: req.mediaUri },
        },
        summary:
          `would initiate a ${label} video publish for ${req.accountId}, ` +
          `privacy SELF_ONLY` +
          (req.mediaUri ? "" : " (NO media URL — TikTok would reject this)"),
      };

    case "linkedin":
      return {
        method: "POST",
        url: "https://api.linkedin.com/rest/posts",
        headerNames: ["authorization", "content-type", "linkedin-version"],
        body: {
          author: `urn:li:person:${req.accountId}`,
          commentary: caption,
          visibility: "PUBLIC",
          distribution: { feedDistribution: "MAIN_FEED" },
          lifecycleState: "PUBLISHED",
        },
        summary: `would post ${caption.length} characters to ${label} as ${req.accountId}`,
      };
  }
}

/**
 * Caption text. Title and body joined, trimmed to the tightest limit any of
 * the five networks enforces rather than per-network limits, so the same copy
 * is publishable everywhere and a customer never sees one channel silently
 * truncate what another accepted.
 */
const CAPTION_LIMIT = 2_200;

function captionFor(req: SendRequest): string {
  const joined = req.body.trim() ? `${req.title}\n\n${req.body}` : req.title;
  return joined.length <= CAPTION_LIMIT
    ? joined
    : `${joined.slice(0, CAPTION_LIMIT - 1).trimEnd()}…`;
}

/** Injected so tests can assert what a dry run does NOT do. */
export type Fetcher = typeof globalThis.fetch;

/**
 * Perform the send. Only ever reached from the live branch of the worker.
 *
 * Deliberately thin: it does not retry (the queue owns backoff), does not
 * decide whether to give up (the worker does, from `retryable`), and does not
 * log the request (the headers hold a bearer token).
 */
export async function send(
  req: SendRequest,
  fetcher: Fetcher = globalThis.fetch,
): Promise<SendResult> {
  const plan = prepare(req);

  const parsed = await call(req, fetcher, plan.url, plan.method, plan.body);

  // ⛔ INSTAGRAM IS TWO CALLS, AND THE FIRST ONE DOES NOT POST ANYTHING.
  // `/{ig-id}/media` creates a media CONTAINER. The post only exists after
  // `/{ig-id}/media_publish` is handed that container's id. Stopping at the
  // container returns a plausible-looking id for something no follower can
  // ever see, which is the worst available outcome: the queue records a
  // success and the customer's post does not exist.
  if (req.network === "instagram") {
    const containerId = readId(parsed);
    if (!containerId) {
      throw new SendError("Instagram accepted the container but returned no id", false);
    }
    const published = await call(
      req,
      fetcher,
      `https://graph.facebook.com/v21.0/${req.accountId}/media_publish`,
      "POST",
      { creation_id: containerId },
    );
    const mediaId = readId(published);
    if (!mediaId) {
      throw new SendError("Instagram published but returned no media id", false);
    }
    // ⛔ PAST THIS LINE THE POST IS LIVE. Anything that fails from here must
    // NOT be retryable: the queue would run the whole thing again and post a
    // second copy. Fetching the permalink is therefore best effort, and a
    // failure downgrades the URL rather than failing the publish.
    return {
      platformId: mediaId,
      url: (await permalink(req, fetcher, mediaId)) ?? "https://www.instagram.com/",
    };
  }

  const result = readResult(req.network, parsed);
  if (!result) {
    // The provider said OK but gave us nothing to point at. Treat that as a
    // failure rather than inventing a URL: `complete_publish` would accept any
    // string, so this is the only place the lie could be introduced.
    throw new SendError(
      `${req.network} accepted the post but returned no identifiable id`,
      false,
    );
  }
  return result;
}

/** One provider call, with the retryable/wall classification applied once so
 *  Instagram's second call cannot drift from the first one's error handling. */
async function call(
  req: SendRequest,
  fetcher: Fetcher,
  url: string,
  method: string,
  body: unknown,
): Promise<unknown> {
  let res: Response;
  try {
    res = await fetcher(url, {
      method,
      headers: {
        authorization: `Bearer ${req.accessToken}`,
        "content-type": "application/json",
        ...(req.network === "linkedin" ? { "linkedin-version": "202506" } : {}),
      },
      body: JSON.stringify(body),
    });
  } catch (cause) {
    // A transport failure never reached the provider, so retrying is safe and
    // is the right default.
    throw new SendError(`network error contacting ${req.network}: ${String(cause)}`, true);
  }

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    // 408/429 and 5xx are the provider asking for patience. Everything else —
    // a revoked token, a rejected payload, a missing permission — will fail
    // identically on the fifth attempt as on the first.
    const retryable = res.status === 408 || res.status === 429 || res.status >= 500;
    throw new SendError(
      `${req.network} refused the post: HTTP ${res.status} ${detail.slice(0, 300)}`,
      retryable,
    );
  }

  return (await res.json().catch(() => ({}))) as unknown;
}

function readId(payload: unknown): string | null {
  const id = (payload as Record<string, unknown> | null)?.id;
  return typeof id === "string" && id.length > 0 ? id : null;
}

/** The real post URL, or null. Best effort BY DESIGN: it runs after the post is
 *  already live, so it must never throw a retryable error and cause a repost. */
async function permalink(
  req: SendRequest,
  fetcher: Fetcher,
  mediaId: string,
): Promise<string | null> {
  try {
    const body = await call(
      req,
      fetcher,
      `https://graph.facebook.com/v21.0/${mediaId}?fields=permalink`,
      "GET",
      undefined,
    );
    const url = (body as Record<string, unknown> | null)?.permalink;
    return typeof url === "string" && url.startsWith("https://") ? url : null;
  } catch {
    return null;
  }
}

function readResult(
  // Instagram is absent on purpose: `send()` resolves it across two calls and
  // never reaches here. Excluding it makes that unrepresentable rather than a
  // comment someone can miss.
  network: Exclude<Network, "instagram">,
  payload: unknown,
): SendResult | null {
  const obj = (payload ?? {}) as Record<string, unknown>;
  const str = (v: unknown): string | null =>
    typeof v === "string" && v.length > 0 ? v : null;

  switch (network) {
    case "youtube": {
      const id = str(obj.id);
      return id ? { platformId: id, url: `https://www.youtube.com/watch?v=${id}` } : null;
    }
    case "facebook": {
      const id = str(obj.id) ?? str((obj.post_id as string | undefined));
      return id ? { platformId: id, url: `https://www.facebook.com/${id}` } : null;
    }
    case "tiktok": {
      const data = (obj.data ?? {}) as Record<string, unknown>;
      const id = str(data.publish_id);
      // TikTok's init call returns a publish id, not a watch URL — the video
      // does not exist yet. Pointing at the account is the honest answer; a
      // fabricated /video/<publish_id> link would 404 for the customer.
      return id
        ? { platformId: id, url: "https://www.tiktok.com/" }
        : null;
    }
    case "linkedin": {
      const id = str(obj.id);
      return id
        ? { platformId: id, url: `https://www.linkedin.com/feed/update/${id}` }
        : null;
    }
  }
}
