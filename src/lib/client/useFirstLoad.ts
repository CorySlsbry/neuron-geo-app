import { useEffect, useRef, useState } from "react";

/**
 * "Should a first-load skeleton be on screen right now?"
 *
 * Three rules, each preventing one specific ugly thing. They are small enough
 * to read in one sitting and they replace what a data-fetching library would
 * otherwise be dragged in to do.
 *
 *  1. LATCH — once `ready` has been true once, this returns false forever.
 *     Without it, the `act()` idiom used on nine screens (`finally { setBusy(false);
 *     await load(); }`) would re-arm the skeleton after EVERY save and the whole
 *     page would strobe on each write. The same latch is why a screen reader
 *     hears "Loading…" once per visit instead of once per mutation. One rule,
 *     both problems.
 *
 *  2. DELAY — nothing shows for the first `delayMs`. A skeleton that flashes
 *     for 40ms is worse than none, and on a warm connection most screens in
 *     this app will never show one at all. That is the correct outcome, not a
 *     missing feature.
 *
 *  3. FLOOR — once shown, it stays for `minMs`. Otherwise a response landing
 *     just past the delay produces exactly the flash rule 2 exists to avoid.
 *
 * ── Where NOT to use this ─────────────────────────────────────────────────
 * Anywhere the indicator must fire again for a SECOND item: opening another
 * record, asking another question. The latch is wrong there by design —
 * use a plain `busy` boolean. Call sites that opt out say so in their own
 * comments.
 */
export function useFirstLoad(
  ready: boolean,
  { delayMs = 140, minMs = 300 }: { delayMs?: number; minMs?: number } = {},
): boolean {
  const [show, setShow] = useState(false);
  const settled = useRef(false);
  const shownAt = useRef(0);

  useEffect(() => {
    if (settled.current) return;

    if (!ready) {
      const t = setTimeout(() => {
        shownAt.current = Date.now();
        setShow(true);
      }, delayMs);
      return () => clearTimeout(t);
    }

    settled.current = true;
    // Never appeared: the data beat the delay. Nothing to hide, nothing was
    // announced, and the user saw a clean render.
    if (shownAt.current === 0) {
      setShow(false);
      return;
    }
    const left = minMs - (Date.now() - shownAt.current);
    if (left <= 0) {
      setShow(false);
      return;
    }
    const t = setTimeout(() => setShow(false), left);
    return () => clearTimeout(t);
  }, [ready, delayMs, minMs]);

  return show;
}
