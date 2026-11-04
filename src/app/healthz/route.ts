import { NextResponse } from "next/server";

// Liveness probe for Cloud Run. Never cached.
export const dynamic = "force-dynamic";

export function GET() {
  return NextResponse.json({
    status: "ok",
    service: "neuron-geo-app",
    time: new Date().toISOString(),
  });
}
