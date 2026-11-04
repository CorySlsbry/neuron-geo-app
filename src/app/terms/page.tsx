import type { Metadata } from "next";
import Link from "next/link";
import { env } from "@/env";
import { POLICY_EFFECTIVE } from "@/lib/legal-facts";

/**
 * The PUBLIC terms of service.
 *
 * ⛔ THIS URL IS SUBMITTED TO EVERY PLATFORM AND MUST STAY WHERE IT IS. All five
 * networks require a reachable terms URL on the app record before review. Same
 * contract as `/privacy` and `/data-deletion`: outside the app shell, no
 * authentication, no fetch, readable by a stranger in a clean browser.
 *
 * Kept deliberately short and legible. These terms exist to be true and to be
 * understood, not to be comprehensive: an unreadable wall is worse for both the
 * customer and the reviewer, and this product has not earned the complexity.
 */

export const metadata: Metadata = {
  title: "Terms of service",
  description:
    "The agreement between you and Neuron SEO: what we do, what you are responsible for, and how either of us can end it.",
};

export default function TermsPage() {
  const supportEmail = env().SUPPORT_EMAIL;

  return (
    <main className="shell" style={{ maxWidth: 720, margin: "0 auto", padding: "32px 16px" }}>
      <h1>Terms of service</h1>
      <p className="muted">
        Effective {POLICY_EFFECTIVE}. These are the terms for using Neuron SEO. By
        creating an account you agree to them.
      </p>

      <section className="card">
        <h2 style={{ marginTop: 0 }}>What the service does</h2>
        <p style={{ marginBottom: 0 }}>
          Neuron SEO prepares social content for your business, shows it to you
          for approval, and publishes what you approve to the accounts you
          connected. We publish only what you approved, to the networks you
          chose.
        </p>
      </section>

      <section className="card">
        <h2 style={{ marginTop: 0 }}>Your account</h2>
        <ul style={{ margin: 0, paddingLeft: 20 }}>
          <li>
            You need to be old enough to enter a contract, and you must be
            authorised to act for the business you sign up for.
          </li>
          <li>
            Keep your sign-in details to yourself. You are responsible for what
            happens under your account. Two-factor authentication is available
            and we recommend it.
          </li>
          <li>
            You are responsible for the team members you invite and the access
            you give them.
          </li>
        </ul>
      </section>

      <section className="card">
        <h2 style={{ marginTop: 0 }}>Connected accounts, and the networks&apos; rules</h2>
        <p>
          When you connect a social account you authorise us to publish approved
          content to it on your behalf. You can withdraw that at any time from
          Channels, and you can also revoke it from the network&apos;s own
          settings.
        </p>
        <p style={{ marginBottom: 0 }}>
          Each network has its own terms and its own content policies, and they
          apply to everything published through us. If a network suspends or
          limits your account, or changes what its API allows, that can stop us
          publishing for you. We cannot override a network&apos;s decision about
          your account.
        </p>
      </section>

      <section className="card">
        <h2 style={{ marginTop: 0 }}>Your content, and who owns what</h2>
        <ul style={{ margin: 0, paddingLeft: 20 }}>
          <li>
            <b>You own your content.</b> You keep all rights to your brand,
            material, and anything published to your accounts.
          </li>
          <li>
            You grant us only the permission needed to run the service: to store,
            process and publish that content to the accounts you connected.
          </li>
          <li>
            <b>You are responsible for what you approve.</b> Drafts may be
            generated with the help of AI, so review them. Approving a draft is
            your decision to publish it, and it is the point at which you take
            responsibility for its accuracy and for the rights in it.
          </li>
          <li>We own the software itself and everything in it that is not yours.</li>
        </ul>
      </section>

      <section className="card">
        <h2 style={{ marginTop: 0 }}>What you may not do</h2>
        <ul style={{ margin: 0, paddingLeft: 20 }}>
          <li>Publish content that is unlawful, or that infringes someone else&apos;s rights.</li>
          <li>Use the service to send spam, or to run accounts you are not entitled to run.</li>
          <li>
            Break a network&apos;s terms through us, including automating
            behaviour that network forbids.
          </li>
          <li>
            Attack, probe or reverse engineer the service, or try to reach another
            customer&apos;s data.
          </li>
          <li>Resell the service without our written agreement.</li>
        </ul>
      </section>

      <section className="card">
        <h2 style={{ marginTop: 0 }}>Paid plans</h2>
        <ul style={{ margin: 0, paddingLeft: 20 }}>
          <li>
            Subscriptions are billed in advance through Stripe on the cycle shown
            at checkout, and renew automatically until you cancel.
          </li>
          <li>
            You can cancel at any time from Billing. Cancelling stops the next
            renewal; access continues to the end of the period you already paid
            for.
          </li>
          <li>
            Plans carry usage allowances. We will tell you in the app when you are
            close to one.
          </li>
          <li>
            If we change prices, we will tell you before it affects a renewal, and
            you can cancel instead.
          </li>
        </ul>
        <p className="muted" style={{ marginBottom: 0 }}>
          Taxes may be added where we are required to collect them.
        </p>
      </section>

      <section className="card">
        <h2 style={{ marginTop: 0 }}>Ending it</h2>
        <p>
          You can stop at any time: cancel the subscription from Billing, or
          delete the workspace entirely from Settings. See{" "}
          <Link href="/data-deletion">how to delete your data</Link>.
        </p>
        <p style={{ marginBottom: 0 }}>
          We may suspend or close an account that breaks these terms, that puts
          the service or another customer at risk, or where we are required to.
          Where it is reasonable to do so, we will warn you first and give you a
          chance to put it right.
        </p>
      </section>

      <section className="card">
        <h2 style={{ marginTop: 0 }}>Availability, and the honest limits</h2>
        <p>
          We work to keep the service running, but we do not promise it will be
          uninterrupted or error free. Publishing depends on other companies&apos;
          APIs, and those can fail, rate limit us, or change without notice.
        </p>
        <p style={{ marginBottom: 0 }}>
          The service is provided as is. To the extent the law allows, we are not
          liable for indirect or consequential loss, and our total liability in
          any 12 month period is limited to what you paid us in that period. None
          of this limits liability that cannot be limited by law.
        </p>
      </section>

      <section className="card">
        <h2 style={{ marginTop: 0 }}>Changes, and how to reach us</h2>
        <p>
          If we change these terms materially, we will tell you in the app before
          the change takes effect. Continuing to use the service after that means
          you accept the new terms.
        </p>
        <p style={{ marginBottom: 0 }}>
          Questions: <a href={`mailto:${supportEmail}`}>{supportEmail}</a>.
        </p>
      </section>

      <p className="muted">
        <Link href="/privacy">Privacy policy</Link>
        {" · "}
        <Link href="/data-deletion">Delete your data</Link>
      </p>
    </main>
  );
}
