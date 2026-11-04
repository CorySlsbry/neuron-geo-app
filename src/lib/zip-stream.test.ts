import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Crc32, streamZip, type StreamZipEntry } from "./zip-stream";

/**
 * A zip that a customer cannot open is worse than a download that failed:
 * the failure is silent and they find out later, holding the only copy of
 * their data.
 *
 * So these tests do not merely check that bytes came out. They check the
 * structure the format requires, and — where the platform provides one — they
 * hand the archive to a REAL unzip implementation and make it read the files
 * back.
 */

async function collect(entries: StreamZipEntry[]): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  for await (const chunk of streamZip((async function* () {
    for (const e of entries) yield e;
  })())) {
    parts.push(chunk);
  }
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

function textEntry(name: string, ...chunks: string[]): StreamZipEntry {
  const enc = new TextEncoder();
  return {
    name,
    chunks: (async function* () {
      for (const c of chunks) yield enc.encode(c);
    })(),
  };
}

describe("Crc32 — incremental, and identical to whole-buffer", () => {
  it("chunked equals unchunked", () => {
    // The whole reason the class exists: rows arrive in batches, so the
    // checksum must be feedable in pieces without changing the answer.
    const enc = new TextEncoder();
    const whole = new Crc32();
    whole.update(enc.encode("hello world, this is a csv row\r\n"));

    const pieces = new Crc32();
    pieces.update(enc.encode("hello world, "));
    pieces.update(enc.encode("this is a csv row"));
    pieces.update(enc.encode("\r\n"));

    expect(pieces.value).toBe(whole.value);
  });

  it("matches a known CRC32 value", () => {
    const c = new Crc32();
    c.update(new TextEncoder().encode("123456789"));
    expect(c.value).toBe(0xcbf43926); // the standard check value
  });

  it("an empty stream has the empty CRC", () => {
    expect(new Crc32().value).toBe(0);
  });
});

describe("the archive's structure is what the spec requires", () => {
  it("starts with a local header and ends with an end-of-central-directory", async () => {
    const zip = await collect([textEntry("a.csv", "x,y\r\n1,2\r\n")]);
    const dv = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
    expect(dv.getUint32(0, true)).toBe(0x04034b50);
    expect(dv.getUint32(zip.length - 22, true)).toBe(0x06054b50);
  });

  it("⛔ sets bit 3 and writes a DATA DESCRIPTOR, because sizes are unknown upfront", () => {
    // This is the detail that makes streaming possible at all. Without bit 3,
    // the local header's zero CRC/size is a lie and readers reject the file.
    return collect([textEntry("a.csv", "hello")]).then((zip) => {
      const dv = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
      expect(dv.getUint16(6, true) & 0x0008).toBe(0x0008);
      // Header sizes are zero...
      expect(dv.getUint32(14, true)).toBe(0); // crc
      expect(dv.getUint32(18, true)).toBe(0); // compressed
      expect(dv.getUint32(22, true)).toBe(0); // uncompressed
      // ...and the truth follows the data, behind the descriptor signature.
      const nameLen = dv.getUint16(26, true);
      const descAt = 30 + nameLen + 5; // "hello"
      expect(dv.getUint32(descAt, true)).toBe(0x08074b50);
      expect(dv.getUint32(descAt + 8, true)).toBe(5); // compressed size
      expect(dv.getUint32(descAt + 12, true)).toBe(5); // uncompressed size
    });
  });

  it("counts every entry in the end record", async () => {
    const zip = await collect([
      textEntry("a.csv", "1"),
      textEntry("b.csv", "2"),
      textEntry("c.csv", "3"),
    ]);
    const dv = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
    expect(dv.getUint16(zip.length - 22 + 8, true)).toBe(3);
    expect(dv.getUint16(zip.length - 22 + 10, true)).toBe(3);
  });

  it("handles an entry whose content arrives in many chunks", async () => {
    // The realistic case: one table, hundreds of FETCH batches.
    const zip = await collect([textEntry("big.csv", ...Array.from({ length: 200 }, (_, i) => `${i},row\r\n`))]);
    expect(zip.length).toBeGreaterThan(1000);
    const dv = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
    expect(dv.getUint32(zip.length - 22, true)).toBe(0x06054b50);
  });

  it("an empty file still produces a valid entry", async () => {
    // An empty table gets a header-only CSV; the archive must not choke.
    const zip = await collect([textEntry("empty.csv")]);
    const dv = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
    expect(dv.getUint32(0, true)).toBe(0x04034b50);
    expect(dv.getUint16(zip.length - 22 + 8, true)).toBe(1);
  });
});

/**
 * ⛔ THE TEST THAT ACTUALLY MATTERS: hand it to a real unzip.
 *
 * Every assertion above checks bytes I wrote against a format I read about.
 * They would all pass on an archive that no real tool can open. PowerShell's
 * Expand-Archive is present on every Windows box this builds on, so the
 * archive gets round-tripped through an implementation nobody here wrote.
 *
 * Skipped rather than failed where PowerShell is unavailable (CI on Linux) —
 * a skipped test that says why beats a green one that checked nothing.
 */
describe("a real unzip can read it", () => {
  const hasPowerShell = (() => {
    try {
      execFileSync("powershell", ["-NoProfile", "-Command", "$PSVersionTable.PSVersion.Major"], {
        stdio: "pipe",
        timeout: 20_000,
      });
      return true;
    } catch {
      return false;
    }
  })();

  it.runIf(hasPowerShell)("round-trips two files through Expand-Archive", async () => {
    const zip = await collect([
      textEntry("jobs.csv", "id,name\r\n", "1,Rooftop unit\r\n", "2,Tear-off\r\n"),
      textEntry("README.txt", "Your data.\nRow counts:\n  jobs: 2\n"),
    ]);

    const dir = mkdtempSync(join(tmpdir(), "zipstream-"));
    const zipPath = join(dir, "export.zip");
    writeFileSync(zipPath, Buffer.from(zip));

    execFileSync(
      "powershell",
      [
        "-NoProfile",
        "-Command",
        `Expand-Archive -Path '${zipPath}' -DestinationPath '${join(dir, "out")}' -Force`,
      ],
      { stdio: "pipe", timeout: 60_000 },
    );

    const jobs = join(dir, "out", "jobs.csv");
    const readme = join(dir, "out", "README.txt");
    expect(existsSync(jobs), "jobs.csv should exist after extraction").toBe(true);
    expect(existsSync(readme)).toBe(true);
    // Byte-for-byte, including the CRLF the CSV writer emits.
    expect(readFileSync(jobs, "utf8")).toBe("id,name\r\n1,Rooftop unit\r\n2,Tear-off\r\n");
    expect(readFileSync(readme, "utf8")).toContain("jobs: 2");
  });
});
