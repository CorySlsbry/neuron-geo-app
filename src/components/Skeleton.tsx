"use client";
import type { CSSProperties, ReactNode } from "react";

/**
 * A wireframe of the screen that is coming — not a spinner.
 *
 * The point is ZERO LAYOUT SHIFT: every bar below is sized from the real CSS
 * rule it stands in for, so when the data lands nothing moves. A placeholder
 * that reflows on swap is worse than plain text, because it promises a shape
 * and then breaks the promise. The heights are taken from globals.css:
 *   .big   1.5rem × 1.5 line-height  = 34px
 *   .muted 0.875rem × 1.5            = 20px
 *   td     9px + 9px padding + 20px  = 38px
 *   .list-item 12px + 12px + 42px    = 66px
 *
 * Everything is composed from ONE primitive. There is no Button, Card or Table
 * component in this codebase and this is not the place to start adding them —
 * these exist only because a skeleton has to mirror a layout it does not own.
 */

export function Skel({
  w = "100%",
  h = 14,
  r = 6,
  style,
}: {
  w?: number | string;
  h?: number;
  /** Border radius in px. 999 for a pill, 6 for text, 12 to stand in for a card. */
  r?: number;
  style?: CSSProperties;
}) {
  return (
    <span
      className="skel"
      style={{ width: typeof w === "number" ? `${w}px` : w, height: h, borderRadius: r, ...style }}
    />
  );
}

/** N lines of prose. The last line is short, because real paragraphs are. */
export function SkelText({ lines = 3 }: { lines?: number }) {
  return (
    <span className="skel-stack">
      {Array.from({ length: lines }, (_, i) => (
        <Skel key={i} h={14} w={i === lines - 1 ? "58%" : "100%"} />
      ))}
    </span>
  );
}

/** The `.row` of muted-label + `.big`-figure blocks that opens /wip, /money,
 *  /billing and the job screens. */
export function SkelStats({ count = 3 }: { count?: number }) {
  return (
    <div className="card">
      <div className="row" style={{ gap: 28 }}>
        {Array.from({ length: count }, (_, i) => (
          <span key={i} className="skel-stack" style={{ minWidth: 108 }}>
            <Skel h={12} w={72} />
            <Skel h={34} w={132} r={8} />
          </span>
        ))}
      </div>
    </div>
  );
}

/** A card of `.list-item` rows — /jobs, /approvals, /memberships, /intake. */
export function SkelRows({ rows = 5 }: { rows?: number }) {
  return (
    <div className="card" style={{ padding: 0, overflow: "hidden" }}>
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="skel-row">
          <span className="skel-stack grow">
            <Skel h={15} w={`${52 - (i % 3) * 9}%`} />
            <Skel h={12} w={`${34 - (i % 2) * 7}%`} />
          </span>
          <Skel h={15} w={72} />
        </div>
      ))}
    </div>
  );
}

/**
 * A REAL <table>, so column widths and the mobile `display:block; overflow-x`
 * rule at globals.css behave exactly as they will with data in them.
 */
export function SkelTable({ rows = 6, cols = 4 }: { rows?: number; cols?: number }) {
  return (
    <div className="card">
      <table>
        <thead>
          <tr>
            {Array.from({ length: cols }, (_, i) => (
              <th key={i}>
                <Skel h={12} w={i === 0 ? 96 : 62} />
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {Array.from({ length: rows }, (_, r) => (
            <tr key={r}>
              {Array.from({ length: cols }, (_, c) => (
                <td key={c}>
                  <Skel h={14} w={c === 0 ? `${68 - (r % 3) * 11}%` : `${58 - (c % 2) * 16}%`} />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Label + input pairs at the heights of the base form rules, plus a button. */
export function SkelForm({ fields = 4, button = true }: { fields?: number; button?: boolean }) {
  return (
    <div className="card">
      <span className="skel-stack" style={{ gap: 14 }}>
        {Array.from({ length: fields }, (_, i) => (
          <span key={i} className="skel-stack">
            <Skel h={12} w={i % 2 ? 104 : 78} />
            <Skel h={40} r={10} />
          </span>
        ))}
        {button && <Skel h={40} w={148} r={10} />}
      </span>
    </div>
  );
}

/**
 * The live region every skeleton lives in.
 *
 * Announced ONCE. Because the skeleton is delayed ~140ms it is inserted after
 * the first commit, which is precisely what makes `role="status"` announce at
 * all — a region present at mount is not. The delay is doing double duty.
 * Every bar under it is `aria-hidden`, so a screen reader hears one sentence
 * and no decoration.
 */
export function SkeletonRegion({
  children,
  label = "Loading…",
}: {
  children: ReactNode;
  label?: string;
}) {
  return (
    <div className="skel-region" role="status" aria-live="polite" aria-busy="true">
      <span className="sr-only">{label}</span>
      <div aria-hidden="true">{children}</div>
    </div>
  );
}

/**
 * The only thing most screens import. Five presets cover every page in the
 * app (team & access, billing, security, account — and whatever the GEO
 * cockpit brings, which is why the presets are shapes, not screen names):
 *
 *   list    a card of rows
 *   table   a card with a table
 *   stats   KPI row + a paragraph
 *   form    labelled fields
 *   detail  stats + text + rows
 */
export default function PageSkeleton({
  kind,
  label = "Loading…",
}: {
  kind: "list" | "table" | "stats" | "form" | "detail";
  label?: string;
}) {
  return (
    <SkeletonRegion label={label}>
      {kind === "list" && <SkelRows rows={6} />}
      {kind === "table" && <SkelTable rows={6} cols={4} />}
      {kind === "stats" && (
        <>
          <SkelStats count={3} />
          <div className="card">
            <SkelText lines={3} />
          </div>
        </>
      )}
      {kind === "form" && <SkelForm fields={4} />}
      {kind === "detail" && (
        <>
          <SkelStats count={3} />
          <div className="card">
            <SkelText lines={2} />
          </div>
          <SkelRows rows={4} />
        </>
      )}
    </SkeletonRegion>
  );
}
