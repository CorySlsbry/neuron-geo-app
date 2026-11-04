"use client";
import { useEffect, useState, type ReactNode } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { STEP_UP_EVENT } from "@/lib/client/api";
import { useTheme, type ThemePref } from "@/lib/client/useTheme";

// The one shell every signed-in page lives in: Neuron SEO placeholder
// brand (final product name is Cory's call), grouped sidebar, topbar with
// the workspace + person, slide-over nav under 900px. Nav items are HIDDEN
// when the signed-in person lacks a wall or role — hiding is courtesy, the
// server is the enforcement.

interface Me {
  uid: string;
  email?: string;
  scope: { tenantId: string; role: string; departments: string[] } | null;
  memberships: { tenantId: string; tenantName: string }[];
  subscriptionState: {
    state: "full" | "read_only";
    reason: string;
    until: string | null;
  } | null;
}

/**
 * The paywall banner's sentences, keyed by the server's machine reason. The
 * server ENFORCES (writes 402 without a subscription in good standing);
 * this is the honest sign on the door, shown app-wide so no page has to
 * special-case it. Unknown reasons fall back to the generic line rather
 * than rendering nothing — a silent read-only state is the one failure this
 * banner exists to prevent.
 */
const PAYWALL_WORDS: Record<string, string> = {
  trial_expired:
    "Your free trial has ended. Everything you made is safe, and read-only for now.",
  past_due_lapsed:
    "The last payment didn't go through, so your workspace is read-only. Nothing has been deleted.",
  canceled:
    "This subscription is canceled. Your data stays yours, read-only, and you can download it any time.",
};
const PAYWALL_FALLBACK =
  "Your workspace is read-only right now. Head to Billing to bring it back.";

interface NavItem {
  href: string;
  label: string;
  ico: string;
  /** Wall needed to see it (owner/admin hold all walls implicitly). */
  wall?: "financials" | "hr";
  adminOnly?: boolean;
}

const GROUPS: { title: string; items: NavItem[] }[] = [
  {
    title: "WORK",
    items: [
      { href: "/dashboard", label: "Home", ico: "🧭" },
      { href: "/review", label: "Review", ico: "✅" },
      { href: "/channels", label: "Channels", ico: "🔗" },
    ],
  },
  {
    title: "SYSTEM",
    items: [
      { href: "/settings", label: "Settings", ico: "⚙" },
      { href: "/team", label: "Team & access", ico: "🔐", adminOnly: true },
      { href: "/security", label: "Sign-in security", ico: "🔒" },
      { href: "/billing", label: "Plan & billing", ico: "💳" },
      { href: "/account", label: "Your data", ico: "🗄" },
    ],
  },
];

/** system → light → dark → system. One button, three honest states. */
const THEME_CYCLE: Record<ThemePref, ThemePref> = {
  system: "light",
  light: "dark",
  dark: "system",
};
const THEME_LABEL: Record<ThemePref, string> = {
  system: "◑ Auto",
  light: "☀︎ Light",
  dark: "☾ Dark",
};

export default function AppShell({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  const pathname = usePathname();
  const router = useRouter();
  const { pref: themePref, setPref: setThemePref } = useTheme();
  const [me, setMe] = useState<Me | null>(null);
  const [open, setOpen] = useState(false);

  // ── collapsible nav groups (the ServiceTitan rail pattern, Cory 2026-08-13)
  // Deterministic first paint: only the group holding the CURRENT page is
  // open, so server and client render identically (no hydration flash).
  // The user's own opens/closes then load from localStorage in an effect and
  // win from that point on. The active page's group is always forced open on
  // navigation — a nav that hides where you ARE is worse than a long one.
  const groupHasCurrent = (g: (typeof GROUPS)[number]) =>
    g.items.some((i) => pathname === i.href || pathname.startsWith(`${i.href}/`));
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  useEffect(() => {
    try {
      const stored = JSON.parse(localStorage.getItem("tbos-nav-groups") ?? "{}");
      setExpanded((prev) => ({ ...stored, ...prev }));
    } catch { /* a corrupt pref never breaks the nav */ }
  }, []);
  useEffect(() => {
    // arriving on a page inside a collapsed group re-opens that group
    const g = GROUPS.find(groupHasCurrent);
    if (g) setExpanded((prev) => (prev[g.title] === false ? { ...prev, [g.title]: true } : prev));
    // (deliberately depends on pathname only — groupHasCurrent is stable per render)
  }, [pathname]);
  const toggleGroup = (title: string, isOpen: boolean) => {
    setExpanded((prev) => {
      const next = { ...prev, [title]: !isOpen };
      try { localStorage.setItem("tbos-nav-groups", JSON.stringify(next)); } catch { /* ignore */ }
      return next;
    });
  };
  const [needsStepUp, setNeedsStepUp] = useState(false);

  useEffect(() => {
    fetch("/api/me")
      .then((r) => (r.ok ? r.json() : null))
      .then(setMe)
      .catch(() => setMe(null));
  }, []);

  useEffect(() => setOpen(false), [pathname]);

  // A blocked step-up is about the ACCOUNT, not the page that happened to hit
  // it — so it is handled once here rather than in every page's catch block.
  useEffect(() => {
    const onStepUp = () => setNeedsStepUp(true);
    window.addEventListener(STEP_UP_EVENT, onStepUp);
    return () => window.removeEventListener(STEP_UP_EVENT, onStepUp);
  }, []);

  const role = me?.scope?.role;
  const isAdmin = role === "owner" || role === "admin";
  const walls = new Set(me?.scope?.departments ?? []);
  const canSee = (item: NavItem) => {
    if (!me?.scope) return true; // pre-load: render everything, server enforces
    if (item.adminOnly) return isAdmin;
    if (item.wall) return isAdmin || walls.has(item.wall);
    return true;
  };
  const tenantName =
    me?.memberships.find((m) => m.tenantId === me.scope?.tenantId)?.tenantName ?? "";

  async function logout() {
    await fetch("/api/auth/logout", { method: "POST" }).catch(() => {});
    router.push("/login");
  }

  return (
    <>
      {/*
        One app-wide live region. Screen readers announce whatever lands here;
        before this, a failed sign-in, a rejected code or a blocked action
        changed the screen with nothing announced at all (WCAG 2.2 AA 4.1.3).
      */}
      <div role="status" aria-live="polite" className="sr-only">
        {needsStepUp ? "This action needs 2-step verification." : ""}
      </div>
      {/*
        ⛔ THE BANNERS LIVE OUTSIDE `.app`, AND THAT IS LOAD-BEARING.
        `.app` is `display: flex` — a ROW of sidebar + content. These bars were
        written with `grid-column: 1 / -1`, which is a GRID property and does
        exactly nothing in a flex container. So instead of spanning the width,
        each bar became an ordinary flex ITEM in the row: it took ~1000px of
        horizontal space, shoved the sidebar to the right edge, and squeezed
        `.content` (flex: 1 1 0) down to ZERO WIDTH.
        The whole app rendered as an empty page with the nav stranded on the
        right — on every desktop viewport, on the PUBLIC DEMO, which is the
        first thing a stranger clicks. It survived because the bar only ever
        renders for the demo seat or an aal2 prompt, and neither had been
        opened on a wide screen. Found 2026-08-12 by screenshotting the live
        site in a real browser.
      */}
      {needsStepUp && (
        <div className="stepup" role="alert">
          <strong>2-step verification needed.</strong> That action changes money,
          access, or your account, so it asks for a code first.{" "}
          <Link href="/security">Turn it on. It takes a minute</Link>
          <button
            type="button"
            onClick={() => setNeedsStepUp(false)}
            aria-label="Dismiss"
          >
            ✕
          </button>
        </div>
      )}
      {me?.subscriptionState?.state === "read_only" && (
        <div className="paywall" role="alert">
          <span>
            {PAYWALL_WORDS[me.subscriptionState.reason] ?? PAYWALL_FALLBACK}
          </span>
          <Link href="/billing">Fix it in Billing</Link>
        </div>
      )}
      {me?.subscriptionState?.reason === "past_due_grace" && (
        <div className="stepup" role="alert">
          <span>
            The last payment didn&apos;t go through. Update your card soon to
            keep full access.
          </span>
          <Link href="/billing">Update card</Link>
        </div>
      )}
    <div className="app" data-nav={open ? "open" : "closed"}>
      <button
        className="backdrop"
        aria-label="Close menu"
        tabIndex={-1}
        onClick={() => setOpen(false)}
      />
      <aside className="sidebar" aria-label="Main navigation">
        <div className="brandmark">
          <span className="bars" aria-hidden="true">
            <span /><span /><span />
          </span>
          NEURON <span className="os">GEO</span>
        </div>
        {GROUPS.map((g) => {
          const visible = g.items.filter(canSee);
          if (visible.length === 0) return null;
          const isOpen = expanded[g.title] ?? groupHasCurrent(g);
          return (
            <nav key={g.title} aria-label={g.title}>
              <button
                type="button"
                className="navgroup navgroup-toggle"
                aria-expanded={isOpen}
                onClick={() => toggleGroup(g.title, isOpen)}
              >
                <span className="chev" aria-hidden="true">▸</span>
                {g.title}
              </button>
              {isOpen && visible.map((item) => (
                <Link
                  key={item.href}
                  href={item.href}
                  className="navitem"
                  aria-current={
                    pathname === item.href || pathname.startsWith(`${item.href}/`)
                      ? "page"
                      : undefined
                  }
                >
                  <span className="ico" aria-hidden="true">{item.ico}</span>
                  {item.label}
                </Link>
              ))}
            </nav>
          );
        })}
      </aside>
      <div className="content">
        <header className="topbar">
          <button className="menubtn" onClick={() => setOpen(true)} aria-label="Open menu">
            ☰
          </button>
          <h1>{title}</h1>
          <div className="who">
            {tenantName && <span className="pill">{tenantName}</span>}
            {me?.email && <span>{me.email}</span>}
            <button
              className="secondary"
              style={{ minHeight: 34, padding: "4px 12px" }}
              aria-label={`Theme: ${themePref}. Switch to ${THEME_CYCLE[themePref]}.`}
              title="Theme (follows your device until you pick one)"
              onClick={() => setThemePref(THEME_CYCLE[themePref])}
            >
              {THEME_LABEL[themePref]}
            </button>
            <button className="secondary" style={{ minHeight: 34, padding: "4px 12px" }} onClick={() => void logout()}>
              Sign out
            </button>
          </div>
        </header>
        <div className="pagebody">{children}</div>
      </div>
      {/* Phone thumb-bar: the kept surfaces, wall-filtered like the sidebar. */}
      <nav className="tabbar" aria-label="Quick navigation">
        {[
          { href: "/dashboard", label: "Home", ico: "🧭" },
          { href: "/review", label: "Review", ico: "✅" },
          { href: "/channels", label: "Channels", ico: "🔗" },
          { href: "/settings", label: "Settings", ico: "⚙" },
        ]
          .filter((t) => canSee(t))
          .map((t) => (
            <Link
              key={t.href}
              href={t.href}
              aria-current={pathname.startsWith(t.href) ? "page" : undefined}
            >
              <span className="tico" aria-hidden="true">{t.ico}</span>
              {t.label}
            </Link>
          ))}
        <button className="tab" onClick={() => setOpen(true)} aria-label="Full menu">
          <span className="tico" aria-hidden="true">☰</span>
          More
        </button>
      </nav>
    </div>
    </>
  );
}
