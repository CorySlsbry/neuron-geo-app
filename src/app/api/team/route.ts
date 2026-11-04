import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import {
  createDepartment,
  deleteDepartment,
  listTeam,
  renameDepartment,
  requireScope,
  setMemberDepartments,
  setMemberRole,
} from "@/modules/auth-tenancy";
import { checkSeat, getSubscription } from "@/modules/billing";
import { route } from "@/lib/http/route";
import { errorResponse } from "@/lib/http/errors";

export const dynamic = "force-dynamic";

/**
 * Department keys are STRINGS, not a hardcoded enum. The schema has been
 * general since 0001 (any key per tenant, many-to-many grants); the enum here
 * was the only thing stopping a company from modelling its real org chart.
 * Existence is verified server-side in setMemberDepartments — an unknown key
 * 422s rather than being silently dropped.
 */
const DeptKey = z.string().regex(/^[a-z][a-z0-9-]{1,29}$/);

const Body = z.union([
  z.object({
    action: z.literal("set-departments"),
    userId: z.string().min(1).max(200),
    departments: z.array(DeptKey).max(20),
  }),
  // ⛔ There is no "add-member" action, deliberately. It existed, it could
  // never have worked (app_user holds no INSERT grant on memberships), and no
  // UI ever posted it — see the note where addMember used to live in
  // modules/auth-tenancy/internal/team.ts. People join by invite link, which
  // is the only path that enforces the seat cap.
  z.object({
    action: z.literal("set-role"),
    userId: z.string().min(1).max(200),
    role: z.enum(["owner", "admin", "staff", "bookkeeper", "viewer"]),
  }),
  z.object({
    action: z.literal("create-department"),
    key: DeptKey,
    name: z.string().trim().min(1).max(60),
  }),
  z.object({
    action: z.literal("rename-department"),
    key: DeptKey,
    name: z.string().trim().min(1).max(60),
  }),
  z.object({
    action: z.literal("delete-department"),
    key: DeptKey,
  }),
]);

export const GET = route(async () => {
  const scope = await requireScope({ roles: ["owner", "admin"] });
  const [team, sub] = await Promise.all([listTeam(scope), getSubscription(scope)]);
  return NextResponse.json({
    ...team,
    seats: checkSeat(sub.plan, sub.seatsUsed),
    plan: { key: sub.plan, name: sub.planName, seatCap: sub.seatCap },
  });
});

export const POST = route(async (req: NextRequest) => {
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return errorResponse(400, "invalid_body");
  // Every mutation here changes WHO CAN SEE WHAT — granting a role or a
  // department wall is privilege escalation by definition, so all three take
  // a second factor. Reading the roster (GET) does not.
  if (parsed.data.action === "set-role") {
    // Role changes are the sharper power: owner only.
    const scope = await requireScope({ roles: ["owner"], aal2: true, write: true });
    await setMemberRole(scope, parsed.data.userId, parsed.data.role);
    return NextResponse.json({ ok: true });
  }
  if (parsed.data.action === "create-department") {
    // Shaping the org chart is owner/admin work; aal2 like every other
    // access-shaping action on this route.
    const scope = await requireScope({ roles: ["owner", "admin"], aal2: true, write: true });
    await createDepartment(scope, parsed.data.key, parsed.data.name);
    return NextResponse.json({ ok: true }, { status: 201 });
  }
  if (parsed.data.action === "rename-department") {
    const scope = await requireScope({ roles: ["owner", "admin"], aal2: true, write: true });
    await renameDepartment(scope, parsed.data.key, parsed.data.name);
    return NextResponse.json({ ok: true });
  }
  if (parsed.data.action === "delete-department") {
    const scope = await requireScope({ roles: ["owner", "admin"], aal2: true, write: true });
    await deleteDepartment(scope, parsed.data.key);
    return NextResponse.json({ ok: true });
  }
  const scope = await requireScope({ roles: ["owner", "admin"], aal2: true, write: true });
  await setMemberDepartments(scope, parsed.data.userId, parsed.data.departments);
  return NextResponse.json({ ok: true });
});
