import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { requireScope, WRITE_ROLES } from "@/modules/auth-tenancy";
import { disconnectChannel } from "@/modules/channels";
import { route } from "@/lib/http/route";
import { errorResponse } from "@/lib/http/errors";

export const dynamic = "force-dynamic";

const Id = z.string().uuid();

/**
 * Disconnect a channel: destroy our copy of the token, mark the row, and ask
 * the provider to forget us.
 *
 * ⛔ NOT PAYWALLED (no `write: true`), and that is deliberate — the same rule
 * the invite-revoke route follows. Disconnecting is how a customer WITHDRAWS
 * a permission they granted, and a lapsed card must never be the reason
 * somebody cannot revoke this product's access to their brand's accounts.
 * Holding a revocation hostage to a payment is the behaviour every platform
 * policy on this list explicitly forbids.
 */
export const POST = route(
  async (_req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
    const { id } = await ctx.params;
    const parsed = Id.safeParse(id);
    if (!parsed.success) return errorResponse(400, "invalid_body");

    const scope = await requireScope({ roles: WRITE_ROLES });
    const result = await disconnectChannel(scope, parsed.data);
    return NextResponse.json({ ok: true, ...result });
  },
);
