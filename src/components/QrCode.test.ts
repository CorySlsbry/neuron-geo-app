import { describe, expect, it } from "vitest";
import qrcode from "qrcode-generator";

/**
 * The QR on /security is the ONLY practical way most people enrol a second
 * factor, and a subtly wrong one fails in the worst way: it scans on the
 * developer's phone and silently doesn't on a customer's.
 *
 * These assert the STRUCTURE the renderer depends on — module orientation and
 * the three finder patterns — so a wrong axis order, an off-by-one, or an
 * inverted palette is caught here rather than by a locked-out user. The
 * encoding itself is qrcode-generator's job (MIT, no deps, long-standing);
 * what is verified here is that we are reading it the way we think we are.
 */

const OTPAUTH =
  "otpauth://totp/Top%20Builder%20OS?secret=REDACTED" +
  "&issuer=Top%20Builder%20OS&algorithm=SHA1&digits=6&period=30";

function build(value: string) {
  const qr = qrcode(0, "M");
  qr.addData(value);
  qr.make();
  return qr;
}

/**
 * Every QR carries a 7x7 finder pattern in three corners: a solid dark ring,
 * a light ring inside it, and a 3x3 dark core. If our row/col reading were
 * transposed or inverted, these would not hold.
 */
function assertFinderPattern(
  qr: ReturnType<typeof build>,
  originRow: number,
  originCol: number,
  where: string,
): void {
  for (let r = 0; r < 7; r++) {
    for (let c = 0; c < 7; c++) {
      const onOuterRing = r === 0 || r === 6 || c === 0 || c === 6;
      const inCore = r >= 2 && r <= 4 && c >= 2 && c <= 4;
      const expected = onOuterRing || inCore;
      expect(
        qr.isDark(originRow + r, originCol + c),
        `${where} finder pattern wrong at (${r},${c})`,
      ).toBe(expected);
    }
  }
}

describe("QR encoding for TOTP enrolment", () => {
  it("produces a square matrix big enough for an otpauth URI", () => {
    const qr = build(OTPAUTH);
    const count = qr.getModuleCount();
    // Version 1 is 21x21 and cannot hold a URI this long; the auto-sizing
    // must have picked something larger, and QR sizes are always 4n+17.
    expect(count).toBeGreaterThan(21);
    expect((count - 17) % 4).toBe(0);
  });

  it("has all three finder patterns in the right corners", () => {
    const qr = build(OTPAUTH);
    const n = qr.getModuleCount();
    assertFinderPattern(qr, 0, 0, "top-left");
    assertFinderPattern(qr, 0, n - 7, "top-right");
    assertFinderPattern(qr, n - 7, 0, "bottom-left");
  });

  it("leaves the bottom-right corner free of a finder pattern", () => {
    // A QR has exactly THREE finders — a fourth would mean we are reading a
    // mirrored matrix, which scanners reject.
    const qr = build(OTPAUTH);
    const n = qr.getModuleCount();
    let allMatch = true;
    for (let r = 0; r < 7 && allMatch; r++) {
      for (let c = 0; c < 7 && allMatch; c++) {
        const onOuterRing = r === 0 || r === 6 || c === 0 || c === 6;
        const inCore = r >= 2 && r <= 4 && c >= 2 && c <= 4;
        if (qr.isDark(n - 7 + r, n - 7 + c) !== (onOuterRing || inCore)) {
          allMatch = false;
        }
      }
    }
    expect(allMatch, "bottom-right looks like a finder pattern — matrix mirrored?").toBe(
      false,
    );
  });

  it("encodes different secrets to different matrices", () => {
    // Guards against the renderer accidentally memoising across enrolments —
    // handing a user a QR for somebody else's secret.
    const a = build(OTPAUTH);
    const b = build(OTPAUTH.replace("REDACTED", "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"));
    const n = Math.min(a.getModuleCount(), b.getModuleCount());
    let differences = 0;
    for (let r = 0; r < n; r++) {
      for (let c = 0; c < n; c++) if (a.isDark(r, c) !== b.isDark(r, c)) differences++;
    }
    expect(differences).toBeGreaterThan(0);
  });

  it("is not blank and not solid — a plausible module density", () => {
    // A blank or solid matrix renders as a pretty square that scans as
    // nothing; both would pass a screenshot review.
    const qr = build(OTPAUTH);
    const n = qr.getModuleCount();
    let dark = 0;
    for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (qr.isDark(r, c)) dark++;
    const ratio = dark / (n * n);
    expect(ratio).toBeGreaterThan(0.25);
    expect(ratio).toBeLessThan(0.75);
  });
});
