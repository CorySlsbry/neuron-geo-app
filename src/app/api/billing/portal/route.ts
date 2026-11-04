import { NextResponse } from "next/server";
import { requireScope } from "@/modules/auth-tenancy";
import { billingPortalUrl } from "@/modules/billing";
import { route } from "@/lib/http/route";

export const dynamic = "force-dynamic";

// Card updates only — Stripe hosts that PCI surface. Plan changes and
// cancellation deliberately stay inside our app.
export const POST = route(async () => {
  const scope = await requireScope({ roles: ["owner"] });
  return NextResponse.json({ url: await billingPortalUrl(scope, "/billing") });
});
