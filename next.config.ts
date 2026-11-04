import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Standalone output produces a minimal server bundle for the non-root
  // Cloud Run container (see Dockerfile). Copies only what the server needs.
  output: "standalone",
  reactStrictMode: true,
  // Security headers that are static live here; the nonce-based CSP is set
  // per-request in src/middleware.ts (a nonce cannot be a static header).
  poweredByHeader: false,
  // Pin the workspace root so Turbopack doesn't warn about lockfiles in parent
  // directories (Downloads/ may contain unrelated ones).
  turbopack: {
    root: import.meta.dirname,
  },
};

export default nextConfig;
