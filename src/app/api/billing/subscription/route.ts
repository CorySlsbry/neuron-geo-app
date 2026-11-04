import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { requireScope } from "@/modules/auth-tenancy";
import { cancelSubscription, changePlan, resumeSubscription } from "@/modules/billing";
import { route } from "@/lib/http/route";
import { errorResponse } from "@/lib/http/errors";

export const dynamic = "force-dynamic";

const Body = z.discriminatedUnion("action", [
  z.object({ action: z.literal("change-plan"), plan: z.enum(["start", "growth"]) }),
  z.object({ action: z.literal("cancel") }),
  z.object({ action: z.literal("resume") }),
]);

// Upgrade, downgrade, cancel, resume — all in-app, owner-only, no phone
// call and no retention maze.
export const POST = route(async (req: NextRequest) => {
  const scope = await requireScope({ roles: ["owner"], aal2: true });
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return errorResponse(400, "invalid_body");
  const d = parsed.data;
  if (d.action === "change-plan") return NextResponse.json(await changePlan(scope, d.plan));
  if (d.action === "cancel") return NextResponse.json(await cancelSubscription(scope));
  await resumeSubscription(scope);
  return NextResponse.json({ ok: true });
});
