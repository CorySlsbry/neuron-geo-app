import { NextResponse } from "next/server";
import { requireScope } from "@/modules/auth-tenancy";
import { getSubscription, PLAN_LIST, billingEnabled } from "@/modules/billing";
import { route } from "@/lib/http/route";

export const dynamic = "force-dynamic";

// The billing screen's data. Any member may SEE the plan (it explains seat
// limits they will hit); only the owner can change it.
export const GET = route(async () => {
  const scope = await requireScope();
  return NextResponse.json({
    subscription: await getSubscription(scope),
    plans: PLAN_LIST,
    canPay: billingEnabled(),
    isOwner: scope.role === "owner",
  });
});
