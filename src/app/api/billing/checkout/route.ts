import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { requireScope } from "@/modules/auth-tenancy";
import { startCheckout } from "@/modules/billing";
import { route } from "@/lib/http/route";
import { errorResponse } from "@/lib/http/errors";

export const dynamic = "force-dynamic";

const Body = z.object({ plan: z.enum(["start", "growth"]) });

// Starting a subscription is the owner's call — it commits the business to
// a recurring charge.
export const POST = route(async (req: NextRequest) => {
  const scope = await requireScope({ roles: ["owner"] });
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return errorResponse(400, "invalid_body");
  return NextResponse.json(await startCheckout(scope, parsed.data.plan, "/billing"), {
    status: 201,
  });
});
