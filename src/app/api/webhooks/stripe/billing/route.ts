import { NextResponse, type NextRequest } from "next/server";
import { applyBillingEvent, verifyStripeSignature } from "@/modules/billing";
import { route } from "@/lib/http/route";
import { errorResponse } from "@/lib/http/errors";

export const dynamic = "force-dynamic";

// Subscription lifecycle from Stripe. FAILS CLOSED without the secret;
// signature verified over the RAW body (constant-time, 5-minute window);
// the tenant is resolved from OUR subscriptions row by stripe_customer_id,
// never from anything the payload claims; replays are no-ops.
export const POST = route(async (req: NextRequest) => {
  if (!process.env.STRIPE_WEBHOOK_SECRET) {
    return errorResponse(503, "webhook_not_configured");
  }
  const raw = await req.text();
  if (!verifyStripeSignature(raw, req.headers.get("stripe-signature"))) {
    return errorResponse(401, "bad_signature");
  }
  return NextResponse.json(await applyBillingEvent(JSON.parse(raw)));
});
