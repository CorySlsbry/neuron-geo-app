"use client";
import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { api, ApiError } from "@/lib/client/api";
import {
  establishSession,
  fetchAuthConfig,
  finishMfaSignIn,
  sendPasswordReset,
  sendVerificationEmail,
  signIn as identitySignIn,
  signUp as identitySignUp,
  IdentityClientError,
  type AuthConfig,
  type MfaRequired,
} from "@/lib/client/identity";

interface Me {
  memberships: { tenantId: string; tenantName: string }[];
}

/**
 * The login screen is a small stage machine. Every stage is one honest
 * question; nothing renders that the current auth mode can't actually do.
 *
 *   credentials → mfa → (company) → dashboard      the returning user
 *   signup → verify → credentials → …              the new user
 *   forgot → forgot-sent → credentials             the locked-out user
 */
type Stage =
  | "credentials"
  | "mfa"
  | "company"
  | "signup"
  | "verify"
  | "forgot"
  | "forgot-sent";

export default function LoginPage() {
  const router = useRouter();
  const [cfg, setCfg] = useState<AuthConfig | null>(null);
  const [stage, setStage] = useState<Stage>("credentials");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [pending, setPending] = useState<MfaRequired | null>(null);
  const [company, setCompany] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [note, setNote] = useState("");
  /** Unverified account's token — held only to power "resend the email". */
  const [unverifiedToken, setUnverifiedToken] = useState<string | null>(null);
  /** Invite token from ?invite=… — redeemed right after a session exists. */
  const [inviteToken, setInviteToken] = useState<string | null>(null);

  useEffect(() => {
    fetchAuthConfig()
      .then(setCfg)
      .catch(() => setCfg({ mode: "dev", configured: false, apiKey: null, authDomain: null }));
    const params = new URLSearchParams(window.location.search);
    // Arriving back from the emailed verification link: say so.
    if (params.get("verified") === "1") {
      setNote("Email verified. Sign in below and you're in.");
    }
    const invite = params.get("invite");
    if (invite) {
      setInviteToken(invite);
      setNote("You've been invited to join a team. Sign in, or create an account, to accept.");
    }
  }, []);

  /** Shared tail: a session exists — redeem an invite, or go to the
   *  workspace, or name a new one. In that order: an invited person joins
   *  the team that asked for them instead of founding a company of one. */
  const afterSession = useCallback(async () => {
    if (inviteToken) {
      try {
        // The accept route re-points the session at the joined tenant.
        await api("/api/invites/accept", { method: "POST", json: { token: inviteToken } });
        router.push("/dashboard");
        return;
      } catch (e) {
        const code = e instanceof ApiError ? e.code : "";
        setInviteToken(null);
        setError(
          code === "seat_limit_reached"
            ? "That team is out of seats. Tell whoever invited you, then try the link again."
            : "That invite link isn't valid anymore. Ask for a fresh one.",
        );
        // Fall through: the session is real even though the invite is not.
      }
    }
    const me = await api<Me>("/api/me");
    if (me.memberships.length === 0) {
      setStage("company"); // fresh start — no sample data to delete later
      return;
    }
    await api("/api/auth/select-tenant", {
      method: "POST",
      json: { tenantId: me.memberships[0]!.tenantId },
    });
    router.push("/dashboard");
  }, [router, inviteToken]);

  async function submitCredentials() {
    if (!cfg) return;
    setBusy(true);
    setError("");
    setNote("");
    try {
      if (cfg.mode === "dev") {
        await api("/api/auth/dev-login", { method: "POST", json: { email } });
        await afterSession();
        return;
      }
      if (!cfg.configured || !cfg.apiKey) {
        setError("Sign-in isn't switched on yet. Give us a call and we'll get you in.");
        return;
      }
      const result = await identitySignIn(cfg.apiKey, email.trim(), password);
      if (result.kind === "mfa_required") {
        setPending(result);
        setStage("mfa");
        return;
      }
      await establishSession(result.idToken);
      await afterSession();
    } catch (e) {
      if (e instanceof IdentityClientError && e.code === "EMAIL_NOT_VERIFIED") {
        // The sign-in itself succeeded at Google — hold that token so the
        // verify stage can resend the email without asking for the password
        // again, and send the user to the stage that explains the way out.
        setStage("verify");
        return;
      }
      setError(e instanceof IdentityClientError ? e.message : "Sign-in didn't work. Try again.");
    } finally {
      setBusy(false);
    }
  }

  async function submitSignup() {
    if (!cfg?.apiKey) return;
    setBusy(true);
    setError("");
    setNote("");
    try {
      const idToken = await identitySignUp(cfg.apiKey, email.trim(), password);
      setUnverifiedToken(idToken);
      await sendVerificationEmail(
        cfg.apiKey,
        idToken,
        `${window.location.origin}/login?verified=1`,
      );
      setStage("verify");
    } catch (e) {
      setError(
        e instanceof IdentityClientError ? e.message : "Couldn't create the account. Try again.",
      );
    } finally {
      setBusy(false);
    }
  }

  /** "I've clicked the link" — sign in again; the fresh token carries the
   *  verified flag, so the server will now mint the session. */
  async function continueAfterVerify() {
    if (!cfg?.apiKey) return;
    setBusy(true);
    setError("");
    try {
      const result = await identitySignIn(cfg.apiKey, email.trim(), password);
      if (result.kind === "mfa_required") {
        setPending(result);
        setStage("mfa");
        return;
      }
      await establishSession(result.idToken);
      await afterSession();
    } catch (e) {
      setError(
        e instanceof IdentityClientError && e.code === "EMAIL_NOT_VERIFIED"
          ? "Not verified yet. Click the link in the email first, then try again."
          : e instanceof IdentityClientError
            ? e.message
            : "Sign-in didn't work. Try again.",
      );
    } finally {
      setBusy(false);
    }
  }

  async function resendVerification() {
    if (!cfg?.apiKey) return;
    setBusy(true);
    setError("");
    setNote("");
    try {
      let token = unverifiedToken;
      if (!token) {
        // Arrived here from a failed sign-in without a held token (e.g. after
        // a reload). The password is still in the form — mint a fresh one.
        const result = await identitySignIn(cfg.apiKey, email.trim(), password);
        if (result.kind !== "signed_in") throw new IdentityClientError("NO_TOKEN", "Sign in again first.");
        token = result.idToken;
        setUnverifiedToken(token);
      }
      await sendVerificationEmail(cfg.apiKey, token, `${window.location.origin}/login?verified=1`);
      setNote("Sent. Give it a minute, and check spam if it hides.");
    } catch (e) {
      setError(e instanceof IdentityClientError ? e.message : "Couldn't resend it. Try again.");
    } finally {
      setBusy(false);
    }
  }

  async function submitForgot() {
    if (!cfg?.apiKey) return;
    setBusy(true);
    setError("");
    try {
      await sendPasswordReset(cfg.apiKey, email.trim(), `${window.location.origin}/login`);
    } catch {
      // Deliberately swallowed: "does this email have an account" is not a
      // question this screen answers. The sent-state below says "if".
    } finally {
      setBusy(false);
      setStage("forgot-sent");
    }
  }

  async function submitCode() {
    if (!cfg?.apiKey || !pending) return;
    setBusy(true);
    setError("");
    try {
      const factor = pending.factors[0];
      if (!factor) throw new IdentityClientError("NO_FACTOR", "No second factor is set up.");
      const idToken = await finishMfaSignIn(
        cfg.apiKey,
        pending.pendingCredential,
        factor.enrollmentId,
        code.trim(),
      );
      await establishSession(idToken);
      await afterSession();
    } catch (e) {
      setError(e instanceof IdentityClientError ? e.message : "That code didn't work.");
    } finally {
      setBusy(false);
    }
  }

  async function createCompany() {
    setBusy(true);
    setError("");
    try {
      const slug = company
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/(^-|-$)/g, "")
        .slice(0, 30);
      await api("/api/auth/signup", { method: "POST", json: { name: company, slug } });
      router.push("/dashboard");
    } catch {
      setError("Couldn't create the company. Try a different name.");
    } finally {
      setBusy(false);
    }
  }

  const idp = cfg?.mode === "identity-platform";

  return (
    <main className="shell">
      <h1>Neuron SEO</h1>

      {stage === "credentials" && (
        <div className="card">
          <label htmlFor="email">Email</label>
          <input
            id="email"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="person1@example.com"
            autoComplete="username"
            onKeyDown={(e) => e.key === "Enter" && cfg?.mode === "dev" && void submitCredentials()}
          />
          {idp && (
            <>
              <label htmlFor="password" style={{ marginTop: 12, display: "block" }}>
                Password
              </label>
              <input
                id="password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="current-password"
                onKeyDown={(e) => e.key === "Enter" && void submitCredentials()}
              />
            </>
          )}
          <div style={{ marginTop: 12 }}>
            <button
              onClick={() => void submitCredentials()}
              disabled={busy || !email || (idp && !password)}
            >
              {busy ? "Signing in…" : "Sign in"}
            </button>
          </div>
          {idp && cfg?.configured && (
            <p className="muted" style={{ marginTop: 12, marginBottom: 0 }}>
              <button
                type="button"
                className="linklike"
                onClick={() => {
                  setStage("signup");
                  setError("");
                  setNote("");
                }}
              >
                New here? Create an account
              </button>
              {" · "}
              <button
                type="button"
                className="linklike"
                onClick={() => {
                  setStage("forgot");
                  setError("");
                  setNote("");
                }}
              >
                Forgot password?
              </button>
            </p>
          )}
          {cfg?.mode === "dev" && (
            <p className="muted" style={{ marginTop: 10 }}>
              Dev sign-in (email only). Production uses a password plus 2-step
              verification.
            </p>
          )}
        </div>
      )}

      {stage === "signup" && (
        <div className="card">
          <h2>Create your account</h2>
          <p className="muted">
            You, an email, a password. We'll send a link to prove the inbox is
            yours, then you name your company.
          </p>
          <label htmlFor="su-email">Email</label>
          <input
            id="su-email"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="person1@example.com"
            autoComplete="username"
          />
          <label htmlFor="su-password" style={{ marginTop: 12, display: "block" }}>
            Password
          </label>
          <input
            id="su-password"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="new-password"
            aria-describedby="su-password-hint"
            onKeyDown={(e) =>
              e.key === "Enter" && password.length >= 6 && void submitSignup()
            }
          />
          <p id="su-password-hint" className="muted" style={{ margin: "6px 0 0" }}>
            Six characters at minimum. Longer is stronger.
          </p>
          <div style={{ marginTop: 12 }}>
            <button
              onClick={() => void submitSignup()}
              disabled={busy || !email || password.length < 6}
            >
              {busy ? "Creating…" : "Create account"}
            </button>
          </div>
          <p className="muted" style={{ marginTop: 12, marginBottom: 0 }}>
            <button
              type="button"
              className="linklike"
              onClick={() => {
                setStage("credentials");
                setError("");
              }}
            >
              Already have an account? Sign in
            </button>
          </p>
        </div>
      )}

      {stage === "verify" && (
        <div className="card">
          <h2>Check your inbox</h2>
          <p className="muted">
            We sent a verification link to <strong>{email}</strong>. Click it,
            then come back here and continue.
          </p>
          <div style={{ marginTop: 12 }}>
            <button onClick={() => void continueAfterVerify()} disabled={busy}>
              {busy ? "Checking…" : "I've verified, continue"}
            </button>{" "}
            <button
              className="secondary"
              onClick={() => void resendVerification()}
              disabled={busy}
            >
              Resend the email
            </button>
          </div>
        </div>
      )}

      {stage === "forgot" && (
        <div className="card">
          <h2>Reset your password</h2>
          <p className="muted">
            Type your email and we'll send a link that lets you set a new one.
          </p>
          <label htmlFor="fp-email">Email</label>
          <input
            id="fp-email"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="person1@example.com"
            autoComplete="username"
            onKeyDown={(e) => e.key === "Enter" && email.trim() && void submitForgot()}
          />
          <div style={{ marginTop: 12 }}>
            <button onClick={() => void submitForgot()} disabled={busy || !email.trim()}>
              {busy ? "Sending…" : "Send reset link"}
            </button>
          </div>
          <p className="muted" style={{ marginTop: 12, marginBottom: 0 }}>
            <button
              type="button"
              className="linklike"
              onClick={() => {
                setStage("credentials");
                setError("");
              }}
            >
              Back to sign in
            </button>
          </p>
        </div>
      )}

      {stage === "forgot-sent" && (
        <div className="card">
          <h2>On its way</h2>
          <p className="muted">
            If there's an account for <strong>{email}</strong>, a reset link is
            in its inbox now. Click it, set a new password, then sign in below.
          </p>
          <div style={{ marginTop: 12 }}>
            <button
              onClick={() => {
                setStage("credentials");
                setError("");
              }}
            >
              Back to sign in
            </button>
          </div>
        </div>
      )}

      {stage === "mfa" && (
        <div className="card">
          <h2>One more step</h2>
          <p className="muted">
            Open your authenticator app and type the 6-digit code for Neuron SEO.
          </p>
          <label htmlFor="code">6-digit code</label>
          <input
            id="code"
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
            inputMode="numeric"
            autoComplete="one-time-code"
            placeholder="123456"
            onKeyDown={(e) => e.key === "Enter" && code.length === 6 && void submitCode()}
          />
          <div style={{ marginTop: 12 }}>
            <button onClick={() => void submitCode()} disabled={busy || code.length !== 6}>
              {busy ? "Checking…" : "Verify"}
            </button>
          </div>
        </div>
      )}

      {stage === "company" && (
        <div className="card">
          <h2>Welcome! Name your company</h2>
          <p className="muted">
            You start with a clean slate. No sample data to delete later.
          </p>
          <label htmlFor="company">Company name</label>
          <input
            id="company"
            value={company}
            onChange={(e) => setCompany(e.target.value)}
            placeholder="Bright Peak Coffee"
            onKeyDown={(e) => e.key === "Enter" && company.trim() && void createCompany()}
          />
          <div style={{ marginTop: 12 }}>
            <button onClick={() => void createCompany()} disabled={busy || !company.trim()}>
              {busy ? "Creating…" : "Create company"}
            </button>
          </div>
        </div>
      )}

      <div role="status" aria-live="polite">
        {note && <p className="muted">{note}</p>}
        {error && <p className="error">{error}</p>}
      </div>

      {/* ⛔ The legal footer belongs on the SIGN-IN page specifically, because
          that is the first page a platform reviewer lands on and the last one
          they can reach without an account. Every one of the five reviews checks
          that a privacy policy and terms are findable without signing up. */}
      <p className="muted" style={{ marginTop: 24, fontSize: "0.875rem" }}>
        <a href="/privacy">Privacy policy</a>
        {" · "}
        <a href="/terms">Terms of service</a>
        {" · "}
        <a href="/data-deletion">Delete your data</a>
      </p>
    </main>
  );
}
