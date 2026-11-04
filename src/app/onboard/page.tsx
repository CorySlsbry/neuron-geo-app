"use client";
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import AppShell from "@/components/AppShell";
import PageSkeleton from "@/components/Skeleton";
import { api, ApiError } from "@/lib/client/api";
import { useFirstLoad } from "@/lib/client/useFirstLoad";

/**
 * The wizard: brand, then a channel, then done. Two fields total.
 *
 * Everything a GEO product could ask on day one — competitors, keywords,
 * tone, posting cadence — is a question the customer cannot answer well
 * before seeing anything, and every one of them is a place to abandon setup.
 * Name and domain are the two facts the product genuinely cannot work
 * without, so they are the two it asks for.
 */

interface Brand {
  name: string;
  domain: string | null;
  onboardedAt: string | null;
}
interface ChannelCard {
  network: string;
  label: string;
  configured: boolean;
  channel: { status: string } | null;
}

const STEPS = ["Your brand", "Connect a channel", "Done"] as const;

export default function OnboardPage() {
  const router = useRouter();
  const [brand, setBrand] = useState<Brand | null>(null);
  const [channels, setChannels] = useState<ChannelCard[] | null>(null);
  const [name, setName] = useState("");
  const [domain, setDomain] = useState("");
  const [step, setStep] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const showSkeleton = useFirstLoad(brand !== null && channels !== null);

  const load = useCallback(async () => {
    try {
      const [b, c] = await Promise.all([
        api<{ brand: Brand }>("/api/brand"),
        api<{ channels: ChannelCard[] }>("/api/channels"),
      ]);
      setBrand(b.brand);
      setChannels(c.channels);
      setName(b.brand.name);
      setDomain(b.brand.domain ?? "");
      // Resume where they actually are, rather than restarting a wizard they
      // half-finished. A wizard that forgets is a wizard people abandon twice.
      if (b.brand.onboardedAt) {
        setStep(c.channels.some((x) => x.channel?.status === "connected") ? 2 : 1);
      }
    } catch (e) {
      if (e instanceof ApiError && (e.status === 401 || e.status === 403)) {
        router.push("/login");
      } else {
        setError("Couldn't load your workspace.");
      }
    }
  }, [router]);

  useEffect(() => {
    void load();
  }, [load]);

  async function saveBrand(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const r = await api<{ brand: Brand }>("/api/brand", {
        method: "POST",
        json: { name, domain },
      });
      setBrand(r.brand);
      setStep(1);
    } catch (err) {
      setError(
        err instanceof ApiError && err.code === "brand_domain_invalid"
          ? "That doesn't look like a domain. Try something like neuron-hq.com"
          : err instanceof ApiError
            ? err.message
            : "Couldn't save that.",
      );
    } finally {
      setBusy(false);
    }
  }

  if (showSkeleton) {
    return (
      <AppShell title="Set up">
        <PageSkeleton kind="form" label="Loading setup…" />
      </AppShell>
    );
  }

  const connected = channels?.filter((c) => c.channel?.status === "connected") ?? [];
  const anyConfigured = channels?.some((c) => c.configured) ?? false;

  return (
    <AppShell title="Set up">
      <nav aria-label="Setup progress" className="row" style={{ marginBottom: 14 }}>
        {STEPS.map((label, i) => (
          <span
            key={label}
            className="pill"
            aria-current={i === step ? "step" : undefined}
            style={
              i === step
                ? { background: "var(--brand-tint)", borderColor: "var(--brand)" }
                : i < step
                  ? { background: "var(--go-tint)" }
                  : undefined
            }
          >
            {i < step ? "✓ " : `${i + 1}. `}
            {label}
          </span>
        ))}
      </nav>

      {error && <p className="error">{error}</p>}

      {step === 0 && (
        <form className="card" style={{ maxWidth: 520 }} onSubmit={saveBrand}>
          <h2 style={{ marginTop: 0 }}>Who are we working for?</h2>
          <p className="muted">
            Two things and you&apos;re set up. You can change both later.
          </p>
          <label htmlFor="brand-name">Brand name</label>
          <input
            id="brand-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={120}
            required
            autoComplete="organization"
            placeholder="Neuron HQ"
          />
          <label htmlFor="brand-domain">Website</label>
          <input
            id="brand-domain"
            value={domain}
            onChange={(e) => setDomain(e.target.value)}
            maxLength={253}
            required
            inputMode="url"
            autoComplete="url"
            placeholder="neuron-hq.com"
          />
          <p className="muted">
            This is the site we try to get cited when someone asks an AI
            assistant about your category.
          </p>
          <button type="submit" disabled={busy}>
            {busy ? "Saving…" : "Save and continue"}
          </button>
        </form>
      )}

      {step === 1 && (
        <section className="card" style={{ maxWidth: 560 }}>
          <h2 style={{ marginTop: 0 }}>Connect a channel</h2>
          <p className="muted">
            Connect at least one account so there is somewhere to publish. You
            approve every post before it goes anywhere, and you can disconnect
            at any time.
          </p>
          {!anyConfigured && (
            <div className="banner">
              No networks are set up on this deployment yet, so there is nothing
              to connect right now. You can finish setup and come back to this.
            </div>
          )}
          <div className="row">
            <Link href="/channels">
              <button type="button">Choose a channel</button>
            </Link>
            <button type="button" className="secondary" onClick={() => setStep(2)}>
              Skip for now
            </button>
          </div>
        </section>
      )}

      {step === 2 && (
        <section className="card" style={{ maxWidth: 560 }}>
          <h2 style={{ marginTop: 0 }}>You&apos;re set up</h2>
          <p className="muted">
            {connected.length > 0
              ? `${brand?.name} is connected to ${connected.map((c) => c.label).join(", ")}.`
              : `${brand?.name} is set up. Nothing is connected yet, so nothing can be published.`}
          </p>
          <div className="row">
            <Link href="/dashboard">
              <button type="button">Go to Home</button>
            </Link>
            <Link href="/review">
              <button type="button" className="secondary">
                Open review
              </button>
            </Link>
          </div>
        </section>
      )}
    </AppShell>
  );
}
