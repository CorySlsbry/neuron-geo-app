import type { Metadata } from "next";
import Link from "next/link";
import { env } from "@/env";

/**
 * The PUBLIC data-deletion instructions.
 *
 * ⛔ THIS URL IS SUBMITTED TO PLATFORMS AND MUST STAY WHERE IT IS. Meta's App
 * Review requires either a deletion callback or an instructions URL; Google
 * and TikTok both expect a reviewer to be able to find the deletion path
 * unaided. Moving or renaming `/data-deletion` breaks a link held by a third
 * party who will not tell us it broke, and the first sign will be a rejected
 * app review.
 *
 * It is deliberately OUTSIDE the app shell and behind no authentication. A
 * reviewer will open it in a clean browser with no account, and a login wall
 * on the deletion instructions is itself a review failure. It also has to be
 * true for someone who has already lost access to their account, which is
 * exactly when a person most wants their data gone.
 *
 * A server component with no fetch: it renders identically for everyone and
 * has nothing to load.
 */

export const metadata: Metadata = {
  title: "Delete your data",
  description:
    "How to delete your Neuron SEO account and everything in it, and how to disconnect a social account.",
};

export default function DataDeletionPage() {
  const supportEmail = env().SUPPORT_EMAIL;

  return (
    <main className="shell" style={{ maxWidth: 720, margin: "0 auto", padding: "32px 16px" }}>
      <h1>Delete your data</h1>
      <p className="muted">
        This page explains what we store, how to delete it yourself, and how to
        ask us to delete it if you can&apos;t sign in.
      </p>

      <section className="card">
        <h2 style={{ marginTop: 0 }}>What we store</h2>
        <ul style={{ margin: 0, paddingLeft: 20 }}>
          <li>Your account: email address and sign-in security settings.</li>
          <li>Your workspace: brand name, website, team members and their access.</li>
          <li>
            Connected accounts: which social accounts you connected, the handle
            they use, and an encrypted access token so we can publish the
            content you approve.
          </li>
          <li>Content: drafts, and whether you approved or rejected each one.</li>
          <li>Billing records, where you have a paid subscription.</li>
        </ul>
        <p className="muted" style={{ marginBottom: 0 }}>
          We never store your password for any connected network. Signing in
          happens on that network&apos;s own page.
        </p>
      </section>

      <section className="card">
        <h2 style={{ marginTop: 0 }}>Disconnect one account, keep the rest</h2>
        <p>
          If you only want to withdraw access to a single social account, open{" "}
          <Link href="/channels">Channels</Link> and press Disconnect on that
          account. We delete our copy of its access token straight away and ask
          the network to revoke it. Your content and workspace stay as they are.
        </p>
      </section>

      <section className="card">
        <h2 style={{ marginTop: 0 }}>Delete everything yourself</h2>
        <ol style={{ paddingLeft: 20 }}>
          <li>Sign in and open Settings.</li>
          <li>
            Under &quot;Your data&quot;, choose Download my data first if you
            want a copy. It arrives as a ZIP with one file per table.
          </li>
          <li>Choose Delete my account.</li>
          <li>
            Type your business name to confirm. This is deliberate friction: the
            deletion cannot be undone.
          </li>
        </ol>
        <p>
          Deleting removes the workspace and everything in it: connected
          accounts and their tokens, all content, your team&apos;s access, and
          the workspace record itself. It runs as a single operation, so it
          either completes fully or changes nothing. Any active subscription is
          canceled first.
        </p>
        <p className="muted" style={{ marginBottom: 0 }}>
          Only the account owner can delete a workspace.
        </p>
      </section>

      <section className="card">
        <h2 style={{ marginTop: 0 }}>If you can&apos;t sign in</h2>
        <p>
          Email <a href={`mailto:${supportEmail}`}>{supportEmail}</a> from the
          address you signed up with, and ask us to delete your account. Tell us
          your business name so we can find the right workspace.
        </p>
        <p style={{ marginBottom: 0 }}>
          We will confirm within 5 working days and complete the deletion within
          30 days. If any of it is held in a backup, that copy expires on our
          normal backup schedule and is not restored into the live system.
        </p>
      </section>

      <p className="muted">
        <Link href="/dashboard">Back to the app</Link>
      </p>
    </main>
  );
}
