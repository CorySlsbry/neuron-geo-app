import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CryptoError, generateKey, open, seal, sealingAvailable } from "./crypto";

/**
 * The credential vault. These assertions are the difference between "the
 * tokens are encrypted" being a claim and being a fact.
 *
 * The tampering cases matter more than the round trip. A round trip passes
 * for encrypt-then-nothing just as happily as for encrypt-then-MAC; only a
 * forged token being REFUSED shows the authentication tag is real and is
 * actually checked.
 */

// Exactly 32 bytes → 43 base64url characters, unpadded. Fixed rather than
// generated so a failure is reproducible.
const KEY = "qjDpuHuq2jbrBgSMoawOY5TMtX59BmEEnBYTHZZ8wnI";

beforeEach(() => {
  process.env.CHANNEL_TOKEN_KEY = KEY;
});
afterEach(() => {
  delete process.env.CHANNEL_TOKEN_KEY;
});

describe("seal / open", () => {
  it("round-trips a token", () => {
    const secret = "ya29.a0AfH6SM-not-a-real-token";
    expect(open(seal(secret))).toBe(secret);
  });

  it("round-trips the whole grant, refresh token included", () => {
    const grant = JSON.stringify({ access: "at-123", refresh: "rt-456" });
    expect(JSON.parse(open(seal(grant)))).toEqual({ access: "at-123", refresh: "rt-456" });
  });

  it("produces a different ciphertext every time (random IV)", () => {
    // Same plaintext, same key, two seals. Equal outputs would mean a fixed
    // IV, which leaks whether two channels share a token.
    expect(seal("same")).not.toBe(seal("same"));
  });

  it("does not leave the plaintext visible in the token", () => {
    const token = seal("super-secret-value");
    expect(token).not.toContain("super-secret-value");
    expect(Buffer.from(token, "base64url").toString("utf8")).not.toContain(
      "super-secret-value",
    );
  });

  it("refuses a token whose ciphertext was altered", () => {
    const raw = Buffer.from(seal("hello"), "base64url");
    // Flip a bit in the ciphertext region (after the 9-byte header + 16 IV).
    raw[30] = (raw[30] ?? 0) ^ 0x01;
    expect(() => open(raw.toString("base64url"))).toThrow(CryptoError);
  });

  it("refuses a token whose HMAC was altered", () => {
    const raw = Buffer.from(seal("hello"), "base64url");
    raw[raw.length - 1] = (raw[raw.length - 1] ?? 0) ^ 0xff;
    expect(() => open(raw.toString("base64url"))).toThrow(/authentication/);
  });

  it("refuses a token carrying the wrong version byte", () => {
    const raw = Buffer.from(seal("hello"), "base64url");
    raw[0] = 0x79;
    expect(() => open(raw.toString("base64url"))).toThrow(/version/);
  });

  it("refuses a token that is too short to be one", () => {
    expect(() => open("abcd")).toThrow(/malformed/);
  });

  it("refuses a token sealed with a different key", () => {
    const token = seal("hello");
    process.env.CHANNEL_TOKEN_KEY = generateKey();
    // Authentication fails first — the wrong key cannot forge the tag — so
    // this never reaches the decrypt step. That ordering is the point.
    expect(() => open(token)).toThrow(/authentication/);
  });
});

describe("key configuration", () => {
  it("reports unavailable, and refuses to seal, with no key set", () => {
    delete process.env.CHANNEL_TOKEN_KEY;
    expect(sealingAvailable()).toBe(false);
    expect(() => seal("x")).toThrow(CryptoError);
  });

  it("refuses a key that is not 32 bytes", () => {
    process.env.CHANNEL_TOKEN_KEY = Buffer.from("too-short").toString("base64url");
    expect(sealingAvailable()).toBe(false);
    expect(() => seal("x")).toThrow(/32 bytes/);
  });

  it("generates keys the vault accepts", () => {
    process.env.CHANNEL_TOKEN_KEY = generateKey();
    expect(sealingAvailable()).toBe(true);
    expect(open(seal("round trip"))).toBe("round trip");
  });
});
