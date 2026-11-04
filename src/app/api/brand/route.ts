import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { getBrand, requireScope, saveBrand, WRITE_ROLES } from "@/modules/auth-tenancy";
import { route } from "@/lib/http/route";
import { errorResponse } from "@/lib/http/errors";

export const dynamic = "force-dynamic";

const Body = z.object({
  name: z.string().trim().min(1).max(120),
  domain: z.string().trim().min(3).max(253),
});

/** The brand facts, for the wizard to prefill and Home to display. */
export const GET = route(async () => {
  const scope = await requireScope();
  return NextResponse.json({ brand: await getBrand(scope) });
});

/**
 * Finish (or re-edit) onboarding. Renaming the workspace and setting the
 * domain we chase citations for is a product write: paywalled, WRITE_ROLES.
 * Not aal2 — this is the first screen a new customer sees, and demanding a
 * second factor to type a domain would strand them before they ever reach
 * anything worth protecting.
 */
export const POST = route(async (req: NextRequest) => {
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return errorResponse(400, "invalid_body");
  const scope = await requireScope({ roles: WRITE_ROLES, write: true });
  const brand = await saveBrand(scope, parsed.data.name, parsed.data.domain);
  return NextResponse.json({ brand });
});
