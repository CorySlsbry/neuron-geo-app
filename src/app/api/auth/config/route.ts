import { NextResponse } from "next/server";
import { env } from "@/env";
import { route } from "@/lib/http/route";

export const dynamic = "force-dynamic";

/**
 * Client auth config, served at RUNTIME.
 *
 * The Identity Platform API key is not a secret — it identifies the project to
 * Google's auth endpoints and grants nothing on its own. It is still served
 * from here rather than baked in via NEXT_PUBLIC_, for the same reason as the
 * Stripe publishable key: a value baked at build time cannot be rotated
 * without a rebuild, and "which build has which key" is a question nobody
 * wants during an incident.
 *
 * `mode` lets the login page render the right form instead of guessing, so a
 * misconfigured deployment shows an honest "sign-in isn't configured" rather
 * than a form that silently cannot work.
 */
export const GET = route(async () => {
  const e = env();
  const configured = e.AUTH_MODE === "identity-platform" && Boolean(e.IDENTITY_PLATFORM_API_KEY) && Boolean(e.GCP_PROJECT_ID);
  return NextResponse.json({
    mode: e.AUTH_MODE,
    configured,
    apiKey: configured ? e.IDENTITY_PLATFORM_API_KEY : null,
    authDomain: configured ? `${e.GCP_PROJECT_ID}.firebaseapp.com` : null,
  });
});
