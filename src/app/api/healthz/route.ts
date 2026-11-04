import { NextResponse } from "next/server";

/**
 * Liveness probe — the one uptime monitoring should point at.
 *
 * There is also /healthz, and it works: the exact deployed image answers it 200
 * when run locally. But on the *.run.app hostname something upstream of Cloud
 * Run answers /healthz with an empty-bodied 404 — the request never reaches the
 * container and never appears in the Cloud Run request log, while a 404 for any
 * other unknown path DOES appear. Rather than depend on a path we do not
 * control the routing of, monitoring uses this one, under /api where the rest of
 * the surface already lives. (Diagnosed 2026-07-25.)
 *
 * Deliberately says nothing about the database. A liveness probe that fails
 * when Postgres blips causes Cloud Run to recycle healthy containers during the
 * exact incident you least want a restart storm in. Readiness is a separate
 * question — see /api/healthz/ready.
 */
export const dynamic = "force-dynamic";

export function GET() {
  return NextResponse.json({
    status: "ok",
    service: "neuron-geo-app",
    time: new Date().toISOString(),
  });
}
