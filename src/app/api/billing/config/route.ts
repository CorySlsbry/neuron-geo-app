import { NextResponse } from "next/server";
import { requireScope } from "@/modules/auth-tenancy";
import { publishableKey } from "@/modules/billing";
import { route } from "@/lib/http/route";

export const dynamic = "force-dynamic";

// The publishable key is served at RUNTIME, never baked into the bundle —
// same rule as the customer-payment path (S5). It is publishable by design,
// but keeping it out of the build keeps key rotation a config change.
export const GET = route(async () => {
  await requireScope();
  return NextResponse.json({ publishableKey: publishableKey() });
});
