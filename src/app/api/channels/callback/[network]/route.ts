import { NextResponse, type NextRequest } from "next/server";
import { env } from "@/env";
import { requireScope, WRITE_ROLES } from "@/modules/auth-tenancy";
import {
  clearPending,
  exchangeCode,
  isNetwork,
  resolveIdentity,
  saveConnection,
  takePending,
} from "@/modules/channels";
import { HttpError } from "@/lib/http/errors";

export const dynamic = "force-dynamic";

/**
 * Where the provider sends the customer back.
 *
 * ⛔ THIS ROUTE DOES NOT USE THE `route()` JSON WRAPPER, on purpose. It is
 * reached by a top-level browser navigation from someone else's domain, so
 * every outcome — including every failure — has to end as a REDIRECT to a
 * page. A JSON error envelope here would leave the customer staring at
 * `{"error":{"code":"state_mismatch"}}` in their address bar, which on a
 * platform-review recording is the frame that gets the app rejected.
 *
 * So: one exit, `/channels`, always, carrying either `connected=<network>` or
 * `error=<code>` for the screen to render as a sentence.
 */
function back(status: string, value: string): NextResponse {
  const url = new URL("/channels", env().APP_URL);
  url.searchParams.set(status, value);
  return NextResponse.redirect(url);
}

export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ network: string }> },
): Promise<NextResponse> {
  const { network } = await ctx.params;
  if (!isNetwork(network)) return back("error", "unknown_network");

  const params = req.nextUrl.searchParams;

  // The customer pressed Cancel on the consent screen. Not an error worth a
  // scary message — they changed their mind, which they are allowed to do.
  const providerError = params.get("error");
  if (providerError) {
    await clearPending();
    return back(
      "error",
      providerError === "access_denied" ? "consent_declined" : "provider_error",
    );
  }

  const code = params.get("code");
  const state = params.get("state");
  if (!code || !state) {
    await clearPending();
    return back("error", "incomplete_callback");
  }

  try {
    // The tenant comes from the SERVER-RESOLVED session, never from the
    // callback. Everything in this request's query string was routed through
    // a third party and the cookie is only used to prove the flow is the same
    // one this browser started (and, via takePending, that the workspace did
    // not change underneath it).
    const scope = await requireScope({ roles: WRITE_ROLES, write: true });
    const pending = await takePending(network, state, scope.tenantId);

    const grant = await exchangeCode(network, code, pending.v);
    const identity = await resolveIdentity(network, grant.accessToken);
    await saveConnection(scope, network, identity, grant);

    await clearPending();
    return back("connected", network);
  } catch (err) {
    await clearPending();
    if (err instanceof HttpError) return back("error", err.code);
    // Never leak an exchange failure's detail into a URL the customer can
    // see and screenshot — the server log is where it belongs.
    console.error("[channels] callback failed", err);
    return back("error", "connect_failed");
  }
}
