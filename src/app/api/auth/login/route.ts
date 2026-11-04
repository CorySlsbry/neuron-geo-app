import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { identityLogin } from "@/modules/auth-tenancy";
import { route } from "@/lib/http/route";
import { errorResponse } from "@/lib/http/errors";

export const dynamic = "force-dynamic";

// The ID token is a JWT, not free text. Bound generously but finitely so a
// multi-megabyte body can never reach the verifier.
const Body = z.object({ idToken: z.string().min(20).max(8192) });

/**
 * Exchange a GCP Identity Platform ID token for our own session cookie.
 *
 * The token is verified server-side (signature, issuer, audience, expiry —
 * see modules/auth-tenancy/internal/identity-platform.ts). Nothing the client
 * sends about itself is trusted: not the uid, not the email, and above all not
 * the assurance level. Failures return one opaque code, because telling a
 * caller *which* check failed tells them which knob to turn.
 */
export const POST = route(async (req: NextRequest) => {
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return errorResponse(400, "invalid_body");
  const principal = await identityLogin(parsed.data.idToken);
  // Return identity only. Memberships come from /api/me, which resolves them
  // from the directory rather than from anything the token asserted.
  return NextResponse.json({
    uid: principal.uid,
    email: principal.email,
    aal: principal.aal,
  });
});
