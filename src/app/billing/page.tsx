"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import AppShell from "@/components/AppShell";
import { useRouter } from "next/navigation";
import { loadStripe, type StripeEmbeddedCheckout } from "@stripe/stripe-js";
import { api, ApiError, dollars } from "@/lib/client/api";
import PageSkeleton from "@/components/Skeleton";
import { useFirstLoad } from "@/lib/client/useFirstLoad";

interface Plan {
  key: "start" | "growth";
  name: string;
  priceCents: number;
  seatCap: number;
  blurb: string;
}
interface Sub {
  plan: "start" | "growth";
  planName: string;
  priceCents: number;
  seatCap: number;
  seatsUsed: number;
  status: string;
  cancelAtPeriodEnd: boolean;
  currentPeriodEnd: string | null;
  trialEndsAt: string | null;
  hasPaymentMethod: boolean;
  explain: string;
}

export default function BillingPage() {
  const router = useRouter();
  const [sub, setSub] = useState<Sub | null>(null);
  const [plans, setPlans] = useState<Plan[]>([]);
  const [isOwner, setIsOwner] = useState(false);
  const [canPay, setCanPay] = useState(false);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  const [error, setError] = useState("");
  const [confirmCancel, setConfirmCancel] = useState(false);
  // First load only: the latch inside useFirstLoad means act()'s
  // refetch after every save never re-arms this.
  const showSkeleton = useFirstLoad(sub !== null);
  const checkoutRef = useRef<StripeEmbeddedCheckout | null>(null);
  const mountRef = useRef<HTMLDivElement | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await api<{ subscription: Sub; plans: Plan[]; canPay: boolean; isOwner: boolean }>(
        "/api/billing",
      );
      setSub(r.subscription);
      setPlans(r.plans);
      setCanPay(r.canPay);
      setIsOwner(r.isOwner);
    } catch (e) {
      if (e instanceof ApiError && (e.status === 401 || e.status === 403)) router.push("/login");
      else setError("Couldn't load your plan.");
    }
  }, [router]);

  useEffect(() => {
    void load();
    return () => {
      checkoutRef.current?.destroy();
      checkoutRef.current = null;
    };
  }, [load]);

  /** Embedded checkout — mounted INSIDE this page, our shell, our branding. */
  async function startCheckout(plan: "start" | "growth") {
    setBusy(true);
    setError("");
    try {
      const cfg = await api<{ publishableKey: string | null }>("/api/billing/config");
      if (!cfg.publishableKey) throw new ApiError(503, "billing_not_configured");
      const { clientSecret } = await api<{ clientSecret: string }>("/api/billing/checkout", {
        method: "POST",
        json: { plan },
      });
      const stripe = await loadStripe(cfg.publishableKey);
      if (!stripe || !mountRef.current) throw new Error("stripe_unavailable");
      checkoutRef.current?.destroy();
      // Stripe.js v9 renamed initEmbeddedCheckout -> createEmbeddedCheckoutPage.
      const checkout = await stripe.createEmbeddedCheckoutPage({ clientSecret });
      checkoutRef.current = checkout;
      checkout.mount(mountRef.current);
      mountRef.current.scrollIntoView({ behavior: "smooth", block: "start" });
    } catch (e) {
      setError(
        e instanceof ApiError && e.code.includes("not_configured")
          ? "Card payment isn't switched on yet. Call or text us and we'll get you started today."
          : "Couldn't open checkout. Try again, or give us a call.",
      );
    } finally {
      setBusy(false);
    }
  }

  async function act(body: Record<string, unknown>, ok: string) {
    setBusy(true);
    setError("");
    setNote("");
    try {
      await api("/api/billing/subscription", { method: "POST", json: body });
      setNote(ok);
      setConfirmCancel(false);
      await load();
    } catch (e) {
      setError(
        e instanceof ApiError && e.code.startsWith("too_many_people_for_plan")
          ? "You have more people than the smaller plan covers. Remove someone from Team first, then switch."
          : e instanceof ApiError && e.code === "no_active_subscription"
            ? "There's no paid subscription to change yet. Pick a plan below."
            : "That didn't go through. Try again, or give us a call.",
      );
    } finally {
      setBusy(false);
    }
  }

  async function openCardPortal() {
    setBusy(true);
    try {
      const r = await api<{ url: string }>("/api/billing/portal", { method: "POST", json: {} });
      window.location.href = r.url;
    } catch {
      setError("Couldn't open the card page. Try again in a minute.");
      setBusy(false);
    }
  }

  // Shell was right, content was empty — a blank page while the subscription
  // loaded, which on a billing screen reads as "we lost your plan".
  if (!sub) {
    return (
      <AppShell title="Plan & billing">
        {showSkeleton && <PageSkeleton kind="stats" />}
        {error && <p className="error">{error}</p>}
      </AppShell>
    );
  }

  const seatsLeft = sub.seatCap - sub.seatsUsed;

  return (
    <AppShell title="Plan & billing">
      <div className="card">
        <p style={{ marginTop: 0 }}>{sub.explain}</p>
        <div className="row">
          <span className="pill">
            {sub.seatsUsed} of {sub.seatCap} people
            {seatsLeft > 0 ? ` · ${seatsLeft} spot${seatsLeft === 1 ? "" : "s"} open` : " · full"}
          </span>
          <span className="pill">{sub.status === "active" ? "Active" : sub.status === "trialing" ? "Free trial" : sub.status === "past_due" ? "Payment needed" : "Canceled"}</span>
          {sub.hasPaymentMethod && isOwner && (
            <button className="secondary" disabled={busy} onClick={() => void openCardPortal()}>
              Update card
            </button>
          )}
        </div>
      </div>

      {!isOwner && (
        <div className="card">
          <p className="muted" style={{ margin: 0 }}>
            Only the owner can change the plan. You can see it here so you know
            where your workspace stands.
          </p>
        </div>
      )}

      {isOwner && (
        <>
          <h2>Plans</h2>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))",
              gap: 12,
            }}
          >
            {plans.map((p) => {
              const current = p.key === sub.plan && sub.hasPaymentMethod;
              const tooSmall = sub.seatsUsed > p.seatCap;
              return (
                <div
                  key={p.key}
                  className="card"
                  style={{
                    margin: 0,
                    borderColor: current ? "var(--brand)" : undefined,
                    background: current ? "var(--brand-tint)" : undefined,
                  }}
                >
                  <div className="row" style={{ justifyContent: "space-between" }}>
                    <strong>{p.name}</strong>
                    {current && <span className="pill">Your plan</span>}
                  </div>
                  <p className="big" style={{ margin: "8px 0 2px" }}>
                    {dollars(p.priceCents)}
                    <span className="muted" style={{ fontSize: "0.9rem", fontWeight: 400 }}>
                      {" "}/month
                    </span>
                  </p>
                  <p className="muted" style={{ marginTop: 0 }}>
                    Up to {p.seatCap} people. {p.blurb}
                  </p>
                  <p className="muted">
                    Everything included, the whole engine on every plan. Tiers
                    buy capacity, never features. No add-ons.
                  </p>
                  {current ? (
                    <button className="secondary" disabled>
                      Current plan
                    </button>
                  ) : sub.hasPaymentMethod ? (
                    <button
                      disabled={busy || tooSmall}
                      title={tooSmall ? "You have more people than this plan covers" : ""}
                      onClick={() =>
                        void act(
                          { action: "change-plan", plan: p.key },
                          p.seatCap > sub.seatCap
                            ? `Moved to ${p.name}. You're billed the difference for the rest of this month only.`
                            : `Moved to ${p.name}. The credit for the rest of this month lands on your next invoice.`,
                        )
                      }
                    >
                      {p.seatCap > sub.seatCap ? `Upgrade to ${p.name}` : `Switch to ${p.name}`}
                    </button>
                  ) : (
                    <button disabled={busy || !canPay} onClick={() => void startCheckout(p.key)}>
                      Start {p.name}
                    </button>
                  )}
                  {tooSmall && (
                    <p className="muted" style={{ marginBottom: 0 }}>
                      Your team has {sub.seatsUsed} people, more than this plan covers.
                    </p>
                  )}
                </div>
              );
            })}
          </div>

          {/* Stripe's embedded checkout mounts here, inside our page. */}
          <div ref={mountRef} style={{ marginTop: 16 }} />

          <h2>Cancel</h2>
          <div className="card">
            {sub.cancelAtPeriodEnd ? (
              <>
                <p style={{ marginTop: 0 }}>
                  Your plan is set to end{sub.currentPeriodEnd ? ` on ${sub.currentPeriodEnd.slice(0, 10)}` : ""}. You
                  keep everything until then.
                </p>
                <button disabled={busy} onClick={() => void act({ action: "resume" }, "Welcome back. Nothing changed.")}>
                  Keep my plan
                </button>
              </>
            ) : confirmCancel ? (
              <>
                <p style={{ marginTop: 0 }}>
                  You&apos;ll keep everything through the end of the month you&apos;ve already
                  paid for, and nothing more will be charged. Your data stays downloadable
                  forever either way.
                </p>
                <div className="row">
                  <button
                    disabled={busy}
                    onClick={() =>
                      void act({ action: "cancel" }, "Canceled. You have the rest of the period, and your export always works.")
                    }
                  >
                    Yes, cancel my plan
                  </button>
                  <button className="secondary" disabled={busy} onClick={() => setConfirmCancel(false)}>
                    Never mind
                  </button>
                </div>
              </>
            ) : (
              <>
                <p className="muted" style={{ marginTop: 0 }}>
                  Month-to-month, no cancellation fee, and one click does it. No phone call,
                  no &quot;let me transfer you.&quot;
                </p>
                <button className="secondary" disabled={busy} onClick={() => setConfirmCancel(true)}>
                  Cancel my plan
                </button>
              </>
            )}
          </div>
        </>
      )}

      {note && <p className="muted">{note}</p>}
      {error && <p className="error">{error}</p>}
    </AppShell>
  );
}
