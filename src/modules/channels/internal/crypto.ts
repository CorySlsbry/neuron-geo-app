import "server-only";
import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

/**
 * Fernet — the sealed envelope every OAuth token goes into before it touches
 * the database.
 *
 * Implemented here rather than pulled in as a dependency because Fernet is a
 * fully specified format in about eighty lines, and a credential vault is the
 * last place to inherit an unaudited transitive dependency tree. The format,
 * exactly:
 *
 *   version   1 byte    0x80
 *   timestamp 8 bytes   big-endian seconds since the epoch
 *   iv       16 bytes   random per message
 *   ciphertext         AES-128-CBC, PKCS#7 padded
 *   hmac     32 bytes   HMAC-SHA256 over everything above, signing key
 *
 * ...all of it base64url-encoded. The 32-byte key splits in half: the FIRST
 * 16 bytes sign, the LAST 16 encrypt. Getting that order backwards produces a
 * scheme that looks like it works and interoperates with nothing.
 *
 * ⛔ WHAT THIS DOES AND DOES NOT BUY — stated here because the honest version
 * of this sentence is easy to lose.
 *
 * Fernet is SYMMETRIC. Every process holding CHANNEL_TOKEN_KEY can both seal
 * and open. So "only the publishing worker can decrypt a customer's token" is
 * an ORGANISATIONAL claim about which processes get the env var — it is not
 * enforced by the cryptography, and anything with the key reads every token
 * in the table. The cryptographic version of that promise is a sealed box
 * (the web tier holds only a public key and physically cannot open what it
 * sealed); that is recorded as a v1.1 item in docs/SECURITY_AUDIT.md.
 *
 * What it genuinely buys, which is not nothing: a database backup, a replica,
 * a stray pg_dump, or any future read-only reporting path over the table
 * yields ciphertext rather than a live posting token.
 */

/** Fernet's version byte. Anything else is not a token we wrote. */
const VERSION = 0x80;

/**
 * The key version stamped onto every row we seal today.
 *
 * `tenant_credentials.key_version` exists so rotation is not a flag day: new
 * rows seal at a higher version while old rows stay openable by the key that
 * sealed them. Today there is exactly one key, so this is 1 — but the column
 * and this constant are the seam, and a rotation adds a key lookup here
 * rather than a migration over live ciphertext.
 */
export const CURRENT_KEY_VERSION = 1;

export class CryptoError extends Error {}

/**
 * The signing and encryption halves of the configured key.
 *
 * Read from the environment on every call rather than cached at module load:
 * a cached key is one that cannot be rotated without a restart, and the cost
 * here is a base64 decode on a path that already makes a network round trip.
 */
function keys(): { sign: Buffer; enc: Buffer } {
  const raw = process.env.CHANNEL_TOKEN_KEY;
  if (!raw) {
    throw new CryptoError("CHANNEL_TOKEN_KEY is not set");
  }
  const key = Buffer.from(raw.trim(), "base64url");
  if (key.length !== 32) {
    // Deliberately does not echo the value or its length in a way that helps
    // an attacker — but it does have to tell the operator what is wrong, and
    // "your key is the wrong size" is a configuration fact, not a secret.
    throw new CryptoError("CHANNEL_TOKEN_KEY must decode to exactly 32 bytes");
  }
  return { sign: key.subarray(0, 16), enc: key.subarray(16, 32) };
}

/** True when a usable key is configured. Drives the honest "not configured
 *  yet" state on the Channels screen — without a key we cannot store a token,
 *  so no network is connectable and the UI must say so BEFORE the click. */
export function sealingAvailable(): boolean {
  try {
    keys();
    return true;
  } catch {
    return false;
  }
}

/** Seal a secret. Returns the Fernet token as its base64url string. */
export function seal(plaintext: string): string {
  const { sign, enc } = keys();
  const iv = randomBytes(16);

  const header = Buffer.alloc(9);
  header.writeUInt8(VERSION, 0);
  header.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 1000)), 1);

  const cipher = createCipheriv("aes-128-cbc", enc, iv);
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);

  const signed = Buffer.concat([header, iv, ciphertext]);
  const mac = createHmac("sha256", sign).update(signed).digest();
  return Buffer.concat([signed, mac]).toString("base64url");
}

/**
 * Open a sealed secret.
 *
 * ⛔ THE HMAC IS VERIFIED BEFORE THE CIPHERTEXT IS TOUCHED, and that ordering
 * is the whole security of the construction. AES-CBC on its own is malleable:
 * decrypting first and checking later turns the padding check into an oracle
 * an attacker can grind against. Authenticate, then decrypt — never the
 * other way, however tempting the early return looks.
 */
export function open(token: string): string {
  const { sign, enc } = keys();
  const raw = Buffer.from(token, "base64url");

  // 9 header + 16 iv + 32 mac = 57, plus at least one 16-byte cipher block.
  if (raw.length < 73) throw new CryptoError("malformed token");
  if (raw.readUInt8(0) !== VERSION) throw new CryptoError("unsupported token version");

  const signed = raw.subarray(0, raw.length - 32);
  const mac = raw.subarray(raw.length - 32);
  const expected = createHmac("sha256", sign).update(signed).digest();
  // Constant-time: a byte-by-byte compare leaks how much of a forged tag was
  // correct, which is enough to build one a byte at a time.
  if (mac.length !== expected.length || !timingSafeEqual(mac, expected)) {
    throw new CryptoError("token failed authentication");
  }

  const iv = signed.subarray(9, 25);
  const ciphertext = signed.subarray(25);
  const decipher = createDecipheriv("aes-128-cbc", enc, iv);
  try {
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
  } catch {
    // Authenticated but undecryptable means the key changed under us, not
    // that someone is probing. Either way the caller gets one flat answer.
    throw new CryptoError("token could not be decrypted");
  }
}

/** Generate a fresh key, base64url, for an operator to paste into env. */
export function generateKey(): string {
  return randomBytes(32).toString("base64url");
}
