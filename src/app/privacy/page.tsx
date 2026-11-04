import type { Metadata } from "next";
import Link from "next/link";
import { env } from "@/env";
import { NETWORK_PERMISSIONS, POLICY_EFFECTIVE } from "@/lib/legal-facts";

/**
 * The PUBLIC privacy policy.
 *
 * ⛔ THIS URL IS SUBMITTED TO EVERY PLATFORM AND MUST STAY WHERE IT IS. All five
 * networks (Meta for Facebook and Instagram, Google for YouTube, TikTok and
 * LinkedIn) require a reachable privacy policy URL on the app record before
 * review, and a reviewer opens it in a clean browser with no account. Same
 * contract as `/data-deletion`: outside the app shell, behind no authentication,
 * no fetch. A login wall here is a review failure on its own.
 *
 * ⛔ The per-network permission table is NOT prose. It is rendered from
 * `NETWORK_PERMISSIONS` in `../legal-facts`, which is derived from the same
 * scope list the OAuth code actually requests. A privacy policy that claims a
 * different permission set than the app asks for is a rejection, and worse, it
 * is the kind that drifts silently months after someone edits `networks.ts`.
 * There is a test asserting the two agree. Do not hand-type scopes here.
 */

export const metadata: Metadata = {
  title: "Privacy policy",
  description:
    "What Neuron SEO collects, why we ask each social network for permission, who we share data with, and how to delete it.",
};

export default function PrivacyPage() {
  const supportEmail = env().SUPPORT_EMAIL;

  return (
    <main className="shell" style={{ maxWidth: 720, margin: "0 auto", padding: "32px 16px" }}>
      <h1>Privacy policy</h1>
      <p className="muted">
        Effective {POLICY_EFFECTIVE}. This policy covers Neuron SEO, the app you
        sign in to. It is written to be read, not to be survived.
      </p>

      <section className="card">
        <h2 style={{ marginTop: 0 }}>The short version</h2>
        <ul style={{ margin: 0, paddingLeft: 20 }}>
          <li>We collect what the product needs to work, and nothing to sell.</li>
          <li>We do not sell or rent your data, and we do not use it for advertising.</li>
          <li>
            We never see or store your password for any social network. You sign
            in on that network&apos;s own page.
          </li>
          <li>
            We only publish content you approved. Nothing is posted automatically
            on your behalf without an approval.
          </li>
          <li>
            You can export everything or delete everything yourself, at any time.
          </li>
        </ul>
      </section>

      <section className="card">
        <h2 style={{ marginTop: 0 }}>What we collect</h2>
        <ul style={{ margin: 0, paddingLeft: 20 }}>
          <li>
            <b>Your account.</b> Email address and sign-in security settings,
            including whether two-factor authentication is on.
          </li>
          <li>
            <b>Your workspace.</b> Brand name, website, and the team members you
            invite along with their access level.
          </li>
          <li>
            <b>Connected accounts.</b> Which social accounts you connected, the
            account id and handle that network reports, and an access token,
            encrypted at rest, so we can publish what you approve.
          </li>
          <li>
            <b>Content.</b> Drafts prepared for you, and whether you approved or
            rejected each one. Where a post was published, we store the link the
            network returned.
          </li>
          <li>
            <b>Billing.</b> Subscription status and plan. Card details are handled
            by Stripe and never reach our servers.
          </li>
          <li>
            <b>Operational logs.</b> Records of jobs run and errors, so we can
            tell you why something failed. Access tokens are never written to
            logs.
          </li>
        </ul>
      </section>

      <section className="card">
        <h2 style={{ marginTop: 0 }}>Why we ask each network for permission</h2>
        <p>
          When you connect an account, that network asks you to grant specific
          permissions. This is the full list we request and the reason for each.
          We ask for nothing beyond what is listed here.
        </p>
        {NETWORK_PERMISSIONS.map((n) => (
          <div key={n.network} style={{ marginBottom: 16 }}>
            <h3 style={{ marginBottom: 4 }}>{n.label}</h3>
            <ul style={{ margin: 0, paddingLeft: 20 }}>
              {n.scopes.map((s) => (
                <li key={s.scope}>
                  <code>{s.scope}</code>
                  {": "}
                  {s.why}
                </li>
              ))}
            </ul>
          </div>
        ))}
        <p className="muted" style={{ marginBottom: 0 }}>
          We do not read your private messages, we do not post without your
          approval, and we do not use the data these permissions give us to build
          advertising profiles or to train models.
        </p>
      </section>

      <section className="card">
        <h2 style={{ marginTop: 0 }}>Google user data</h2>
        <p>
          Where you connect YouTube, our use of information received from Google
          APIs follows the{" "}
          <a
            href="https://developers.google.com/terms/api-services-user-data-policy"
            rel="noopener noreferrer"
            target="_blank"
          >
            Google API Services User Data Policy
          </a>
          , including its Limited Use requirements. We use YouTube data only to
          show you which channel is connected and to upload the videos you
          approve. We do not transfer it to anyone else except as needed to
          provide that feature, and we do not use it for advertising or to train
          generalized models.
        </p>
        <p style={{ marginBottom: 0 }}>
          You can revoke our access at any time from{" "}
          <a
            href="https://myaccount.google.com/permissions"
            rel="noopener noreferrer"
            target="_blank"
          >
            your Google account permissions page
          </a>
          , as well as from Channels inside the app.
        </p>
      </section>

      <section className="card">
        <h2 style={{ marginTop: 0 }}>Who else processes your data</h2>
        <ul style={{ margin: 0, paddingLeft: 20 }}>
          <li>
            <b>Google Cloud.</b> Hosting, our database, and Identity Platform,
            which handles sign-in and two-factor authentication.
          </li>
          <li>
            <b>Stripe.</b> Payments and subscription billing. Stripe receives
            your email and payment details directly; we receive back only the
            subscription status.
          </li>
          <li>
            <b>The social networks you connect.</b> Content you approve is sent to
            the network you chose, and is then governed by that network&apos;s own
            terms and privacy policy.
          </li>
        </ul>
        <p className="muted" style={{ marginBottom: 0 }}>
          We do not share your data with anyone else, and we do not sell it.
        </p>
      </section>

      <section className="card">
        <h2 style={{ marginTop: 0 }}>How we protect it</h2>
        <ul style={{ margin: 0, paddingLeft: 20 }}>
          <li>
            Access tokens for connected accounts are encrypted before they are
            stored, and are never returned to the browser or written to logs.
          </li>
          <li>
            Each workspace&apos;s data is isolated at the database level, so one
            customer&apos;s query cannot reach another customer&apos;s rows.
          </li>
          <li>Traffic is encrypted in transit.</li>
          <li>Two-factor authentication is available on every account.</li>
        </ul>
      </section>

      <section className="card">
        <h2 style={{ marginTop: 0 }}>How long we keep it</h2>
        <p>
          We keep your workspace data while your account is open. When you
          disconnect a social account we delete our copy of its token straight
          away and ask the network to revoke it. When you delete your account we
          remove the workspace and everything in it.
        </p>
        <p style={{ marginBottom: 0 }}>
          Billing records are kept where we are required to keep them for tax and
          accounting purposes. Backups expire on their normal schedule and are
          never restored into the live system to bring deleted data back.
        </p>
      </section>

      <section className="card">
        <h2 style={{ marginTop: 0 }}>Your choices</h2>
        <ul style={{ margin: 0, paddingLeft: 20 }}>
          <li>
            <b>Export.</b> Download everything we hold, from Settings. It arrives
            as a ZIP with one file per table.
          </li>
          <li>
            <b>Delete.</b> Delete your account and everything in it, from
            Settings. See <Link href="/data-deletion">how to delete your data</Link>,
            including what to do if you cannot sign in.
          </li>
          <li>
            <b>Disconnect.</b> Withdraw access to a single network from Channels,
            keeping the rest of your workspace.
          </li>
        </ul>
        <p className="muted" style={{ marginBottom: 0 }}>
          If you are in a region with a statutory right of access, correction,
          portability or erasure, these are the same rights and the same buttons.
          Email us if you would rather we did it for you.
        </p>
      </section>

      <section className="card">
        <h2 style={{ marginTop: 0 }}>Children</h2>
        <p style={{ marginBottom: 0 }}>
          Neuron SEO is a business tool and is not directed at children. We do not
          knowingly collect data from anyone under 16. If you believe a child has
          given us data, email us and we will delete it.
        </p>
      </section>

      <section className="card">
        <h2 style={{ marginTop: 0 }}>Changes, and how to reach us</h2>
        <p>
          If we change this policy in a way that materially affects you, we will
          tell you in the app before it takes effect.
        </p>
        <p style={{ marginBottom: 0 }}>
          Questions, or a request about your data:{" "}
          <a href={`mailto:${supportEmail}`}>{supportEmail}</a>.
        </p>
      </section>

      <p className="muted">
        <Link href="/terms">Terms of service</Link>
        {" · "}
        <Link href="/data-deletion">Delete your data</Link>
      </p>
    </main>
  );
}
