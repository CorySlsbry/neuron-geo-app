/**
 * A STREAMING zip writer — pure, no dependency, no buffering of the archive.
 *
 * ── Why the existing `buildZip` could not just be reused ──────────────────
 * `buildZip` takes every entry's full content as a string and returns the
 * whole archive as one `Uint8Array`. That is correct and fine for a CPA pack
 * of a dozen small reports. It is the wrong shape for "download my entire
 * business": a tenant with a few years of history produces CSVs far
 * larger than the 1 GiB this service runs in, and the old path held it THREE
 * times over — the rows, the CSV string, and the finished archive.
 *
 * ── The format detail that makes streaming possible ───────────────────────
 * A local file header must state the CRC and the compressed/uncompressed size
 * BEFORE the data. When you are streaming you do not know any of them yet.
 *
 * The zip spec's answer is the DATA DESCRIPTOR: set bit 3 of the general
 * purpose flag, write zeros in the header, then write the real CRC and sizes
 * in a 16-byte trailer AFTER the data. Every unzip implementation of the last
 * twenty-five years reads it — it is how every "download as zip" endpoint on
 * the internet works.
 *
 * STORE (no compression) is deliberate, same as `buildZip`. CSV compresses
 * beautifully, and adding DEFLATE would mean either a dependency or a
 * hand-rolled compressor in the path that hands a customer their own books.
 * Bandwidth is cheaper than that risk.
 *
 * ── ⛔ THE 4 GiB / 65,535-FILE CEILING, AND WHY IT THROWS ─────────────────
 * This writes classic zip, whose sizes and offsets are 32-bit and whose file
 * count is 16-bit. Going past any of them does not produce an error in the
 * format — it produces a SILENTLY WRONG archive, because the value simply
 * wraps. The doc above notes that a few years of history can already
 * exceed a gigabyte, so this is a reachable limit, not a theoretical one;
 * add media assets and 4 GiB is an ordinary export.
 *
 * A customer discovering their books are corrupt is a far worse outcome than
 * a customer told the export is too large, because they discover it later —
 * usually while migrating to whatever they left us for. So every field that
 * can overflow is checked, and the stream fails loudly instead.
 *
 * The real fix is ZIP64 (64-bit extra fields plus a ZIP64 end-of-central-
 * directory record). It is not written here because it cannot be honestly
 * verified without generating multi-gigabyte fixtures and testing against
 * real unzip implementations — and shipping an unverified ZIP64 writer into
 * the data-export path would reintroduce exactly the silent corruption these
 * guards exist to prevent.
 */

/** Classic-zip field ceilings. Past these, the format lies rather than errors. */
const MAX_U32 = 0xffff_ffff;
const MAX_U16 = 0xffff;

export class ZipTooLargeError extends Error {
  constructor(what: string) {
    super(
      `This export is too large for a single zip file (${what}). ` +
        `Export a narrower date range, or ask support to split it.`,
    );
    this.name = "ZipTooLargeError";
  }
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

/**
 * CRC32 that can be fed in pieces.
 *
 * The whole point: `update` is called once per chunk as rows stream past, so
 * the checksum never requires the complete file in memory.
 */
export class Crc32 {
  private c = 0xffffffff;

  update(bytes: Uint8Array): void {
    let c = this.c;
    for (let i = 0; i < bytes.length; i++) {
      c = CRC_TABLE[(c ^ bytes[i]!) & 0xff]! ^ (c >>> 8);
    }
    this.c = c;
  }

  get value(): number {
    return (this.c ^ 0xffffffff) >>> 0;
  }
}

export interface StreamZipEntry {
  name: string;
  /** Chunks of file content, in order. Yielded as they are produced. */
  chunks: AsyncIterable<Uint8Array>;
}

/** DOS time/date. Zip predates the epoch; a fixed sane value beats a wrong one. */
function dosDateTime(d: Date): { time: number; date: number } {
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (Math.floor(d.getSeconds() / 2) & 0x1f);
  const date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return { time, date };
}

/**
 * Yield a complete zip archive as chunks, reading each entry lazily.
 *
 * Peak memory is one chunk plus the central directory (a few dozen bytes per
 * file), not the archive.
 */
export async function* streamZip(
  entries: AsyncIterable<StreamZipEntry>,
): AsyncGenerator<Uint8Array> {
  const enc = new TextEncoder();
  const central: Uint8Array[] = [];
  const now = new Date();
  const { time, date } = dosDateTime(now);
  let offset = 0;
  let count = 0;

  for await (const entry of entries) {
    const nameBytes = enc.encode(entry.name);
    const localOffset = offset;
    // Checked BEFORE the header is written: once bytes are on the wire the
    // response cannot be un-sent, and a wrapped offset in the central
    // directory points a reader at the middle of somebody's data.
    if (localOffset > MAX_U32) throw new ZipTooLargeError("over 4 GiB of content");
    if (count >= MAX_U16) throw new ZipTooLargeError("over 65,535 files");

    // Local header with bit 3 set: "the CRC and sizes are in a trailer".
    const local = new Uint8Array(30 + nameBytes.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true); // version needed
    lv.setUint16(6, 0x0008, true); // ⛔ bit 3 — sizes/CRC follow the data
    lv.setUint16(8, 0, true); // method: store
    lv.setUint16(10, time, true);
    lv.setUint16(12, date, true);
    // CRC and both sizes stay ZERO here; the data descriptor carries them.
    lv.setUint16(26, nameBytes.length, true);
    local.set(nameBytes, 30);
    yield local;
    offset += local.length;

    const crc = new Crc32();
    let size = 0;
    for await (const chunk of entry.chunks) {
      if (chunk.length === 0) continue;
      crc.update(chunk);
      size += chunk.length;
      yield chunk;
      offset += chunk.length;
    }

    // One entry over 4 GiB wraps in both the descriptor and the central
    // directory. The data is already streamed at this point, so the archive
    // is doomed either way — throwing at least means the caller does not
    // hand the customer a file that unzips to garbage.
    if (size > MAX_U32) throw new ZipTooLargeError(`"${entry.name}" is over 4 GiB`);

    // The data descriptor. The 0x08074b50 signature is optional in the spec
    // and expected in practice — some readers refuse the archive without it.
    const desc = new Uint8Array(16);
    const dv = new DataView(desc.buffer);
    dv.setUint32(0, 0x08074b50, true);
    dv.setUint32(4, crc.value, true);
    dv.setUint32(8, size, true); // compressed (== uncompressed, we STORE)
    dv.setUint32(12, size, true);
    yield desc;
    offset += desc.length;

    const cd = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(cd.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true); // version made by
    cv.setUint16(6, 20, true); // version needed
    cv.setUint16(8, 0x0008, true); // same flag as the local header
    cv.setUint16(10, 0, true); // store
    cv.setUint16(12, time, true);
    cv.setUint16(14, date, true);
    cv.setUint32(16, crc.value, true);
    cv.setUint32(20, size, true);
    cv.setUint32(24, size, true);
    cv.setUint16(28, nameBytes.length, true);
    cv.setUint32(42, localOffset, true);
    cd.set(nameBytes, 46);
    central.push(cd);
    count++;
  }

  const centralStart = offset;
  // The end-of-central-directory record stores this as a u32. A wrapped
  // value sends every reader looking for the file table in the wrong place,
  // which presents as "the archive is not a zip file" rather than as a size
  // problem — so it gets named here instead.
  if (centralStart > MAX_U32) throw new ZipTooLargeError("over 4 GiB of content");
  let centralSize = 0;
  for (const cd of central) {
    yield cd;
    centralSize += cd.length;
  }

  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, count, true);
  ev.setUint16(10, count, true);
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, centralStart, true);
  yield end;
}
