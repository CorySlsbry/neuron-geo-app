import { NextResponse } from "next/server";
import { requireScope } from "@/modules/auth-tenancy";
import { streamExport } from "@/modules/account";
import { route } from "@/lib/http/route";

export const dynamic = "force-dynamic";

// Download everything. Owner/admin only — it is the whole business in one
// file. Runs under tenant RLS, so it can only ever contain this tenant.
export const GET = route(async () => {
  const scope = await requireScope({ roles: ["owner", "admin"], aal2: true });
  const stamp = new Date().toISOString().slice(0, 10);
  // STREAMED. The old path read every table into memory, built every CSV, and
  // buffered the finished archive — four copies of a customer's entire history on
  // a 1 GiB instance. The first customer with a couple of years of ledger
  // would have OOM-killed the instance on the one request that must never
  // fail, because a customer asking for their data is often a customer
  // leaving.
  return new NextResponse(streamExport(scope), {
    headers: {
      "content-type": "application/zip",
      // ⛔ The filename is customer-facing. It said `top-builder-os-export-`
      // until 2026-08-14: parent-brand residue that the strip sweep missed
      // because it lives in a header rather than in rendered copy, so no
      // amount of reading the screens would surface it. The one place it
      // shows up is the customer's own Downloads folder, which is exactly
      // where a stranger's product name is hardest to explain.
      "content-disposition": `attachment; filename="neuron-geo-export-${stamp}.zip"`,
    },
  });
});
