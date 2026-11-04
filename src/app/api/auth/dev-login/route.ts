import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { devLogin } from "@/modules/auth-tenancy";
import { route } from "@/lib/http/route";
import { errorResponse } from "@/lib/http/errors";

export const dynamic = "force-dynamic";

const Body = z.object({ email: z.string().max(320) });

export const POST = route(async (req: NextRequest) => {
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return errorResponse(400, "invalid_body");
  const principal = await devLogin(parsed.data.email);
  return NextResponse.json({ uid: principal.uid, aal: principal.aal });
});
