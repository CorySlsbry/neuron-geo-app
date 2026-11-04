"use client";
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import AppShell from "@/components/AppShell";
import PageSkeleton from "@/components/Skeleton";
import { api, ApiError } from "@/lib/client/api";
import { useFirstLoad } from "@/lib/client/useFirstLoad";

/**
 * Home: the outcome view.
 *
 * ⛔ EVERY NUMBER ON THIS SCREEN IS A ROW COUNT. There is no chart, no
 * projection, no "estimated reach", and no placeholder figure waiting to be
 * swapped for a real one — because a placeholder that ships is
 * indistinguishable from a lie, and this is the first screen a platform
 * reviewer sees. When there is nothing to count the screen says so and says
 * what to do next, which is more useful than a zero anyway.
 *
 * The one number that could mislead even while being true is content count
 * when every row is a seeded sample. So the sample count travels with the
 * others and the screen says it out loud.
 */

interface Overview {
  brand: { name: string; domain: string | null; onboardedAt: string | null };
  channelsConnected: number;
  awaitingReview: number;
  approved: number;
  published: number;
  sampleContent: number;
  totalContent: number;
  onboarded: boolean;
}

function Stat({ label, value, href }: { label: string; value: number; href?: string }) {
  const body = (
    <>
      <span className="muted">{label}</span>
      <span className="big" style={{ display: "block" }}>
        {value.toLocaleString()}
      </span>
    </>
  );
  return (
    <div style={{ minWidth: 132 }}>
      {href ? (
        <Link href={href} style={{ textDecoration: "none", color: "inherit" }}>
          {body}
        </Link>
      ) : (
        body
      )}
    </div>
  );
}

export default function HomePage() {
  const router = useRouter();
  const [data, setData] = useState<Overview | null>(null);
  const [error, setError] = useState("");
  const showSkeleton = useFirstLoad(data !== null);

  const load = useCallback(async () => {
    try {
      setData(await api<Overview>("/api/overview"));
    } catch (e) {
      if (e instanceof ApiError && (e.status === 401 || e.status === 403)) {
        router.push("/login");
      } else {
        setError("Couldn't load your workspace.");
      }
    }
  }, [router]);

  useEffect(() => {
    void load();
  }, [load]);

  if (showSkeleton) {
    return (
      <AppShell title="Home">
        <PageSkeleton kind="stats" label="Loading your workspace…" />
      </AppShell>
    );
  }

  /**
   * The one next step, chosen in the order a person actually meets them.
   * Exactly one card, never a checklist: a list of four things to do is a
   * list of four things not done.
   */
  function nextStep(d: Overview) {
    if (!d.onboarded) {
      return {
        title: "Finish setting up",
        body: "Tell us your brand name and the domain you want cited. It takes about a minute.",
        cta: "Set up your brand",
        href: "/onboard",
      };
    }
    if (d.channelsConnected === 0) {
      return {
        title: "Connect a channel",
        body: "Nothing can be published until at least one account is connected. You approve every post before it goes anywhere.",
        cta: "Go to channels",
        href: "/channels",
      };
    }
    if (d.totalContent === 0) {
      return {
        title: "Nothing in the queue yet",
        body: "When drafts are ready they land in Review, and nothing is published until you approve it.",
        cta: "Open review",
        href: "/review",
      };
    }
    if (d.awaitingReview > 0) {
      return {
        title:
          d.awaitingReview === 1
            ? "One item is waiting for you"
            : `${d.awaitingReview} items are waiting for you`,
        body: "Read each one, then approve or reject it. Nothing is published without your approval.",
        cta: "Open review",
        href: "/review",
      };
    }
    return {
      title: "You're all caught up",
      body: "Nothing is waiting on you right now. New drafts will show up in Review.",
      cta: "Open review",
      href: "/review",
    };
  }

  return (
    <AppShell title="Home">
      {error && <p className="error">{error}</p>}

      {data && (
        <>
          <section className="card">
            <h2 style={{ marginTop: 0 }}>{nextStep(data).title}</h2>
            <p className="muted" style={{ maxWidth: 620 }}>
              {nextStep(data).body}
            </p>
            <Link href={nextStep(data).href}>
              <button type="button">{nextStep(data).cta}</button>
            </Link>
          </section>

          <section className="card" aria-label="Your numbers">
            <div className="row" style={{ gap: 28 }}>
              <Stat
                label="Channels connected"
                value={data.channelsConnected}
                href="/channels"
              />
              <Stat label="Waiting for review" value={data.awaitingReview} href="/review" />
              <Stat label="Approved" value={data.approved} href="/review" />
              <Stat label="Published" value={data.published} />
            </div>
            <p className="muted" style={{ marginBottom: 0, marginTop: 14 }}>
              {/*
                The honest footnote, and the reason `sampleContent` is on the
                payload at all. "3 items approved" is TRUE and still misleading
                when all three are the demo rows, so the screen never lets that
                stand on its own.
              */}
              {data.totalContent === 0
                ? "These are live counts of your own records. There is nothing to count yet."
                : data.sampleContent > 0 && data.sampleContent === data.totalContent
                  ? "Everything counted here is sample content, added so you can try the review flow. None of it has been published."
                  : data.sampleContent > 0
                    ? `Counted from your own records. ${data.sampleContent} of them are sample items, clearly labelled in Review.`
                    : "Counted from your own records."}
            </p>
          </section>

          {data.published === 0 && data.approved > 0 && (
            <section className="card">
              <h3 style={{ marginTop: 0 }}>Approved, not published</h3>
              <p className="muted" style={{ marginBottom: 0, maxWidth: 620 }}>
                Automatic publishing is not switched on yet, so approved items
                stay here until it is. Nothing has been posted to your accounts.
              </p>
            </section>
          )}

          {data.brand.domain && (
            <p className="muted">
              Working on behalf of {data.brand.name} ({data.brand.domain}).{" "}
              <Link href="/onboard">Change this</Link>
            </p>
          )}
        </>
      )}
    </AppShell>
  );
}
