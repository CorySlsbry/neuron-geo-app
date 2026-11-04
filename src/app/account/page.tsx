"use client";
import { useCallback, useEffect, useState } from "react";
import AppShell from "@/components/AppShell";
import { useRouter } from "next/navigation";
import { api, ApiError } from "@/lib/client/api";
import PageSkeleton from "@/components/Skeleton";
import { useFirstLoad } from "@/lib/client/useFirstLoad";

interface Preview {
  tenantName: string;
  rowCounts: { table: string; rows: number }[];
  totalRows: number;
}

export default function AccountPage() {
  const router = useRouter();
  // Has the first load finished? The list state starts as [] and
  // cannot answer that on its own.
  const [loaded, setLoaded] = useState(false);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [typed, setTyped] = useState("");
  const [stage, setStage] = useState<"idle" | "confirming">("idle");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notOwner, setNotOwner] = useState(false);
  /** Owner, but without the second factor the delete flow requires. */
  const [needsFactor, setNeedsFactor] = useState(false);
  /**
   * ⛔ The export route requires aal2, and the download is a plain
   * `<a href download>` — a NAVIGATION, which has no catch block and never
   * reaches the app's step-up banner. So a signed-in aal1 owner clicking
   * "Download all my data" was served `{"error":{"code":"aal2_required"}}`
   * rendered as a page, on the one screen whose entire job is "your data is
   * yours". Found by clicking it in a real browser (2026-08-14).
   *
   * Ask first, then offer. Same rule the Channels screen follows for Connect.
   */
  const [canExport, setCanExport] = useState(false);
  // First load only: the latch inside useFirstLoad means act()'s
  // refetch after every save never re-arms this.
  const showSkeleton = useFirstLoad(loaded);

  const load = useCallback(async () => {
    try {
      // The aal read is separate and must not take the page down with it:
      // failing to learn the factor level is a reason to hide the download,
      // not a reason to lose the delete flow underneath it.
      api<{ aal: "aal1" | "aal2" }>("/api/me")
        .then((me) => setCanExport(me.aal === "aal2"))
        .catch(() => setCanExport(false));
      setPreview(await api<Preview>("/api/account/delete"));
      setLoaded(true);
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) {
        router.push("/login");
        return;
      }
      /**
       * ⛔ TWO DIFFERENT 403s, AND THEY ARE NOT THE SAME SENTENCE.
       *
       * The delete preview requires owner AND aal2. This catch used to answer
       * every 403 with `notOwner`, which told the actual owner "only the
       * owner can delete the business account" — a false statement, on the
       * screen whose whole job is proving the data is theirs. Worse, it never
       * set `loaded`, so the page sat on its skeleton forever: the honest
       * information was in the app-wide step-up banner and the body below it
       * was a permanent "Loading…".
       *
       * Found by opening the page as a real signed-in owner without a second
       * factor (2026-08-14) — the exact state a reviewer filming the
       * data-deletion path arrives in.
       */
      if (e instanceof ApiError && e.code === "aal2_required") setNeedsFactor(true);
      else if (e instanceof ApiError && e.status === 403) setNotOwner(true);
      else setError("Couldn't load your account details.");
      // Whatever the answer, the page has finished loading and must stop
      // pretending otherwise.
      setLoaded(true);
    }
  }, [router]);

  useEffect(() => {
    void load();
  }, [load]);

  async function deleteEverything() {
    setBusy(true);
    setError("");
    try {
      await api("/api/account/delete", { method: "POST", json: { confirmName: typed } });
      router.push("/login?deleted=1");
    } catch (e) {
      setError(
        e instanceof ApiError && e.code === "name_mismatch"
          ? "That doesn't match your business name exactly. Check the spelling."
          // Accurate now that the purge runs FIRST and in one transaction: if it
          // fails it rolls back whole, so nothing is half-deleted. Saying
          // "nothing was removed" was previously a lie whenever the Stripe
          // cancel had already gone through.
          : "Couldn't complete the deletion. Your data is untouched. Give us a call.",
      );
      setBusy(false);
    }
  }

  // First paint: a wireframe of this screen, inside the shell. Never on a
  // refetch — useFirstLoad latches, so saving does not re-flash the page.
  if (!loaded) {
    return (
      <AppShell title="Your data">
        {showSkeleton && <PageSkeleton kind="form" />}
        {error && <p className="error">{error}</p>}
      </AppShell>
    );
  }

  return (
    <AppShell title="Your data">
      <div className="card">
        <h2 style={{ marginTop: 0 }}>Download everything</h2>
        <p className="muted">
          One file with every record we hold for your business. Your team, your
          settings, your billing history, and every piece of work as the
          product grows. One CSV per table, openable in Excel. This works
          whether or not you have a subscription, forever.
        </p>
        {canExport ? (
          <a
            className="pill"
            style={{ padding: "10px 16px", textDecoration: "none", display: "inline-block" }}
            href="/api/account/export"
            download
          >
            ⬇ Download all my data (.zip)
          </a>
        ) : (
          <>
            <a
              className="pill"
              style={{ padding: "10px 16px", textDecoration: "none", display: "inline-block" }}
              href="/security"
            >
              Turn on 2-step verification to download
            </a>
            <p className="muted" style={{ marginBottom: 0 }}>
              This file is the whole business in one download, so it asks for a
              second factor first. It takes a minute to set up.
            </p>
          </>
        )}
      </div>

      {needsFactor ? (
        <div className="card">
          <h2 style={{ marginTop: 0 }}>Delete everything</h2>
          <p className="muted">
            Deleting the business account asks for 2-step verification first,
            because it cannot be undone. Turn it on and come back to this page.
          </p>
          <a
            className="pill"
            style={{ padding: "10px 16px", textDecoration: "none", display: "inline-block" }}
            href="/security"
          >
            Set up 2-step verification
          </a>
        </div>
      ) : notOwner ? (
        <div className="card">
          <p className="muted" style={{ margin: 0 }}>
            Only the owner can delete the business account.
          </p>
        </div>
      ) : (
        <div className="card" style={{ borderColor: "var(--danger)" }}>
          <h2 style={{ marginTop: 0, color: "var(--danger)" }}>Delete everything</h2>
          <p>
            This erases your business from Neuron SEO: every record, every
            person. It cancels your subscription. It cannot be undone, and we
            cannot bring it back for you afterward.
          </p>
          <p className="muted">
            <strong>Download your data first.</strong> Once this is done, the export
            button above has nothing left to give you.
          </p>
          {preview && preview.totalRows > 0 && (
            <p className="muted">
              You&apos;re about to delete <strong>{preview.totalRows.toLocaleString()}</strong> records
              across {preview.rowCounts.length} tables.
            </p>
          )}
          {stage === "idle" ? (
            <button className="secondary" onClick={() => setStage("confirming")}>
              I want to delete my account
            </button>
          ) : (
            <>
              <label htmlFor="confirm">
                Type your business name exactly, <strong>{preview?.tenantName}</strong>, to confirm
              </label>
              <input
                id="confirm"
                value={typed}
                onChange={(e) => setTyped(e.target.value)}
                placeholder={preview?.tenantName ?? ""}
                autoComplete="off"
              />
              <div className="row" style={{ marginTop: 10 }}>
                <button
                  disabled={busy || typed.trim() !== (preview?.tenantName ?? "").trim()}
                  style={{ background: "var(--danger)" }}
                  onClick={() => void deleteEverything()}
                >
                  Permanently delete everything
                </button>
                <button className="secondary" disabled={busy} onClick={() => setStage("idle")}>
                  Keep my account
                </button>
              </div>
            </>
          )}
        </div>
      )}

      {error && <p className="error">{error}</p>}
    </AppShell>
  );
}
