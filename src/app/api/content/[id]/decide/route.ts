import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { requireScope, WRITE_ROLES } from "@/modules/auth-tenancy";
import { decide } from "@/modules/content";
import { route } from "@/lib/http/route";
import { errorResponse } from "@/lib/http/errors";

export const dynamic = "force-dynamic";

const Id = z.string().uuid();
const Body = z.object({ decision: z.enum(["approve", "reject"]) });

/**
 * Approve or reject one item.
 *
 * A product write, so paywalled and restricted to WRITE_ROLES — a `viewer` is
 * sold as look-don't-touch, and an approval is the most consequential thing
 * anyone does on this screen. Not aal2: that bar is reserved for money and
 * access, and putting a code prompt between a marketer and their queue would
 * mean nobody reviews anything.
 *
 * ⛔ Approving is approval to POST (Cory, 2026-08-15): the same transaction
 * queues a publish for every connected channel. The response carries `queued`
 * and a plain sentence, because the honest answer is sometimes zero (no
 * channel connected yet) and a screen that cannot say so implies a post that
 * is never coming.
 *
 * Nothing here writes `published`. Only the worker can, and only after a real
 * send reported a real destination URL.
 */
export const POST = route(
  async (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
    const { id } = await ctx.params;
    const parsedId = Id.safeParse(id);
    if (!parsedId.success) return errorResponse(400, "invalid_body");

    const parsed = Body.safeParse(await req.json().catch(() => null));
    if (!parsed.success) return errorResponse(400, "invalid_body");

    const scope = await requireScope({ roles: WRITE_ROLES, write: true });
    const outcome = await decide(scope, parsedId.data, parsed.data.decision);
    return NextResponse.json(outcome);
  },
);
