import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { signup } from "@/modules/auth-tenancy";
import { route } from "@/lib/http/route";
import { errorResponse } from "@/lib/http/errors";

export const dynamic = "force-dynamic";

// Fresh-start signup: a brand-new EMPTY tenant (no fake data, ever).
const Body = z.object({
  name: z.string().trim().min(1).max(120),
  slug: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z0-9][a-z0-9-]{1,30}$/, "lowercase letters, digits, hyphens"),
});

export const POST = route(async (req: NextRequest) => {
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return errorResponse(400, "invalid_body");
  const tenantId = await signup(parsed.data.name, parsed.data.slug);
  return NextResponse.json({ tenantId }, { status: 201 });
});
