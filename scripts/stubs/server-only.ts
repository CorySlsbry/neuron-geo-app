/**
 * A no-op stand-in for the `server-only` package, used ONLY by the publishing
 * worker (see `scripts/tsconfig.worker.json`).
 *
 * ── Why this exists ───────────────────────────────────────────────────────
 * `server-only` is a tripwire: importing it from a module that ends up in a
 * client bundle throws at build time. Every module that touches the database,
 * a credential, or the token vault carries it, and that is exactly right for
 * the web tier.
 *
 * The worker is not the web tier. It runs under plain Node (`tsx`), where the
 * package resolves to its "you imported this from a Client Component" branch
 * and throws on sight — so a daemon whose entire job is server-side work
 * cannot start, for the sake of a guard about browsers.
 *
 * ⛔ THE ALTERNATIVE WAS WORSE, WHICH IS WHY THIS FILE IS HERE. Deleting the
 * `import "server-only"` lines from `crypto.ts`, `networks.ts`, `pool.ts` and
 * the rest would have made the worker run by removing the tripwire from the
 * modules that most need it — the ones holding the sealing key and the OAuth
 * token reader. A stub scoped to one tsconfig, used by one script, leaves the
 * real build's guard completely intact: `pnpm build` and `pnpm typecheck` both
 * still resolve the genuine package.
 */
export {};
