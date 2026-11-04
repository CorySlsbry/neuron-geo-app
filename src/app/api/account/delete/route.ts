import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { requireScope } from "@/modules/auth-tenancy";
import { deleteEverything, deletionPreview } from "@/modules/account";
import { cancelSubscriptionNow, stripeRefFor } from "@/modules/billing";
import { logout } from "@/modules/auth-tenancy";
import { route } from "@/lib/http/route";
import { errorResponse } from "@/lib/http/errors";

export const dynamic = "force-dynamic";

const Body = z.object({ confirmName: z.string().min(1).max(200) });

// What deletion would destroy — shown before the typed confirmation.
export const GET = route(async () => {
  const scope = await requireScope({ roles: ["owner"], aal2: true });
  return NextResponse.json(await deletionPreview(scope));
});

// The real thing: owner only, exact business name typed, subscription
// canceled first, then everything goes. Irreversible by design and said so.
export const POST = route(async (req: NextRequest) => {
  const scope = await requireScope({ roles: ["owner"], aal2: true });
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return errorResponse(400, "invalid_body");
  // Read the Stripe ids while the subscriptions row still exists — the purge
  // deletes it, and we still need them to cancel afterwards.
  const stripeRef = await stripeRefFor(scope);
  // ORDER MATTERS. Cancelling Stripe first is irreversible: if the purge then
  // fails, the transaction rolls back, ALL the customer's data survives, and
  // they are simply no longer being billed — while the UI tells them "nothing
  // was removed", which would be a lie.
  //
  // So: purge first (fully committed), then cancel. A cancel that fails after
  // a successful purge leaves a subscription with no tenant behind it, which
  // the webhook and a human can both resolve — far cheaper than the inverse.
  const r = await deleteEverything(scope, parsed.data.confirmName);
  await cancelSubscriptionNow(stripeRef).catch((err: unknown) => {
    // Never fail the request here — the customer's data IS gone, which is what
    // they asked for. Log loudly so the dangling subscription gets cleaned up.
    console.error("[account-delete] purge succeeded but Stripe cancel failed", {
      tenantId: scope.tenantId,
      subscriptionId: stripeRef.subscriptionId,
      err,
    });
  });
  await logout().catch(() => undefined);
  return NextResponse.json(r);
});
