import { NextResponse } from "next/server";
import { requireScope } from "@/modules/auth-tenancy";
import { listDecided, listQueue } from "@/modules/content";
import { route } from "@/lib/http/route";

export const dynamic = "force-dynamic";

/** The review screen in one call: what is waiting, and what was decided. */
export const GET = route(async () => {
  const scope = await requireScope();
  const [queue, decided] = await Promise.all([listQueue(scope), listDecided(scope)]);
  return NextResponse.json({ queue, decided });
});
