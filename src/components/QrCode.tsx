"use client";
import qrcode from "qrcode-generator";
import { useMemo } from "react";

/**
 * An `otpauth://` URI rendered as a scannable QR code, entirely in the browser.
 *
 * Two constraints decide the design:
 *
 * 1. **The secret never leaves the device.** Enrollment talks straight from the
 *    browser to Identity Platform, so our server never sees the TOTP seed —
 *    and rendering the QR here keeps it that way. A hosted QR service (the
 *    usual `chart.googleapis.com/chart?chl=...` trick) would put the seed in
 *    someone else's URL logs, which is the whole credential, in plaintext, to
 *    a third party. It would also be blocked by our CSP, which is working as
 *    intended.
 * 2. **Inline SVG, no image request.** The page's CSP is `default-src 'self'`
 *    with a per-request nonce; an inline `<svg>` needs no `img-src` allowance,
 *    no data: URI, and stays crisp at any size on a cracked phone screen in
 *    the sun.
 *
 * Encoding is delegated to `qrcode-generator` (MIT, no dependencies) rather
 * than hand-rolled. Reed-Solomon error correction and mask selection are easy
 * to get subtly wrong, and the failure mode is the nastiest kind: scans on the
 * reviewer's phone, silently fails on a customer's.
 */
export default function QrCode({
  value,
  size = 200,
  label,
}: {
  value: string;
  /** Rendered edge length in CSS pixels. */
  size?: number;
  /** Accessible description. The QR itself is meaningless to a screen reader. */
  label: string;
}) {
  const path = useMemo(() => {
    // typeNumber 0 = pick the smallest version that fits the data.
    // "M" (~15% recovery) is what authenticator apps expect; higher levels
    // make the code denser for no practical benefit at this size.
    const qr = qrcode(0, "M");
    qr.addData(value);
    qr.make();

    const count = qr.getModuleCount();
    // One path of many subpaths beats thousands of <rect> elements — same
    // pixels, a fraction of the DOM.
    let d = "";
    for (let row = 0; row < count; row++) {
      for (let col = 0; col < count; col++) {
        if (qr.isDark(row, col)) d += `M${col},${row}h1v1h-1z`;
      }
    }
    return { d, count };
  }, [value]);

  // The quiet zone is part of the spec, not padding for looks: without ~4
  // modules of margin many scanners will not lock on at all.
  const QUIET = 4;
  const extent = path.count + QUIET * 2;

  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${extent} ${extent}`}
      role="img"
      aria-label={label}
      // Always light-on-dark-modules, explicitly — NOT inherited from the
      // theme. A dark-mode page that renders this with a transparent
      // background produces a code no scanner can read, and the user has no
      // way to know why.
      style={{
        background: "#ffffff",
        borderRadius: 8,
        display: "block",
        // Keep the modules square-edged; smoothing blurs the finder patterns.
        shapeRendering: "crispEdges",
      }}
    >
      <rect width={extent} height={extent} fill="#ffffff" />
      <g transform={`translate(${QUIET},${QUIET})`}>
        <path d={path.d} fill="#000000" />
      </g>
    </svg>
  );
}
