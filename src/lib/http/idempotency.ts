import "server-only";
import { createHash } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { withTenant } from "@/lib/db/tenant";
import { requireScope, type ScopeRequirements } from "@/modules/auth-tenancy";
import { errorResponse, HttpError } from "./errors";

/**
 * Request-level idempotency: the same request twice has the effect of once.
 *
 * The case this exists for is not exotic. Someone on one bar of signal taps
 * a paid action, sees nothing happen, and taps again. Without this, that is
 * the same money spent twice, or the same content published twice — and the
 * kind of bug that surfaces weeks later on somebody's statement, which is the
 * most expensive place to find it.
 *
 * Storage-layer uniqueness (payments.reference, bill_payments.provider_ref,
 * agent_actions.idempotency_key) already covers paths with a natural key. This
 * covers everything else, which was 65 of 66 mutating routes.
 *
 * ── Protocol ──────────────────────────────────────────────────────────────
 *
 *   claim (own transaction, so it survives a crash in the work)
 *     → run the handler
 *       → record the response against the key
 *
 * Replay outcomes:
 *   completed   → the ORIGINAL response, verbatim. A retry is indistinguishable
 *                 from the first call, which is the whole point.
 *   in_progress → 409 idempotent_replay_in_progress. Two clicks genuinely
 *                 raced; the second must not execute.
 *   handler threw → the key is RELEASED. A key burned by a transient database
 *                 error would be worse than no idempotency at all: the user
 *                 could never complete the action.
 *
 * A key reused with a different body is a client bug (usually a key generated
 * once and never rotated) and returns 422 rather than silently replaying a
 * response for a request the caller did not make.
 */

const HEADER = "idempotency-key";

/** Conservative: a key is opaque to us, but it must be sane to store. */
const KEY_RE = /^[A-Za-z0-9_:.-]{8,200}$/;

function hashBody(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

export interface IdempotentOptions {
  /** Scope requirements, checked BEFORE the key is claimed. */
  scope?: ScopeRequirements;
  /**
   * Require the header rather than allowing unkeyed calls through.
   * Off by default so an existing client that has not been updated keeps
   * working — but every money route sets this.
   */
  require?: boolean;
}

/**
 * Wrap a mutating handler so it runs at most once per (tenant, key, route).
 *
 * The handler receives the parsed body so it is not re-read (the stream is
 * already consumed to hash it) and the resolved scope so it does not
 * re-authorize.
 */
export function idempotent<C>(
  routeName: string,
  opts: IdempotentOptions,
  handler: (
    body: unknown,
    scope: Awaited<ReturnType<typeof requireScope>>,
    ctx: C,
  ) => Promise<NextResponse>,
): (req: NextRequest, ctx: C) => Promise<NextResponse> {
  return async (req: NextRequest, ctx: C) => {
    const scope = await requireScope(opts.scope ?? {});

    // Read the body ONCE. Everything downstream uses the parsed value.
    const raw = await req.text();
    let body: unknown = null;
    if (raw) {
      try {
        body = JSON.parse(raw);
      } catch {
        return errorResponse(400, "invalid_body");
      }
    }

    const key = req.headers.get(HEADER)?.trim() ?? "";
    if (!key) {
      if (opts.require) return errorResponse(400, "idempotency_key_required");
      return handler(body, scope, ctx); // unkeyed: legacy behaviour
    }
    if (!KEY_RE.test(key)) return errorResponse(400, "idempotency_key_invalid");

    const hash = hashBody(raw);

    // ---------------------------------------------------------------- claim
    // Its own transaction on purpose: if the handler crashes the process, the
    // claim must already be durable, otherwise a retry re-executes the work.
    const claim = await withTenant(scope, async (c) => {
      const ins = await c.query<{ status: string }>(
        `INSERT INTO idempotency_keys
           (tenant_id, key, route, request_hash, claimed_by)
         VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (tenant_id, key, route) DO NOTHING
         RETURNING status`,
        [scope.tenantId, key, routeName, hash, scope.uid],
      );
      if (ins.rowCount === 1) return { kind: "fresh" as const };

      // Someone already holds this key. Lock the row before deciding, so two
      // concurrent replays cannot both read 'in_progress' and both proceed.
      const { rows } = await c.query<{
        status: string;
        request_hash: string;
        response_status: number | null;
        response_body: unknown;
      }>(
        `SELECT status, request_hash, response_status, response_body
           FROM idempotency_keys
          WHERE tenant_id = $1 AND key = $2 AND route = $3
          FOR UPDATE`,
        [scope.tenantId, key, routeName],
      );
      const row = rows[0]!;
      if (row.request_hash !== hash) return { kind: "mismatch" as const };
      if (row.status === "in_progress") return { kind: "in_flight" as const };
      return {
        kind: "replay" as const,
        status: row.response_status ?? 200,
        body: row.response_body,
      };
    });

    if (claim.kind === "mismatch")
      return errorResponse(422, "idempotency_key_reused");
    if (claim.kind === "in_flight") {
      return errorResponse(409, "idempotent_replay_in_progress");
    }
    if (claim.kind === "replay") {
      const res = NextResponse.json(claim.body, { status: claim.status });
      // Tells an operator (and any test) that this was served from the store
      // rather than executed again.
      res.headers.set("Idempotent-Replay", "true");
      return res;
    }

    // ----------------------------------------------------------- do the work
    let response: NextResponse;
    try {
      response = await handler(body, scope, ctx);
    } catch (err) {
      // RELEASE the key. A transient failure must stay retryable — a burned
      // key would leave the user permanently unable to perform the action.
      await withTenant(scope, async (c) => {
        await c.query(
          `DELETE FROM idempotency_keys
            WHERE tenant_id = $1 AND key = $2 AND route = $3 AND status = 'in_progress'`,
          [scope.tenantId, key, routeName],
        );
      }).catch(() => {}); // never mask the original error with a cleanup failure
      throw err;
    }

    // --------------------------------------------------------------- record
    // Only successful responses are worth replaying. A 4xx is a rejected
    // request; the caller should be free to fix it and try the same key again.
    if (response.status < 400) {
      const stored = await response
        .clone()
        .json()
        .catch(() => null);
      await withTenant(scope, async (c) => {
        await c.query(
          `UPDATE idempotency_keys
              SET status = 'completed', response_status = $4,
                  response_body = $5, completed_at = now()
            WHERE tenant_id = $1 AND key = $2 AND route = $3`,
          [scope.tenantId, key, routeName, response.status, stored],
        );
      });
    } else {
      await withTenant(scope, async (c) => {
        await c.query(
          `DELETE FROM idempotency_keys
            WHERE tenant_id = $1 AND key = $2 AND route = $3 AND status = 'in_progress'`,
          [scope.tenantId, key, routeName],
        );
      });
    }

    return response;
  };
}

/** Surfaced for tests and the reaper job. */
export const IDEMPOTENCY_HEADER = HEADER;

/**
 * Delete keys older than the retention window. 24h is far longer than any
 * client retries and short enough that the table stays small.
 *
 * NOT implemented as an index with an expiry predicate: a key that is reused
 * after expiry must be treated as a FRESH request, not as a replay of a
 * response the caller has long since forgotten.
 */
export async function reapIdempotencyKeys(
  scope: Parameters<typeof withTenant>[0],
  olderThanHours = 24,
): Promise<number> {
  return withTenant(scope, async (c) => {
    const { rowCount } = await c.query(
      `DELETE FROM idempotency_keys
        WHERE created_at < now() - ($1 || ' hours')::interval`,
      [String(olderThanHours)],
    );
    return rowCount ?? 0;
  });
}

export { HttpError };
