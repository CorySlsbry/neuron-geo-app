import { describe, expect, it } from "vitest";
import { AuthError, checkScope } from "./guards";
import type { ResolvedScope } from "./directory";

const base: ResolvedScope = {
  uid: "dev:mike@example.com",
  tenantId: "00000000-0000-0000-0000-000000000001",
  role: "staff",
  departments: ["field-ops"],
};

function err(fn: () => void): AuthError {
  try {
    fn();
  } catch (e) {
    if (e instanceof AuthError) return e;
    throw e;
  }
  throw new Error("expected AuthError");
}

describe("checkScope (pure authorization gate)", () => {
  it("passes with no requirements", () => {
    expect(() => checkScope(base, "aal1")).not.toThrow();
  });

  it("aal2 required: aal1 is 403, aal2 passes", () => {
    const e = err(() => checkScope(base, "aal1", { aal2: true }));
    expect(e.status).toBe(403);
    expect(e.code).toBe("aal2_required");
    expect(() => checkScope(base, "aal2", { aal2: true })).not.toThrow();
  });

  it("role gate: staff blocked from owner/admin surfaces", () => {
    const e = err(() =>
      checkScope(base, "aal2", { roles: ["owner", "admin"] }),
    );
    expect(e.code).toBe("role_forbidden");
    expect(() =>
      checkScope({ ...base, role: "owner" }, "aal2", { roles: ["owner", "admin"] }),
    ).not.toThrow();
  });

  it("department wall: dispatcher without hr-payroll grant is 403", () => {
    const e = err(() =>
      checkScope(base, "aal2", { departments: ["hr-payroll"] }),
    );
    expect(e.code).toBe("department_forbidden");
  });

  it("department wall: explicit grant passes", () => {
    const scope = { ...base, departments: ["field-ops", "hr-payroll"] };
    expect(() =>
      checkScope(scope, "aal2", { departments: ["hr-payroll"] }),
    ).not.toThrow();
  });

  it("owner/admin implicitly cross department walls", () => {
    const owner = { ...base, role: "owner" as const, departments: [] };
    expect(() =>
      checkScope(owner, "aal2", { departments: ["hr-payroll", "financials"] }),
    ).not.toThrow();
  });

  it("ALL requested departments must be held (not any)", () => {
    const scope = { ...base, departments: ["financials"] };
    const e = err(() =>
      checkScope(scope, "aal2", { departments: ["financials", "hr-payroll"] }),
    );
    expect(e.code).toBe("department_forbidden");
  });
});
