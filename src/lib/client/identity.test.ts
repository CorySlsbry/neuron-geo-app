import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  confirmPasswordReset,
  establishSession,
  IdentityClientError,
  sendPasswordReset,
  sendVerificationEmail,
  signUp,
} from "./identity";

/**
 * The signup / reset / verification half of the Identity Platform shim.
 *
 * These calls go browser → Google directly (the whole point: the password
 * never touches our servers), so the tests pin the CONTRACT — which endpoint,
 * which version, which body shape — because that is exactly what broke MFA in
 * the parent codebase (v1 vs v2 mix-up, found live 2026-07-26). A wrong path
 * here surfaces as a generic "didn't work" with no server log of ours to read.
 */

const API_KEY = "test-api-key";

/** Await a rejection and hand back the error — a resolve is itself a failure. */
async function errorOf(p: Promise<unknown>): Promise<Error> {
  try {
    await p;
  } catch (e) {
    return e as Error;
  }
  throw new Error("expected the promise to reject");
}


interface Call {
  url: string;
  body: Record<string, unknown>;
}

let calls: Call[];

function respond(status: number, body: unknown): void {
  (globalThis.fetch as ReturnType<typeof vi.fn>).mockImplementationOnce(
    async (url: string | URL, init?: RequestInit) => {
      calls.push({
        url: String(url),
        body: init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {},
      });
      return {
        ok: status < 400,
        status,
        json: async () => body,
      } as Response;
    },
  );
}

beforeEach(() => {
  calls = [];
  vi.stubGlobal("fetch", vi.fn());
  // post() logs the machine code for the console; keep test output clean.
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("signUp", () => {
  it("posts to v1 accounts:signUp and returns the ID token", async () => {
    respond(200, { idToken: "fresh-token" });
    const token = await signUp(API_KEY, "new@example.com", "hunter22");
    expect(token).toBe("fresh-token");
    expect(calls[0]!.url).toContain("/v1/accounts:signUp");
    expect(calls[0]!.url).toContain(`key=${API_KEY}`);
    expect(calls[0]!.body).toEqual({
      email: "new@example.com",
      password: "hunter22",
      returnSecureToken: true,
    });
  });

  it("maps EMAIL_EXISTS to a sentence that points at sign-in", async () => {
    respond(400, { error: { message: "EMAIL_EXISTS" } });
    const err = await errorOf(signUp(API_KEY, "taken@example.com", "hunter22"));
    expect(err).toBeInstanceOf(IdentityClientError);
    expect((err as IdentityClientError).code).toBe("EMAIL_EXISTS");
    expect(err.message).toMatch(/already an account/i);
  });

  it("maps WEAK_PASSWORD to plain language", async () => {
    respond(400, { error: { message: "WEAK_PASSWORD : Password should be at least 6 characters" } });
    const err = await errorOf(signUp(API_KEY, "new@example.com", "abc"));
    expect((err as IdentityClientError).code).toBe("WEAK_PASSWORD");
    expect(err.message).toMatch(/longer password/i);
  });

  it("refuses a success response that carries no token", async () => {
    respond(200, {});
    await expect(signUp(API_KEY, "new@example.com", "hunter22")).rejects.toThrow();
  });
});

describe("sendVerificationEmail", () => {
  it("posts VERIFY_EMAIL with the account's ID token and continue URL", async () => {
    respond(200, {});
    await sendVerificationEmail(API_KEY, "id-token-1", "https://app.example/login?verified=1");
    expect(calls[0]!.url).toContain("/v1/accounts:sendOobCode");
    expect(calls[0]!.body).toEqual({
      requestType: "VERIFY_EMAIL",
      idToken: "id-token-1",
      continueUrl: "https://app.example/login?verified=1",
    });
  });

  it("omits continueUrl when none is given", async () => {
    respond(200, {});
    await sendVerificationEmail(API_KEY, "id-token-1");
    expect(calls[0]!.body).toEqual({ requestType: "VERIFY_EMAIL", idToken: "id-token-1" });
  });
});

describe("sendPasswordReset", () => {
  it("posts PASSWORD_RESET with the email", async () => {
    respond(200, {});
    await sendPasswordReset(API_KEY, "someone@example.com", "https://app.example/login");
    expect(calls[0]!.url).toContain("/v1/accounts:sendOobCode");
    expect(calls[0]!.body).toEqual({
      requestType: "PASSWORD_RESET",
      email: "someone@example.com",
      continueUrl: "https://app.example/login",
    });
  });
});

describe("confirmPasswordReset", () => {
  it("posts the oobCode with the new password", async () => {
    respond(200, {});
    await confirmPasswordReset(API_KEY, "oob-123", "brand-new-pass");
    expect(calls[0]!.url).toContain("/v1/accounts:resetPassword");
    expect(calls[0]!.body).toEqual({ oobCode: "oob-123", newPassword: "brand-new-pass" });
  });

  it("maps an expired code to a message that says to request a fresh link", async () => {
    respond(400, { error: { message: "EXPIRED_OOB_CODE" } });
    const err = await errorOf(confirmPasswordReset(API_KEY, "stale", "brand-new-pass"));
    expect((err as IdentityClientError).code).toBe("EXPIRED_OOB_CODE");
    expect(err.message).toMatch(/expired|already used/i);
  });
});

describe("establishSession", () => {
  it("surfaces email_not_verified as its own code so login can offer a resend", async () => {
    respond(403, { error: { code: "email_not_verified", message: "email_not_verified" } });
    const err = await errorOf(establishSession("unverified-token"));
    expect(err).toBeInstanceOf(IdentityClientError);
    expect((err as IdentityClientError).code).toBe("EMAIL_NOT_VERIFIED");
    expect(err.message).toMatch(/inbox/i);
  });

  it("stays opaque for every other failure", async () => {
    respond(401, { error: { code: "invalid_credentials", message: "invalid_credentials" } });
    const err = await errorOf(establishSession("bad-token"));
    expect((err as IdentityClientError).code).toBe("SESSION");
  });
});
