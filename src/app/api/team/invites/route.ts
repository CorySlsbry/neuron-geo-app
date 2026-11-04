import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { createInvite, listInvites, requireScope } from "@/modules/auth-tenancy";
import { assertSeatAvailable } from "@/modules/billing";
import { route } from "@/lib/http/route";
import { errorResponse } from "@/lib/http/errors";

export const dynamic = "force-dynamic";

const Body = z.object({
  email: z.string().trim().toLowerCase().email().max(200),
  // Owner is never granted by link; ownership moves person-to-person.
  role: z.enum(["admin", "staff", "bookkeeper", "viewer"]),
});

/** Pending invites for the roster (owner/admin — same gate as the roster). */
export const GET = route(async () => {
  const scope = await requireScope({ roles: ["owner", "admin"] });
  return NextResponse.json({ invites: await listInvites(scope) });
});

/**
 * Create an invite → the ONE copy of the shareable link's token. Granting a
 * seat is access-shaping (aal2, like every other mutation on the team
 * surface) and a product write (paywalled). The seat wall runs HERE, at
 * creation, for the friendly can't-fit answer — and again at redemption via
 * the memberships trigger, because seats can fill between the two moments.
 */
export const POST = route(async (req: NextRequest) => {
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return errorResponse(400, "invalid_body");
  const scope = await requireScope({ roles: ["owner", "admin"], aal2: true, write: true });
  // The bookkeeper seat is free and skips the wall, same as add-member.
  if (parsed.data.role !== "bookkeeper") await assertSeatAvailable(scope);
  const { token, expiresAt } = await createInvite(scope, parsed.data.email, parsed.data.role);
  return NextResponse.json({ token, expiresAt }, { status: 201 });
});
