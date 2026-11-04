import { NextResponse } from "next/server";
import { getPool } from "@/lib/db/pool";

/**
 * Readiness probe — "can this instance actually serve a request?"
 *
 * Unlike /api/healthz (liveness), this DOES touch the database, because a
 * container that cannot reach Postgres cannot serve anything useful. Keep the
 * two separate: liveness decides whether to restart the container, readiness
 * decides whether to send it traffic. Conflating them turns a database blip
 * into a restart storm.
 *
 * The query is deliberately trivial and touches no tenant data, so this
 * endpoint can stay public without leaking anything: it reveals only that a
 * database connection can be opened.
 */
export const dynamic = "force-dynamic";

export async function GET() {
  const started = Date.now();
  try {
    await getPool().query("SELECT 1");
    return NextResponse.json({
      status: "ready",
      database: "reachable",
      latencyMs: Date.now() - started,
    });
  } catch (err) {
    // The RESPONSE stays opaque — the driver's message carries the host, user
    // and database name. But swallowing it entirely leaves "503, good luck",
    // which is exactly the dead end the Stripe wrapper created. Log the code
    // and message server-side, where only we can read it.
    const e = err as { code?: string; message?: string; syscall?: string; address?: string };
    console.error("[readiness] database unreachable", {
      code: e.code,
      syscall: e.syscall,
      address: e.address,
      message: e.message,
    });
    return NextResponse.json(
      { status: "not_ready", database: "unreachable" },
      { status: 503 },
    );
  }
}
