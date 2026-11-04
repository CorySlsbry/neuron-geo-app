"use client";
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import AppShell from "@/components/AppShell";
import PageSkeleton from "@/components/Skeleton";
import { api, ApiError } from "@/lib/client/api";
import { useFirstLoad } from "@/lib/client/useFirstLoad";
import { useTheme, type ThemePref } from "@/lib/client/useTheme";

/**
 * Settings: one place for the things a person goes looking for, each linked
 * to the screen that already does it properly.
 *
 * ⛔ IT DOES NOT REIMPLEMENT ANY OF THEM. Plan changes live on /billing, the
 * typed-confirmation delete lives on /account, invites live on /team. A
 * second copy of a destructive flow is a second place for its guard rails to
 * drift out of sync, and the delete flow's guard rail (typing the business
 * name) is the only thing standing between a mis-click and a purge.
 *
 * What it DOES own: making export, delete and the public data-deletion page
 * findable. Every platform on the verification list requires a reviewer to
 * locate the data-deletion path without being told where it is.
 */

interface Sub {
  planName: string;
  status: string;
  seatsUsed: number;
  seatCap: number;
}

const THEME_CYCLE: Record<ThemePref, ThemePref> = {
  system: "light",
  light: "dark",
  dark: "system",
};
const THEME_LABEL: Record<ThemePref, string> = {
  system: "Follow my device",
  light: "Light",
  dark: "Dark",
};

export default function SettingsPage() {
  const router = useRouter();
  const { pref, setPref } = useTheme();
  const [sub, setSub] = useState<Sub | null>(null);
  const [isOwner, setIsOwner] = useState(false);
  const [canPay, setCanPay] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  /**
   * ⛔ The export is aal2-gated at the route, and the download is a plain
   * `<a href download>` rather than a fetch — so when a signed-in aal1 user
   * clicks it, the 403 envelope is not caught by anything: the browser simply
   * renders `{"error":{"code":"aal2_required"}}` as a page. The app's step-up
   * banner never fires, because a navigation is not an api() call.
   *
   * Found by clicking it in a real browser (2026-08-14). The fix is to ask
   * BEFORE offering the link, exactly as the Channels screen asks before
   * offering a Connect button. Same rule, second surface: never render a
   * control that is going to fail.
   */
  const [canExport, setCanExport] = useState(false);
  const showSkeleton = useFirstLoad(sub !== null);

  const load = useCallback(async () => {
    try {
      const [r, me] = await Promise.all([
        api<{ subscription: Sub; canPay: boolean; isOwner: boolean }>("/api/billing"),
        api<{ aal: "aal1" | "aal2" }>("/api/me"),
      ]);
      setSub(r.subscription);
      setCanPay(r.canPay);
      setIsOwner(r.isOwner);
      setCanExport(me.aal === "aal2");
    } catch (e) {
      if (e instanceof ApiError && (e.status === 401 || e.status === 403)) {
        router.push("/login");
      } else {
        setError("Couldn't load your settings.");
      }
    }
  }, [router]);

  useEffect(() => {
    void load();
  }, [load]);

  async function openCardPortal() {
    setBusy(true);
    setError("");
    try {
      const r = await api<{ url: string }>("/api/billing/portal", {
        method: "POST",
        json: {},
      });
      window.location.href = r.url;
    } catch {
      setError("Couldn't open the card page. Try again in a minute.");
      setBusy(false);
    }
  }

  if (showSkeleton) {
    return (
      <AppShell title="Settings">
        <PageSkeleton kind="list" label="Loading your settings…" />
      </AppShell>
    );
  }

  return (
    <AppShell title="Settings">
      {error && <p className="error">{error}</p>}

      <section className="card">
        <h2 style={{ marginTop: 0 }}>Plan and billing</h2>
        {sub && (
          <p className="muted">
            You&apos;re on {sub.planName}. {sub.seatsUsed} of {sub.seatCap} seats
            used. Status: {sub.status}.
          </p>
        )}
        <div className="row">
          <Link href="/billing">
            <button type="button">Change plan</button>
          </Link>
          {isOwner && canPay && (
            <button
              type="button"
              className="secondary"
              disabled={busy}
              onClick={() => void openCardPortal()}
            >
              {busy ? "Opening…" : "Update card"}
            </button>
          )}
        </div>
        {!canPay && (
          <p className="muted" style={{ marginBottom: 0 }}>
            Card payments are not switched on for this deployment yet.
          </p>
        )}
      </section>

      <section className="card">
        <h2 style={{ marginTop: 0 }}>Appearance</h2>
        <p className="muted">
          Currently: {THEME_LABEL[pref]}. This is saved on this device.
        </p>
        <button type="button" className="secondary" onClick={() => setPref(THEME_CYCLE[pref])}>
          Switch to {THEME_LABEL[THEME_CYCLE[pref]].toLowerCase()}
        </button>
      </section>

      <section className="card">
        <h2 style={{ marginTop: 0 }}>Your team</h2>
        <p className="muted">
          Invite people by link, set what each person can see, and remove
          access.
        </p>
        <Link href="/team">
          <button type="button" className="secondary">
            Team and access
          </button>
        </Link>
      </section>

      <section className="card">
        <h2 style={{ marginTop: 0 }}>Sign-in security</h2>
        <p className="muted">
          Turn on 2-step verification for the actions that change money and
          access.
        </p>
        <Link href="/security">
          <button type="button" className="secondary">
            Sign-in security
          </button>
        </Link>
      </section>

      <section className="card">
        <h2 style={{ marginTop: 0 }}>Your data</h2>
        <p className="muted" style={{ maxWidth: 640 }}>
          Everything in this workspace is yours. Download all of it as a ZIP at
          any time, or delete the account and everything in it.
        </p>
        <div className="row">
          {/*
            A plain link, not a fetch. The export is a streamed ZIP served with
            a Content-Disposition header, so the browser's own download machinery
            handles it and a large export never has to fit in a JS string.
            That is also why it has to be gated here rather than caught: a
            navigation has no catch block.
          */}
          {canExport ? (
            <a href="/api/account/export" download>
              <button type="button" className="secondary">
                Download my data
              </button>
            </a>
          ) : (
            <Link href="/security">
              <button type="button" className="secondary">
                Turn on 2-step verification to download
              </button>
            </Link>
          )}
          <Link href="/account">
            <button type="button" className="secondary">
              Delete my account
            </button>
          </Link>
        </div>
        {!canExport && (
          <p className="muted">
            Downloading everything is the whole business in one file, so it
            asks for a second factor first. It takes a minute to set up.
          </p>
        )}
        <p className="muted" style={{ marginBottom: 0 }}>
          Deleting asks you to type the business name first, and it cannot be
          undone. <Link href="/data-deletion">How to delete your data</Link>
        </p>
      </section>

      <section className="card">
        <h2 style={{ marginTop: 0 }}>Connected accounts</h2>
        <p className="muted">
          See what this workspace is connected to, and disconnect anything you
          want to withdraw.
        </p>
        <Link href="/channels">
          <button type="button" className="secondary">
            Channels
          </button>
        </Link>
      </section>
    </AppShell>
  );
}
