import { NextResponse } from "next/server";
import { logout } from "@/modules/auth-tenancy";
import { route } from "@/lib/http/route";

export const dynamic = "force-dynamic";

export const POST = route(async () => {
  await logout();
  return NextResponse.json({ ok: true });
});
