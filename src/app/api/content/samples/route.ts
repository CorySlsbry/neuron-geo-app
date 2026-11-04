import { NextResponse } from "next/server";
import { requireScope, WRITE_ROLES } from "@/modules/auth-tenancy";
import { seedSamples } from "@/modules/content";
import { route } from "@/lib/http/route";

export const dynamic = "force-dynamic";

/**
 * Put three clearly-labelled sample items into the queue, once.
 *
 * ⛔ AN EXPLICIT ACTION THE CUSTOMER TAKES, never something signup does on
 * their behalf. Rows that show up in a workspace nobody asked for are
 * indistinguishable from a product inventing work it did not do, and Home's
 * counts read from these same rows. The customer presses the button on an
 * empty Review screen; every row it writes carries `is_sample` and says
 * "Sample" in its own title.
 */
export const POST = route(async () => {
  const scope = await requireScope({ roles: WRITE_ROLES, write: true });
  const inserted = await seedSamples(scope);
  return NextResponse.json({ inserted }, { status: inserted > 0 ? 201 : 200 });
});
