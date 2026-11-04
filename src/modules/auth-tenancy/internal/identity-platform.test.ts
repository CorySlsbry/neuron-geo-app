import { describe, expect, it, beforeAll, afterEach, vi } from "vitest";
import { SignJWT, generateKeyPair, exportJWK, type JWK } from "jose";

/**
 * Adversarial tests for ID-token verification.
 *
 * These are written as attacks, not as happy-path coverage, because every one
 * of them is a real published technique for defeating a JWT verifier. If any
 * of these ever passes, the app has no authentication at all — an attacker
 * picks any uid they like and every tenant boundary downstream is decoration.
 */

// A deliberately fake project id. The verifier pins iss/aud to whatever
// GCP_PROJECT_ID says at runtime, so the tests only need SOME pin — using the
// real project here would just couple the suite to infrastructure it never
// talks to (the JWKS is stubbed below).
const PROJECT = "neuron-geo-test";
const ISSUER = `https://securetoken.google.com/${PROJECT}`;

let goodPrivate: CryptoKey;
let goodPublicJwk: JWK;
let evilPrivate: CryptoKey;

beforeAll(async () => {
  const good = await generateKeyPair("RS256", { extractable: true });
  goodPrivate = good.privateKey;
  goodPublicJwk = { ...(await exportJWK(good.publicKey)), alg: "RS256", kid: "test-key" };
  const evil = await generateKeyPair("RS256", { extractable: true });
  evilPrivate = evil.privateKey;
});

/** Load the module with env set and Google's JWKS replaced by our test key. */
async function loadVerifier(jwk: JWK = goodPublicJwk) {
  vi.resetModules();
  process.env.GCP_PROJECT_ID = PROJECT;
  process.env.AUTH_MODE = "identity-platform";
  process.env.SESSION_SECRET = "test-session-secret-0000000000000000";

  vi.doMock("jose", async () => {
    const actual = await vi.importActual<typeof import("jose")>("jose");
    return {
      ...actual,
      // Stand in for Google's published keys.
      createRemoteJWKSet: () => actual.createLocalJWKSet({ keys: [jwk] }),
    };
  });
  return import("./identity-platform");
}

afterEach(() => {
  vi.doUnmock("jose");
  vi.resetModules();
});

interface TokenOpts {
  iss?: string;
  aud?: string;
  sub?: string;
  expiresIn?: string;
  authTime?: number;
  secondFactor?: string;
  key?: CryptoKey;
  alg?: string;
}

async function mintToken(o: TokenOpts = {}): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const firebase: Record<string, unknown> = { sign_in_provider: "password" };
  if (o.secondFactor) firebase.sign_in_second_factor = o.secondFactor;
  return new SignJWT({
    email: "mike@example.com",
    email_verified: true,
    auth_time: o.authTime ?? now - 10,
    firebase,
  })
    .setProtectedHeader({ alg: o.alg ?? "RS256", kid: "test-key" })
    .setIssuer(o.iss ?? ISSUER)
    .setAudience(o.aud ?? PROJECT)
    .setSubject(o.sub ?? "uid-mike-123")
    .setIssuedAt(now - 10)
    .setExpirationTime(o.expiresIn ?? "1h")
    .sign(o.key ?? goodPrivate);
}

describe("verifyIdToken", () => {
  it("accepts a well-formed token and returns aal1 by default", async () => {
    const { verifyIdToken } = await loadVerifier();
    const id = await verifyIdToken(await mintToken());
    expect(id.uid).toBe("uid-mike-123");
    expect(id.email).toBe("mike@example.com");
    expect(id.aal).toBe("aal1");
  });

  it("returns aal2 ONLY when a second factor is present", async () => {
    const { verifyIdToken } = await loadVerifier();
    const withMfa = await verifyIdToken(await mintToken({ secondFactor: "totp" }));
    expect(withMfa.aal).toBe("aal2");
    const without = await verifyIdToken(await mintToken());
    expect(without.aal).toBe("aal1");
  });

  // THE classic cross-project attack: same Google signing keys, different
  // project. Without an audience check this token verifies perfectly.
  it("rejects a token minted for a DIFFERENT project (aud)", async () => {
    const { verifyIdToken } = await loadVerifier();
    await expect(
      verifyIdToken(await mintToken({ aud: "some-other-project", iss: ISSUER })),
    ).rejects.toThrow("invalid_token");
  });

  it("rejects a token from a different issuer", async () => {
    const { verifyIdToken } = await loadVerifier();
    await expect(
      verifyIdToken(await mintToken({ iss: "https://securetoken.google.com/evil" })),
    ).rejects.toThrow("invalid_token");
  });

  it("rejects a token signed by the wrong key", async () => {
    const { verifyIdToken } = await loadVerifier();
    await expect(verifyIdToken(await mintToken({ key: evilPrivate }))).rejects.toThrow(
      "invalid_token",
    );
  });

  it("rejects an expired token", async () => {
    const { verifyIdToken } = await loadVerifier();
    await expect(verifyIdToken(await mintToken({ expiresIn: "-5m" }))).rejects.toThrow(
      "invalid_token",
    );
  });

  it("rejects a token whose auth_time is in the future", async () => {
    const { verifyIdToken } = await loadVerifier();
    const future = Math.floor(Date.now() / 1000) + 3600;
    await expect(verifyIdToken(await mintToken({ authTime: future }))).rejects.toThrow(
      "invalid_token",
    );
  });

  it("rejects an empty subject — uid is what everything downstream trusts", async () => {
    const { verifyIdToken } = await loadVerifier();
    await expect(verifyIdToken(await mintToken({ sub: "   " }))).rejects.toThrow("invalid_token");
  });

  it("rejects the alg:none unsigned-token attack", async () => {
    const { verifyIdToken } = await loadVerifier();
    const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
    const body = Buffer.from(
      JSON.stringify({ iss: ISSUER, aud: PROJECT, sub: "attacker", exp: 9999999999 }),
    ).toString("base64url");
    await expect(verifyIdToken(`${header}.${body}.`)).rejects.toThrow();
  });

  it("rejects malformed input without touching the network", async () => {
    const { verifyIdToken } = await loadVerifier();
    for (const bad of ["", "not-a-token", "a.b", "a.b.c.d"]) {
      await expect(verifyIdToken(bad)).rejects.toThrow(/malformed_token|invalid_token/);
    }
  });

  it("refuses to verify at all when the project is not configured", async () => {
    vi.resetModules();
    delete process.env.GCP_PROJECT_ID;
    const mod = await import("./identity-platform");
    await expect(mod.verifyIdToken("a.b.c")).rejects.toThrow("identity_not_configured");
    process.env.GCP_PROJECT_ID = PROJECT;
  });
});
