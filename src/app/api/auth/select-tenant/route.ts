import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { selectTenant } from "@/modules/auth-tenancy";
import { route } from "@/lib/http/route";
import { errorResponse } from "@/lib/http/errors";

export const dynamic = "force-dynamic";

const Body = z.object({ tenantId: z.string().uuid() });

export const POST = route(async (req: NextRequest) => {
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return errorResponse(400, "invalid_body");
  await selectTenant(parsed.data.tenantId);
  return NextResponse.json({ ok: true });
});
