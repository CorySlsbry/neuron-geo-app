import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { requireScope, WRITE_ROLES } from "@/modules/auth-tenancy";
import { buildAuthorizeUrl, isNetwork } from "@/modules/channels";
import { route } from "@/lib/http/route";
import { errorResponse } from "@/lib/http/errors";

export const dynamic = "force-dynamic";

const Body = z.object({
  network: z.string().refine(isNetwork, "unknown network"),
});

/**
 * Begin a connection: park the state and hand back the provider's consent URL.
 *
 * ⛔ THIS RETURNS A URL RATHER THAN A REDIRECT, and that is a considered
 * choice. If the browser navigated straight at a server route, every refusal
 * this endpoint can produce — no subscription (402), wrong role (403), the
 * network having no client id (503) — would arrive as a JSON error envelope
 * rendered as a broken page in the top-level window, mid-demo. Returning the
 * URL lets the screen render the refusal in place and navigate only on
 * success.
 *
 * Connecting a channel is a WRITE: it is the act that grants this product the
 * ability to post as the customer's brand. So it is paywalled and role-gated
 * like any other change. It is deliberately NOT aal2-gated — that bar is for
 * changing money and access, and requiring a second factor to attach a
 * YouTube account would put a TOTP prompt in the middle of the platform
 * review video for no security gained.
 */
export const POST = route(async (req: NextRequest) => {
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return errorResponse(400, "invalid_body");

  const scope = await requireScope({ roles: WRITE_ROLES, write: true });
  const authorizeUrl = await buildAuthorizeUrl(parsed.data.network, scope.tenantId);
  return NextResponse.json({ authorizeUrl });
});
