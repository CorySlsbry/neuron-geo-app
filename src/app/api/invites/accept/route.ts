import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { redeemInvite, requireAuth, selectTenant } from "@/modules/auth-tenancy";
import { route } from "@/lib/http/route";
import { errorResponse } from "@/lib/http/errors";

export const dynamic = "force-dynamic";

// base64url of 32 random bytes is 43 chars; bound generously but finitely.
const Body = z.object({ token: z.string().min(20).max(128) });

/**
 * Redeem an invite link. Requires a session (sign in / create the account
 * first — the login page drives that order) but NO tenant scope: joining is
 * how this user gets a scope in this tenant at all. The token is the
 * authorization; it dies on use. Rate-limited in the proxy so the token
 * space can't be probed, and 410 is one indistinguishable answer for
 * unknown, spent, and expired.
 */
export const POST = route(async (req: NextRequest) => {
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return errorResponse(400, "invalid_body");
  const { uid } = await requireAuth();
  const tenantId = await redeemInvite(uid, parsed.data.token);
  // Land the new member in the tenant they just joined (membership is
  // re-verified inside selectTenant, same as every tenant switch).
  await selectTenant(tenantId);
  return NextResponse.json({ tenantId });
});
