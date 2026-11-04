import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import { headers } from "next/headers";
import { Inter } from "next/font/google";
import "./globals.css";

// Self-hosted at build time by next/font — no runtime Google request.
const inter = Inter({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-inter",
});

/**
 * Every page renders per-request. This is NOT a performance preference — it is
 * what makes the nonce CSP work at all.
 *
 * Next can only stamp a per-request nonce onto a page it renders per request.
 * A statically prerendered page has its HTML generated at BUILD time, so its
 * script tags carry no nonce — and because our CSP uses 'strict-dynamic',
 * browsers IGNORE 'self' and run only nonce-matched scripts. The result was a
 * production app where every page returned 200, looked completely correct, and
 * was dead HTML: React never hydrated, no button worked, no form submitted.
 * A status-code check cannot see that; only asking the DOM whether React
 * attached can. (Found live 2026-07-26, in the parent codebase.)
 *
 * Static rendering was never right here anyway: every page is behind auth and
 * shows one tenant's data.
 */
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Neuron SEO",
  description: "Get your brand cited where buyers actually ask.",
  manifest: "/manifest.webmanifest",
  appleWebApp: {
    capable: true,
    statusBarStyle: "default",
    title: "Neuron SEO",
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: "#5450d4",
};

/**
 * Apply the persisted theme BEFORE first paint, or a dark-theme user gets a
 * white flash on every navigation. Mirrors useTheme's contract exactly:
 * "light"/"dark" in localStorage stamps data-theme; anything else means
 * system, which is the ABSENCE of the attribute (the CSS media query decides).
 * Inline and synchronous on purpose — and nonce'd, because the CSP's
 * 'strict-dynamic' means an un-nonced inline script simply does not run.
 */
const THEME_BOOT = `try{var t=localStorage.getItem("geo-theme");if(t==="light"||t==="dark")document.documentElement.setAttribute("data-theme",t)}catch(e){}`;

export default async function RootLayout({ children }: { children: ReactNode }) {
  const nonce = (await headers()).get("x-nonce") ?? undefined;
  return (
    // suppressHydrationWarning on <html>: the boot script stamps data-theme
    // BEFORE React hydrates, so the attribute legitimately differs from the
    // server HTML. Same on the script tag: browsers hide a nonce from the DOM
    // (nonce="" client-side), which React would otherwise report as a
    // mismatch on every load.
    <html lang="en" className={inter.variable} suppressHydrationWarning>
      <head>
        <script
          nonce={nonce}
          suppressHydrationWarning
          dangerouslySetInnerHTML={{ __html: THEME_BOOT }}
        />
      </head>
      <body>{children}</body>
    </html>
  );
}
