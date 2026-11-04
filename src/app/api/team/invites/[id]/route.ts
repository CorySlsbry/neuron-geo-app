import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { requireScope, revokeInvite } from "@/modules/auth-tenancy";
import { route } from "@/lib/http/route";
import { errorResponse } from "@/lib/http/errors";

export const dynamic = "force-dynamic";

const Id = z.string().uuid();

/**
 * Revoke a pending invite. Access-shaping, so owner/admin + aal2 — but
 * deliberately NOT paywalled (no write flag): killing an outstanding invite
 * link is a SECURITY action, and a lapsed card must never stop a tenant from
 * closing a door it opened.
 */
export const DELETE = route(
  async (_req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
    const { id } = await ctx.params;
    const parsed = Id.safeParse(id);
    if (!parsed.success) return errorResponse(400, "invalid_body");
    const scope = await requireScope({ roles: ["owner", "admin"], aal2: true });
    await revokeInvite(scope, parsed.data);
    return NextResponse.json({ ok: true });
  },
);
