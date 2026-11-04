"use client";
import { useEffect, useState } from "react";
import AppShell from "@/components/AppShell";
import PageSkeleton from "@/components/Skeleton";
import { useFirstLoad } from "@/lib/client/useFirstLoad";
import QrCode from "@/components/QrCode";
import {
  establishSession,
  fetchAuthConfig,
  finishTotpEnrollment,
  signIn as identitySignIn,
  startTotpEnrollment,
  IdentityClientError,
  type AuthConfig,
  type TotpEnrollment,
} from "@/lib/client/identity";

/**
 * 2-step verification setup.
 *
 * Enrolling TOTP needs a FRESH id token (Google requires a recent login for
 * this), and our session cookie deliberately does not hold one — the cookie
 * carries identity, never a reusable credential. So the owner re-enters their
 * password here, we exchange it for a token straight with Google, enrol, and
 * then re-establish the session with the NEW token so the session actually
 * reads aal2. Skipping that last step is the classic mistake: enrolment
 * succeeds, the old token still says aal1, and the money screens stay locked
 * with no explanation.
 */
export default function SecurityPage() {
  const [cfg, setCfg] = useState<AuthConfig | null>(null);
  // First paint only — the latch means a save never re-flashes the screen.
  const showSecuritySkeleton = useFirstLoad(cfg !== null);
  const [me, setMe] = useState<{ email?: string; aal?: string } | null>(null);
  const [password, setPassword] = useState("");
  const [enrollment, setEnrollment] = useState<TotpEnrollment | null>(null);
  const [freshToken, setFreshToken] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState(false);

  useEffect(() => {
    fetchAuthConfig().then(setCfg).catch(() => setCfg(null));
    fetch("/api/me")
      .then((r) => (r.ok ? r.json() : null))
      .then(setMe)
      .catch(() => setMe(null));
  }, []);

  async function begin() {
    if (!cfg?.apiKey || !me?.email) return;
    setBusy(true);
    setError("");
    try {
      const res = await identitySignIn(cfg.apiKey, me.email, password);
      if (res.kind !== "signed_in") {
        setError("You already have 2-step verification on this account.");
        return;
      }
      setFreshToken(res.idToken);
      setEnrollment(await startTotpEnrollment(cfg.apiKey, res.idToken));
      setPassword("");
    } catch (e) {
      setError(e instanceof IdentityClientError ? e.message : "Couldn't start setup.");
    } finally {
      setBusy(false);
    }
  }

  async function confirm() {
    if (!cfg?.apiKey || !enrollment || !freshToken) return;
    setBusy(true);
    setError("");
    try {
      const newToken = await finishTotpEnrollment(
        cfg.apiKey,
        freshToken,
        enrollment.sessionInfo,
        code.trim(),
        "Authenticator app",
      );
      // Re-mint the session from the POST-enrolment token, or we stay aal1.
      await establishSession(newToken);
      setDone(true);
      setEnrollment(null);
      setFreshToken(null);
    } catch (e) {
      setError(e instanceof IdentityClientError ? e.message : "That code didn't work.");
    } finally {
      setBusy(false);
    }
  }

  const alreadyOn = me?.aal === "aal2" || done;

  if (!cfg) {
    return (
      <AppShell title="Sign-in security">
        {showSecuritySkeleton && <PageSkeleton kind="form" />}
      </AppShell>
    );
  }

  return (
    <AppShell title="Sign-in security">
      {cfg?.mode !== "identity-platform" ? (
        <div className="card">
          <p style={{ marginTop: 0 }}>
            2-step verification turns on with production sign-in. This
            environment uses the simple dev login.
          </p>
        </div>
      ) : alreadyOn ? (
        <div className="card">
          <h2 style={{ marginTop: 0 }}>You&apos;re protected ✅</h2>
          <p>
            2-step verification is on. Anything that changes money, access or
            your account asks for a code from your authenticator app first:
            inviting people, changing who can see what, changing your plan,
            or exporting or deleting the business.
          </p>
          <p className="muted">
            Day-to-day work doesn&apos;t ask for a code. Reading your
            dashboard and everyday edits run as normal. You&apos;d hate us by
            Wednesday otherwise.
          </p>
        </div>
      ) : !enrollment ? (
        <div className="card">
          <h2 style={{ marginTop: 0 }}>Turn on 2-step verification</h2>
          <p className="muted">
            Required before you can invite people, change who has access,
            change your plan, or export or delete the business. It takes about
            a minute: you&apos;ll scan a square with an authenticator app
            (Google Authenticator, 1Password, Authy, any of them), then type
            the 6-digit code it shows.
          </p>
          <label htmlFor="pw">Confirm your password</label>
          <input
            id="pw"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
          />
          <div style={{ marginTop: 12 }}>
            <button onClick={() => void begin()} disabled={busy || !password}>
              {busy ? "Starting…" : "Start setup"}
            </button>
          </div>
        </div>
      ) : (
        <div className="card">
          <h2 style={{ marginTop: 0 }}>Scan this in your authenticator app</h2>
          <p className="muted">
            Open Google Authenticator, 1Password, Authy, any of them, and
            point it at this square.
          </p>

          <QrCode
            value={enrollment.qrCodeUrl}
            size={200}
            label="QR code for setting up 2-step verification"
          />

          {/*
            Manual entry stays, because a cracked screen, a dead camera or a
            desktop-only authenticator all happen — but it is now the FALLBACK
            it always should have been, tucked behind a disclosure instead of
            sitting above the thing it is a fallback for.

            The raw otpauth:// URI that used to print here is gone: it is the
            same secret a second time, in a form nobody can use by hand, left
            in plain view for anyone glancing at the screen.
          */}
          <details style={{ marginTop: 14 }}>
            <summary style={{ cursor: "pointer" }}>Can&apos;t scan it?</summary>
            <p className="muted" style={{ marginBottom: 4 }}>
              Choose &ldquo;enter a setup key&rdquo; in your app and type this in:
            </p>
            <p
              style={{
                fontFamily: "ui-monospace, monospace",
                wordBreak: "break-all",
                userSelect: "all",
              }}
            >
              <strong>{enrollment.sharedSecretKey}</strong>
            </p>
          </details>

          <label htmlFor="code" style={{ marginTop: 12, display: "block" }}>
            Then type the 6-digit code
          </label>
          <input
            id="code"
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
            inputMode="numeric"
            autoComplete="one-time-code"
            placeholder="123456"
          />
          <div style={{ marginTop: 12 }}>
            <button onClick={() => void confirm()} disabled={busy || code.length !== 6}>
              {busy ? "Checking…" : "Turn it on"}
            </button>
            {/* A disabled control has to say what would enable it — otherwise
                it is indistinguishable from a broken app, which is exactly how
                the greyed-out pricebook button read on day one. */}
            {!busy && code.length !== 6 && (
              <span className="muted" style={{ marginLeft: 10, fontSize: "0.9rem" }}>
                {code.length === 0
                  ? "Enter the 6-digit code from your app"
                  : `${6 - code.length} more digit${6 - code.length === 1 ? "" : "s"}`}
              </span>
            )}
          </div>
        </div>
      )}
      {error && <p className="error">{error}</p>}
    </AppShell>
  );
}
