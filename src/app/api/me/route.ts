import { NextResponse } from "next/server";
import {
  myMemberships,
  requireAuth,
  requireScope,
  subscriptionStateFor,
  type SubscriptionAccess,
} from "@/modules/auth-tenancy";
import { route } from "@/lib/http/route";

export const dynamic = "force-dynamic";

/** The canonical "who am I" data route — and the go-live 401 probe target.
 *  Includes the ACTIVE tenant scope (role + department walls) so the shell
 *  can hide what this person can't open, and the tenant's paywall state so
 *  it can announce read-only honestly. Hiding is UX; the server enforces. */
export const GET = route(async () => {
  const principal = await requireAuth();
  const memberships = await myMemberships();
  let scope: { tenantId: string; role: string; departments: string[] } | null = null;
  let subscriptionState: SubscriptionAccess | null = null;
  try {
    const s = await requireScope();
    scope = { tenantId: s.tenantId, role: s.role, departments: s.departments };
    subscriptionState = await subscriptionStateFor(s);
  } catch {
    scope = null; // no active tenant yet
  }
  return NextResponse.json({
    uid: principal.uid,
    email: principal.email,
    aal: principal.aal,
    memberships,
    scope,
    subscriptionState,
  });
});
