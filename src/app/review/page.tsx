"use client";
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import AppShell from "@/components/AppShell";
import PageSkeleton from "@/components/Skeleton";
import { api, ApiError } from "@/lib/client/api";
import { useFirstLoad } from "@/lib/client/useFirstLoad";
import { publishLine } from "./publish-line";

/**
 * Review: the approval queue.
 *
 * The load-bearing promise of this screen is that NOTHING LEAVES THIS
 * WORKSPACE WITHOUT A PERSON SAYING SO, and the copy says that plainly rather
 * than implying it.
 *
 * ⛔ APPROVING IS APPROVAL TO POST (Cory, 2026-08-15). It queues a publish for
 * every connected channel. So the screen now has the opposite obligation to
 * the one it started with: it must not suggest a post happened when the job
 * was only a REHEARSAL. Every sentence about publishing on this page is
 * derived from real job counts (`publishLine`) or written by the server
 * (`queuedNote`) — never hardcoded, because the hardcoded version went stale
 * within a day of publishing shipping. A customer who believes they just
 * posted to their real account, and has not, is the worst outcome this
 * product has.
 *
 * Sample rows are labelled in the list, in the expanded body, and in their
 * own titles.
 */

interface Item {
  id: string;
  kind: "post" | "reel" | "answer_page";
  title: string;
  body: string;
  status: string;
  publish?: {
    total: number;
    done: number;
    pending: number;
    failed: number;
    anyLive: boolean;
    latestNote: string | null;
  };
  channelNetwork: string | null;
  channelHandle: string | null;
  publishedUrl: string | null;
  isSample: boolean;
  reviewedAt: string | null;
  createdAt: string;
}

const KIND_WORDS: Record<Item["kind"], string> = {
  post: "Post",
  reel: "Reel",
  answer_page: "Answer page",
};

const STATUS_WORDS: Record<string, string> = {
  draft: "Draft",
  in_review: "Waiting for you",
  approved: "Approved",
  rejected: "Rejected",
  published: "Published",
  failed: "Failed",
};

function statusStyle(status: string) {
  if (status === "approved" || status === "published") {
    return { background: "var(--go-tint)", borderColor: "var(--go)" };
  }
  if (status === "rejected" || status === "failed") {
    return { background: "var(--danger-tint)", borderColor: "var(--danger)" };
  }
  return undefined;
}

export default function ReviewPage() {
  const router = useRouter();
  const [queue, setQueue] = useState<Item[] | null>(null);
  const [decided, setDecided] = useState<Item[]>([]);
  const [open, setOpen] = useState<string | null>(null);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [note, setNote] = useState("");
  const showSkeleton = useFirstLoad(queue !== null);

  const load = useCallback(async () => {
    try {
      const r = await api<{ queue: Item[]; decided: Item[] }>("/api/content");
      setQueue(r.queue);
      setDecided(r.decided);
    } catch (e) {
      if (e instanceof ApiError && (e.status === 401 || e.status === 403)) {
        router.push("/login");
      } else {
        setError("Couldn't load the queue.");
      }
    }
  }, [router]);

  useEffect(() => {
    void load();
  }, [load]);

  async function decide(item: Item, decision: "approve" | "reject") {
    setBusy(item.id);
    setError("");
    setNote("");
    try {
      // The sentence comes from the SERVER, because only the server knows what
      // approving actually produced: how many channels it queued, and whether
      // those are real publishes or test runs. A note hardcoded here was wrong
      // within a day of publishing shipping, and a screen that confidently
      // states the wrong thing is worse than one that says less.
      const outcome = await api<{ queued: number; queuedNote: string | null }>(
        `/api/content/${item.id}/decide`,
        { method: "POST", json: { decision } },
      );
      setNote(
        decision === "reject"
          ? "Rejected. It won't be published."
          : (outcome?.queuedNote ??
            (outcome?.queued === 1
              ? "Approved and queued to post."
              : `Approved and queued to post on ${outcome?.queued ?? 0} channels.`)),
      );
      setOpen(null);
      await load();
    } catch (e) {
      setError(
        e instanceof ApiError && e.code === "already_reviewed"
          ? "Someone already handled that one."
          : e instanceof ApiError
            ? e.message
            : "Couldn't save that decision.",
      );
    } finally {
      setBusy("");
    }
  }

  async function addSamples() {
    setBusy("samples");
    setError("");
    try {
      await api("/api/content/samples", { method: "POST" });
      setNote("Added three sample items so you can try the flow.");
      await load();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Couldn't add the samples.");
    } finally {
      setBusy("");
    }
  }

  if (showSkeleton) {
    return (
      <AppShell title="Review">
        <PageSkeleton kind="list" label="Loading the queue…" />
      </AppShell>
    );
  }

  return (
    <AppShell title="Review">
      {note && (
        <div
          className="banner"
          role="status"
          style={{ background: "var(--go-tint)", borderColor: "var(--go)" }}
        >
          {note}
        </div>
      )}
      {error && (
        <div className="banner" role="alert">
          {error}
        </div>
      )}

      {queue && queue.length === 0 && (
        <section className="card">
          <h2 style={{ marginTop: 0 }}>Nothing is waiting on you</h2>
          <p className="muted" style={{ maxWidth: 620 }}>
            Drafts land here before they go anywhere. Nothing is ever published
            without your approval.
          </p>
          <button type="button" disabled={busy === "samples"} onClick={() => void addSamples()}>
            {busy === "samples" ? "Adding…" : "Add sample content to try this"}
          </button>
          <p className="muted" style={{ marginBottom: 0 }}>
            This adds three clearly labelled example items. They are never
            published and you can reject them.
          </p>
        </section>
      )}

      {queue?.map((item) => {
        const expanded = open === item.id;
        return (
          <section className="card" key={item.id}>
            <div className="row">
              <div className="grow">
                <div className="row" style={{ gap: 8 }}>
                  <strong>{item.title}</strong>
                  {item.isSample && (
                    <span
                      className="pill"
                      style={{ background: "var(--brand-tint)", borderColor: "var(--brand)" }}
                    >
                      Sample content
                    </span>
                  )}
                </div>
                <p className="muted" style={{ margin: "6px 0 0" }}>
                  {KIND_WORDS[item.kind]}
                  {item.channelHandle
                    ? ` for ${item.channelHandle}`
                    : item.channelNetwork
                      ? ` for ${item.channelNetwork}`
                      : " with no channel chosen yet"}
                </p>
              </div>
              <div className="row">
                <button
                  type="button"
                  className="linklike"
                  aria-expanded={expanded}
                  onClick={() => setOpen(expanded ? null : item.id)}
                >
                  {expanded ? "Hide" : "Read it"}
                </button>
                <button
                  type="button"
                  className="secondary"
                  disabled={busy === item.id}
                  onClick={() => void decide(item, "reject")}
                >
                  Reject
                </button>
                <button
                  type="button"
                  disabled={busy === item.id}
                  onClick={() => void decide(item, "approve")}
                >
                  {busy === item.id ? "Saving…" : "Approve"}
                </button>
              </div>
            </div>

            {expanded && (
              <div style={{ marginTop: 12, borderTop: "1px solid var(--line-soft)", paddingTop: 12 }}>
                {item.isSample && (
                  <p className="muted" style={{ marginTop: 0 }}>
                    This is sample content, added so you can try the review
                    flow. It will not be published.
                  </p>
                )}
                {/* whiteSpace: pre-wrap keeps the paragraphs the writer wrote,
                    without letting any of it be interpreted as markup. */}
                <p style={{ whiteSpace: "pre-wrap", margin: 0, maxWidth: 720 }}>
                  {item.body}
                </p>
              </div>
            )}
          </section>
        );
      })}

      {decided.length > 0 && (
        <section className="card" style={{ padding: 0, overflow: "hidden" }}>
          <div style={{ padding: "12px 14px", borderBottom: "1px solid var(--line-soft)" }}>
            <strong>Already decided</strong>
          </div>
          {decided.map((item) => (
            <div className="list-item" key={item.id}>
              <div className="row">
                <span className="grow">
                  {item.title}
                  {item.isSample && (
                    <span className="pill" style={{ marginLeft: 8 }}>
                      Sample
                    </span>
                  )}
                </span>
                <span className="pill" style={statusStyle(item.status)}>
                  {STATUS_WORDS[item.status] ?? item.status}
                </span>
              </div>
              {publishLine(item) && (
                <p className="muted" style={{ margin: "6px 0 0", fontSize: 13 }}>
                  {publishLine(item)}
                </p>
              )}
              {item.publishedUrl && (
                <p style={{ margin: "4px 0 0", fontSize: 13 }}>
                  <a href={item.publishedUrl} target="_blank" rel="noreferrer">
                    View the post
                  </a>
                </p>
              )}
            </div>
          ))}
          <div style={{ padding: "12px 14px" }}>
            <p className="muted" style={{ margin: 0 }}>
              {decided.some((d) => d.publish?.anyLive)
                ? "Approving an item posts it to every connected channel."
                : "Approving an item queues it for every connected channel. These are test runs: nothing has been sent to your accounts yet."}{" "}
              <Link href="/channels">See your channels</Link>
            </p>
          </div>
        </section>
      )}
    </AppShell>
  );
}
