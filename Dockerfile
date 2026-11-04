# syntax=docker/dockerfile:1
# Multi-stage build → minimal, NON-ROOT Next.js standalone image for Cloud Run.
# Deployed by immutable @sha256 digest (never :latest) — see cloudbuild.yaml.

FROM node:24-alpine AS base
ENV PNPM_HOME=/pnpm
ENV PATH="$PNPM_HOME:$PATH"
# Pin pnpm EXPLICITLY. Two traps here, both hit on 2026-07-25:
#   1. Bare `corepack enable` fetches the LATEST pnpm at build time. pnpm 11
#      stopped reading `pnpm.overrides` from package.json, so the image computed
#      "no overrides" while the lockfile recorded the CVE pins, and
#      --frozen-lockfile correctly refused. A local check cannot reproduce it.
#   2. `corepack prepare --activate` (no version) reads package.json, which does
#      not exist yet in this stage — it is copied in `deps`. Name the version.
# Keep this in step with package.json's packageManager field.
ARG PNPM_VERSION=10.33.0
RUN corepack enable && corepack prepare pnpm@${PNPM_VERSION} --activate

# --- deps: install with a cached, frozen lockfile ---------------------------
FROM base AS deps
WORKDIR /app
COPY package.json pnpm-lock.yaml ./
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile

# --- builder: compile the standalone server ---------------------------------
FROM base AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
# NEXT_PUBLIC_* build args (if any) would be passed here as --build-arg before
# `next build`. There are none yet; runtime secrets are read at runtime.
RUN pnpm build

# --- runner: distroless-style minimal runtime, non-root ---------------------
FROM base AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=8080

# Create an unprivileged user and own the app dir.
RUN addgroup --system --gid 1001 nodejs \
 && adduser --system --uid 1001 nextjs

# Standalone output ships only what the server needs.
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
COPY --from=builder --chown=nextjs:nodejs /app/public ./public

USER nextjs
EXPOSE 8080
CMD ["node", "server.js"]

# --- worker: the publishing daemon ------------------------------------------
# A SEPARATE TARGET, not a second command on the web image, and the reason is
# the database role rather than convenience. The web image connects as
# `app_user` (one tenant, no EXECUTE on any job function); this one connects as
# `app_worker` (the whole queue). Two images means the two DSNs are configured
# on two different deployments and neither can accidentally inherit the other's
# — see migration 0005 for why that separation is the whole security design.
#
# ⛔ It cannot use the standalone output. `next build --output standalone`
# traces what the SERVER imports and ships only that; `scripts/worker.ts` is
# not reachable from any route, so none of it is included. This stage carries
# real node_modules and real source instead, which makes the image larger than
# the web one. That is the honest cost of running TypeScript directly, and the
# alternative (a second compile step) buys size at the price of the worker and
# the app disagreeing about what the code says.
FROM base AS worker
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

RUN addgroup --system --gid 1001 nodejs \
 && adduser --system --uid 1001 worker

COPY --from=deps --chown=worker:nodejs /app/node_modules ./node_modules
COPY --chown=worker:nodejs package.json tsconfig.json ./
COPY --chown=worker:nodejs scripts ./scripts
COPY --chown=worker:nodejs src ./src

USER worker
# No EXPOSE: the worker serves nothing. It makes outbound connections only —
# to Postgres, and (when live publishing is switched on) to the platforms.
# Deployed as a Cloud Run JOB or a min-instance-1 service with no ingress,
# never as a public endpoint.
#
# ⛔ ENTRYPOINT, not CMD, and it matters here. Without an ENTRYPOINT, args
# passed to `docker run` REPLACE the command rather than extend it, so
# `docker run <image> --drain` becomes `--drain` and node exits with
# "bad option". Splitting them means the flags this daemon actually takes
# (--once, --drain) work the way anyone would expect, which is what a Cloud
# Run Job override will pass. Found by running it, not by reading it.
ENTRYPOINT ["node_modules/.bin/tsx", "--tsconfig", "scripts/tsconfig.worker.json", "scripts/worker.ts"]
# Default: poll forever. Overridden per-invocation by a Job that wants --drain.
CMD []
