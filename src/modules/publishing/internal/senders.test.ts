import { describe, expect, it, vi } from "vitest";
import { NETWORKS } from "@/modules/channels";
import { prepare, send, SendError, type SendRequest } from "./senders";

function req(over: Partial<SendRequest> = {}): SendRequest {
  return {
    network: "youtube",
    accountId: "UC_test",
    accessToken: "secret-token",
    title: "A title",
    body: "A body.",
    mediaUri: "https://example.com/a.mp4",
    ...over,
  };
}

describe("prepare builds a real request without performing it", () => {
  it("covers every network, with a summary and no credential in it", () => {
    for (const network of NETWORKS) {
      const plan = prepare(req({ network }));
      expect(plan.url, `${network} needs an endpoint`).toMatch(/^https:\/\//);
      expect(plan.method).toBe("POST");
      expect(plan.summary.length, `${network} needs a summary`).toBeGreaterThan(10);
      // The summary is written to the jobs table and read in build logs.
      expect(JSON.stringify(plan.body)).not.toContain("secret-token");
      expect(plan.summary).not.toContain("secret-token");
    }
  });

  it("creates YouTube uploads PRIVATE, never public", () => {
    // A verification recording is filmed on a real account. A demo publish
    // that lands publicly on a customer's channel is not recoverable by an
    // apology, so the default is the quiet one.
    const plan = prepare(req({ network: "youtube" }));
    expect(JSON.stringify(plan.body)).toContain('"privacyStatus":"private"');
  });

  it("keeps YouTube to videos.insert, which is all youtube.upload can do", () => {
    /**
     * ⛔ THIS TEST IS AN OAUTH SCOPE LOCK, NOT AN ENDPOINT PREFERENCE.
     *
     * We request `youtube.upload`, and Google is explicit that it "allows an
     * application to upload files to the authenticated user's YouTube channel,
     * but doesn't allow other types of access". Confirmed endpoint by endpoint:
     * `videos.update` and `playlistItems.insert` accept ONLY youtubepartner,
     * youtube and youtube.force-ssl. `youtube.upload` is not on their lists.
     *
     * So the moment this sender edits a title after upload, flips
     * privacyStatus later ("publish now"), retries after a metadata fix, or
     * files the upload into a playlist, the app needs `auth/youtube` instead.
     * That is a DIFFERENT sensitive scope, and changing the requested scope
     * means a NEW Google OAuth verification cycle, with its own up-to-10-day
     * tail, after the previous one has already been granted.
     *
     * The whole payload therefore has to be right on the insert. If you came
     * here to add a follow-up call, that is the decision you are actually
     * making, and it belongs in NEEDS-CORY before it belongs in code.
     */
    const plan = prepare(req({ network: "youtube" }));
    expect(plan.url).toContain("/upload/youtube/v3/videos");
    // The management endpoints youtube.upload cannot reach.
    expect(plan.url).not.toMatch(/videos\/update|playlistItems|thumbnails\/set/);
    // Metadata and visibility must both ride along on the insert itself.
    expect(plan.url).toContain("part=snippet,status");
  });


  it("creates TikTok posts SELF_ONLY, never public", () => {
    const plan = prepare(req({ network: "tiktok" }));
    expect(JSON.stringify(plan.body)).toContain('"privacy_level":"SELF_ONLY"');
  });

  it("says so when a network would reject the payload for want of media", () => {
    // Better to read this in a rehearsal than to learn it from a 400 during
    // filming. Instagram and TikTok cannot post without media.
    for (const network of ["instagram", "tiktok"] as const) {
      const plan = prepare(req({ network, mediaUri: null }));
      expect(plan.summary, `${network} should warn`).toContain("NO media");
    }
  });

  it("truncates an over-long caption instead of letting a provider do it", () => {
    const plan = prepare(
      req({ network: "linkedin", title: "T", body: "x".repeat(5_000) }),
    );
    const body = plan.body as { commentary: string };
    expect(body.commentary.length).toBeLessThanOrEqual(2_200);
    expect(body.commentary.endsWith("…")).toBe(true);
  });
});

describe("send classifies failures as weather or wall", () => {
  const okResponse = (payload: unknown) =>
    new Response(JSON.stringify(payload), { status: 200 });

  it("returns the destination URL the database will insist on", async () => {
    const fetcher = vi.fn().mockResolvedValue(okResponse({ id: "abc123" }));
    const result = await send(req(), fetcher as unknown as typeof fetch);
    expect(result.platformId).toBe("abc123");
    expect(result.url).toBe("https://www.youtube.com/watch?v=abc123");
  });

  it("publishes to YouTube in exactly one call, so no post-upload write sneaks in", async () => {
    // Companion to the scope lock in the prepare() block. That one guards the
    // FIRST request; this guards a SECOND. A follow-up videos.update would live
    // here in send(), not in prepare(), so the scope lock alone would not see
    // it - and videos.update needs auth/youtube, which we never requested. In
    // production that is a 403 the customer experiences as "it published, then
    // broke", after Google has already verified us for the narrower scope.
    const fetcher = vi.fn().mockResolvedValue(okResponse({ id: "vid_1" }));
    await send(req({ network: "youtube" }), fetcher as unknown as typeof fetch);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it.each([
    [429, true],
    [503, true],
    [500, true],
    [408, true],
    [401, false],
    [400, false],
    [403, false],
  ])("HTTP %i is retryable=%s", async (status, retryable) => {
    const fetcher = vi.fn().mockResolvedValue(new Response("nope", { status }));
    await expect(send(req(), fetcher as unknown as typeof fetch)).rejects.toSatisfy(
      (e: unknown) => e instanceof SendError && e.retryable === retryable,
    );
  });

  it("treats a transport failure as retryable — it never reached the provider", async () => {
    const fetcher = vi.fn().mockRejectedValue(new Error("ECONNRESET"));
    await expect(send(req(), fetcher as unknown as typeof fetch)).rejects.toSatisfy(
      (e: unknown) => e instanceof SendError && e.retryable,
    );
  });

  it("⛔ fails rather than invent a URL when the provider returns no id", async () => {
    // `app.complete_publish()` would accept any string, so this is the one
    // place a fabricated destination could enter the system. A 200 with an
    // unrecognisable body is not a publish.
    const fetcher = vi.fn().mockResolvedValue(okResponse({ nothing: "useful" }));
    await expect(send(req(), fetcher as unknown as typeof fetch)).rejects.toThrow(
      /no identifiable id/,
    );
  });

  it("publishes Instagram in two calls, because a container is not a post", async () => {
    /**
     * ⛔ THE BUG THIS PINS DOWN. `/{ig-id}/media` only creates a media
     * CONTAINER. Before this, send() stopped there and handed the container id
     * back as if it were a post, formatted as a facebook.com URL. The queue
     * recorded a success, `complete_publish` accepted the URL, and no follower
     * could ever see the post, because the post did not exist.
     */
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(okResponse({ id: "container_1" }))
      .mockResolvedValueOnce(okResponse({ id: "media_9" }))
      .mockResolvedValueOnce(
        okResponse({ permalink: "https://www.instagram.com/p/ABC123/" }),
      );

    const result = await send(
      req({ network: "instagram" }),
      fetcher as unknown as typeof fetch,
    );

    const [containerUrl] = fetcher.mock.calls[0] as [string, RequestInit];
    const [publishUrl, publishInit] = fetcher.mock.calls[1] as [string, RequestInit];
    expect(containerUrl).toContain("/media");
    expect(publishUrl).toContain("/media_publish");
    // The container id has to be handed to the publish call, or Instagram
    // publishes nothing and still answers 200.
    expect(String(publishInit.body)).toContain("container_1");

    // The id we keep is the MEDIA id, not the container id.
    expect(result.platformId).toBe("media_9");
    expect(result.url).toBe("https://www.instagram.com/p/ABC123/");
    // The old fabricated shape must never come back.
    expect(result.url).not.toContain("facebook.com");
    expect(result.url).not.toContain("container_1");
  });

  it("keeps an Instagram post that succeeded even if the permalink lookup fails", async () => {
    // ⛔ DOUBLE-POST HAZARD. Once media_publish returns, the post is LIVE. If a
    // later failure were allowed to propagate as retryable, the queue would run
    // the whole job again and post a second copy to a customer's account. So
    // the permalink lookup is best effort and degrades the URL instead.
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(okResponse({ id: "container_1" }))
      .mockResolvedValueOnce(okResponse({ id: "media_9" }))
      .mockResolvedValueOnce(new Response("nope", { status: 500 }));

    const result = await send(
      req({ network: "instagram" }),
      fetcher as unknown as typeof fetch,
    );

    expect(result.platformId).toBe("media_9");
    expect(result.url).toBe("https://www.instagram.com/");
  });

  it("fails an Instagram send that never got a container id, before publishing", async () => {
    const fetcher = vi.fn().mockResolvedValue(okResponse({ nothing: "useful" }));
    await expect(
      send(req({ network: "instagram" }), fetcher as unknown as typeof fetch),
    ).rejects.toThrow(/container/i);
    // It must not have attempted the publish call with an undefined id.
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("does not fabricate a TikTok watch URL from a publish id", async () => {
    // TikTok's init call returns a publish id for a video that does not exist
    // yet. A constructed /video/<publish_id> link would 404 for the customer.
    const fetcher = vi
      .fn()
      .mockResolvedValue(okResponse({ data: { publish_id: "v_pub_1" } }));
    const result = await send(
      req({ network: "tiktok" }),
      fetcher as unknown as typeof fetch,
    );
    expect(result.platformId).toBe("v_pub_1");
    expect(result.url).not.toContain("v_pub_1");
  });
});
