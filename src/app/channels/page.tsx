"use client";
import { Suspense, useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import AppShell from "@/components/AppShell";
import PageSkeleton from "@/components/Skeleton";
import { api, ApiError } from "@/lib/client/api";
import { useFirstLoad } from "@/lib/client/useFirstLoad";

/**
 * Channels: the screen a platform reviewer watches.
 *
 * ⛔ A CONNECT BUTTON IS EITHER REAL OR VISIBLY DISABLED. There is no third
 * state. The server decides which, per network, from whether its client id,
 * its secret and the token-sealing key are all present — and when it says no
 * it also says which variable is missing. A button that looks live and then
 * fails is the exact frame that gets an app rejected, so this screen would
 * rather show five disabled cards than one hopeful one.
 */

interface ChannelCard {
  network: string;
  label: string;
  blurb: string;
  configured: boolean;
  reason: string | null;
  channel: {
    id: string;
    handle: string | null;
    status: "connected" | "disconnected" | "error";
    scopes: string[];
    connectedAt: string | null;
    lastError: string | null;
  } | null;
}

/** The callback's machine codes, in plain language. */
const CALLBACK_WORDS: Record<string, string> = {
  consent_declined: "No problem. Nothing was connected.",
  provider_error: "That network turned the request down. Nothing was connected.",
  state_mismatch:
    "That sign-in didn't match the one this browser started, so it was stopped. Try connecting again.",
  tenant_changed:
    "You switched workspace part-way through, so it was stopped. Try connecting again from this workspace.",
  connect_expired: "That took a little too long. Try connecting again.",
  incomplete_callback: "The network sent us back without an answer. Try again.",
  network_not_configured: "That network isn't set up on this deployment yet.",
  token_exchange_failed: "That network wouldn't finish the handshake. Try again.",
  identity_lookup_failed:
    "We connected, but that network wouldn't tell us which account it was. Try again.",
  provider_unreachable: "We couldn't reach that network. Try again in a moment.",
  subscription_required:
    "Your workspace is read-only right now, so nothing new can be connected.",
  connect_failed: "That didn't work. Nothing was connected.",
};

function statusPill(status: string) {
  if (status === "connected") {
    return (
      <span
        className="pill"
        style={{ background: "var(--go-tint)", borderColor: "var(--go)" }}
      >
        Connected
      </span>
    );
  }
  if (status === "error") {
    return (
      <span
        className="pill"
        style={{ background: "var(--danger-tint)", borderColor: "var(--danger)" }}
      >
        Needs attention
      </span>
    );
  }
  return <span className="pill">Not connected</span>;
}

function ChannelsInner() {
  const router = useRouter();
  const search = useSearchParams();
  const [cards, setCards] = useState<ChannelCard[] | null>(null);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [note, setNote] = useState("");
  const showSkeleton = useFirstLoad(cards !== null);

  const load = useCallback(async () => {
    try {
      const r = await api<{ channels: ChannelCard[] }>("/api/channels");
      setCards(r.channels);
    } catch (e) {
      if (e instanceof ApiError && (e.status === 401 || e.status === 403)) {
        router.push("/login");
      } else {
        setError("Couldn't load your channels.");
      }
    }
  }, [router]);

  useEffect(() => {
    void load();
  }, [load]);

  // The OAuth callback comes back as a redirect carrying one of these, because
  // it is a top-level navigation and cannot hand the page an error object.
  useEffect(() => {
    const connected = search.get("connected");
    const failed = search.get("error");
    if (connected) setNote(`${connected} is connected.`);
    if (failed) setError(CALLBACK_WORDS[failed] ?? "That didn't work. Nothing was connected.");
  }, [search]);

  async function connect(network: string) {
    setBusy(network);
    setError("");
    setNote("");
    try {
      const r = await api<{ authorizeUrl: string }>("/api/channels/connect", {
        method: "POST",
        json: { network },
      });
      // The one navigation, and only after the server agreed. Everything that
      // could refuse has already refused, in place, above.
      window.location.href = r.authorizeUrl;
    } catch (e) {
      setBusy("");
      setError(e instanceof ApiError ? e.message : "Couldn't start that connection.");
    }
  }

  async function disconnect(card: ChannelCard) {
    if (!card.channel) return;
    setBusy(card.network);
    setError("");
    setNote("");
    try {
      await api(`/api/channels/${card.channel.id}/disconnect`, { method: "POST" });
      setNote(
        `${card.label} is disconnected. We deleted our copy of the access token.`,
      );
      await load();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Couldn't disconnect that.");
    } finally {
      setBusy("");
    }
  }

  if (showSkeleton) {
    return <PageSkeleton kind="list" label="Loading your channels…" />;
  }

  return (
    <>
      {note && (
        <div className="banner" role="status" style={{ background: "var(--go-tint)", borderColor: "var(--go)" }}>
          {note}
        </div>
      )}
      {error && (
        <div className="banner" role="alert">
          {error}
        </div>
      )}

      <p className="muted" style={{ maxWidth: 640 }}>
        Connecting an account opens that network&apos;s own sign-in page. We
        never see your password. You approve every post before it goes
        anywhere, and disconnecting deletes our copy of the access token.{" "}
        <Link href="/data-deletion">How to delete your data</Link>
      </p>

      {cards?.map((card) => {
        const live = card.channel?.status === "connected";
        return (
          <section className="card" key={card.network}>
            <div className="row">
              <div className="grow">
                <div className="row" style={{ gap: 8 }}>
                  <strong>{card.label}</strong>
                  {statusPill(card.channel?.status ?? "disconnected")}
                </div>
                <p className="muted" style={{ margin: "6px 0 0" }}>
                  {live && card.channel?.handle
                    ? `Connected as ${card.channel.handle}`
                    : card.blurb}
                </p>
                {card.channel?.lastError && (
                  <p className="error" style={{ marginBottom: 0 }}>
                    {card.channel.lastError}
                  </p>
                )}
                {!card.configured && (
                  // The honest disabled state. It names what is missing rather
                  // than saying "coming soon", because the person reading this
                  // is usually the person who can fix it.
                  <p className="muted" style={{ marginBottom: 0 }}>
                    {card.reason}
                  </p>
                )}
              </div>

              <div className="row">
                {live ? (
                  <button
                    type="button"
                    className="secondary"
                    disabled={busy === card.network}
                    onClick={() => void disconnect(card)}
                  >
                    {busy === card.network ? "Disconnecting…" : "Disconnect"}
                  </button>
                ) : (
                  <button
                    type="button"
                    disabled={!card.configured || busy === card.network}
                    title={card.reason ?? undefined}
                    aria-describedby={card.configured ? undefined : `why-${card.network}`}
                    onClick={() => void connect(card.network)}
                  >
                    {busy === card.network ? "Opening…" : "Connect"}
                  </button>
                )}
              </div>
            </div>
            {!card.configured && (
              // A `title` tooltip is invisible to a screen reader and to
              // anyone on a touch screen, so the reason is also in the text
              // above and wired to the button by id.
              <span id={`why-${card.network}`} className="sr-only">
                {card.reason}
              </span>
            )}
          </section>
        );
      })}
    </>
  );
}

export default function ChannelsPage() {
  return (
    <AppShell title="Channels">
      {/* useSearchParams needs a Suspense boundary — the callback's result is
          read from the URL, so this page genuinely depends on it. */}
      <Suspense fallback={<PageSkeleton kind="list" label="Loading your channels…" />}>
        <ChannelsInner />
      </Suspense>
    </AppShell>
  );
}
