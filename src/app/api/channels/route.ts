import { NextResponse } from "next/server";
import { requireScope } from "@/modules/auth-tenancy";
import { listChannelCards } from "@/modules/channels";
import { route } from "@/lib/http/route";

export const dynamic = "force-dynamic";

/**
 * One card per network: what it is, whether it CAN be connected right now,
 * and this tenant's channel on it if there is one.
 *
 * A read, so no paywall and no aal2 — a tenant whose card lapsed must still
 * be able to see what they have connected, and to disconnect it. Any member
 * may look; connecting and disconnecting are the gated actions.
 */
export const GET = route(async () => {
  const scope = await requireScope();
  return NextResponse.json({ channels: await listChannelCards(scope) });
});
