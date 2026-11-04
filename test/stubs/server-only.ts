// Vitest stub for the `server-only` marker package. In Next.js the real
// package throws when a server module is imported into client code; in tests
// we ARE on the server, so the marker is a no-op.
export {};
