"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import {
  confirmPasswordReset,
  fetchAuthConfig,
  IdentityClientError,
  type AuthConfig,
} from "@/lib/client/identity";

/**
 * Finish a password reset from the emailed link (?mode=resetPassword&oobCode=…).
 *
 * Today the built-in reset emails land on Google's hosted action page, which
 * does this same job unbranded — so this page mostly waits. It exists so that
 * the moment the email action URL points at the app (dedicated GCP project at
 * GA — see docs/NEEDS-CORY.md), the branded flow already works, oobCode and
 * all. Opened without a code, it explains itself instead of erroring.
 */
export default function ResetPasswordPage() {
  const [cfg, setCfg] = useState<AuthConfig | null>(null);
  const [oobCode, setOobCode] = useState<string | null>(null);
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    // window.location, not useSearchParams: this page renders one static form
    // and must not buy a Suspense boundary for one query parameter.
    const params = new URLSearchParams(window.location.search);
    if (params.get("mode") === null || params.get("mode") === "resetPassword") {
      setOobCode(params.get("oobCode"));
    }
    fetchAuthConfig()
      .then(setCfg)
      .catch(() => setCfg(null));
  }, []);

  async function submit() {
    if (!cfg?.apiKey || !oobCode) return;
    setBusy(true);
    setError("");
    try {
      await confirmPasswordReset(cfg.apiKey, oobCode, password);
      setDone(true);
    } catch (e) {
      setError(
        e instanceof IdentityClientError
          ? e.message
          : "Couldn't set the new password. Try again.",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="shell">
      <h1>Neuron SEO</h1>

      {done ? (
        <div className="card">
          <h2>Password changed</h2>
          <p className="muted">
            Your new password is live everywhere, effective now.
          </p>
          <div style={{ marginTop: 12 }}>
            <Link href="/login">
              <button type="button">Sign in</button>
            </Link>
          </div>
        </div>
      ) : oobCode ? (
        <div className="card">
          <h2>Set a new password</h2>
          <label htmlFor="np">New password</label>
          <input
            id="np"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="new-password"
            aria-describedby="np-hint"
            onKeyDown={(e) => e.key === "Enter" && password.length >= 6 && void submit()}
          />
          <p id="np-hint" className="muted" style={{ margin: "6px 0 0" }}>
            Six characters at minimum. Longer is stronger.
          </p>
          <div style={{ marginTop: 12 }}>
            <button onClick={() => void submit()} disabled={busy || password.length < 6 || !cfg}>
              {busy ? "Saving…" : "Save new password"}
            </button>
          </div>
        </div>
      ) : (
        <div className="card">
          <h2>Reset your password</h2>
          <p className="muted">
            This page finishes a reset started from an emailed link. To get
            one, use &quot;Forgot password?&quot; on the sign-in page.
          </p>
          <div style={{ marginTop: 12 }}>
            <Link href="/login">
              <button type="button">Go to sign in</button>
            </Link>
          </div>
        </div>
      )}

      {error && <p className="error" role="alert">{error}</p>}
    </main>
  );
}
