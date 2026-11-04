import "server-only";
import type { PoolClient } from "pg";
import { getPool } from "./pool";

export interface Principal {
  /** Authenticated Identity Platform uid — set by the server from the verified
   *  session, NEVER from a client-supplied claim. */
  uid: string;
}

export interface TenantScope extends Principal {
  /** The tenant this unit of work may touch. */
  tenantId: string;
  /** Department keys the principal may see (e.g. ["content-team"]). Any
   *  walled module is further row-scoped by this set. */
  departments?: string[];
}

async function setScope(
  client: PoolClient,
  uid: string,
  tenantId: string | null,
  departments: readonly string[] | null,
): Promise<void> {
  await client.query("SELECT set_config('app.current_uid', $1, true)", [uid]);
  await client.query("SELECT set_config('app.current_tenant', $1, true)", [
    tenantId ?? "",
  ]);
  await client.query(
    "SELECT set_config('app.current_departments', $1, true)",
    [(departments ?? []).join(",")],
  );
}

/**
 * Runs `fn` with ONLY the principal (uid) in scope — no tenant. Used for the
 * pre-tenant directory lookup that resolves which tenants the user belongs to
 * (the `memberships` self-read policy keys on `app.current_uid`).
 */
export async function withUid<T>(
  uid: string,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    await setScope(client, uid, null, null);
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Runs `fn` inside a transaction with the full scope (uid + tenant +
 * departments) set as transaction-LOCAL GUCs. Because they are `SET LOCAL`,
 * they clear at COMMIT/ROLLBACK and can never leak across pooled connections.
 *
 * RLS policies read these via `app.current_tenant()` / `app.current_uid()` /
 * `app.current_departments()`; an unset tenant scope yields NULL → zero rows
 * (fail-closed). The scope MUST come from the server-resolved directory
 * (memberships / member_department_access), never a client token claim.
 */
export async function withTenant<T>(
  scope: TenantScope,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    await setScope(client, scope.uid, scope.tenantId, scope.departments ?? []);
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

/**
 * The same tenant scope, but for a response that STREAMS.
 *
 * ── Why this exists at all ────────────────────────────────────────────────
 * `withTenant` owns the connection for exactly as long as `fn` runs, which is
 * the right shape for every request that computes an answer and returns it. A
 * streamed response inverts that: the handler returns immediately and the rows
 * are still being read minutes later, so the transaction has to outlive the
 * function that opened it.
 *
 * ⛔ It lives HERE, next to `withTenant`, on purpose. This is the one piece of
 * code in the system that opens a tenant-scoped transaction by hand, and the
 * failure mode if it is wrong is not a crash — it is a query running with NO
 * `app.current_tenant`, which RLS answers with somebody else's silence or,
 * worse, nothing at all. Putting it in the export module would have hidden a
 * security-critical lifecycle inside a feature.
 *
 * The contract, which the caller cannot opt out of:
 *   - the scope is set with the SAME `setScope` the normal path uses
 *   - the transaction is READ ONLY, so a streaming reader cannot write
 *   - the connection is released exactly once, on completion OR cancellation
 *     OR error — a browser closing the tab mid-download must not leak a
 *     connection out of a pool this small
 */
export function streamWithTenant(
  scope: TenantScope,
  rows: (client: PoolClient) => AsyncIterable<Uint8Array>,
): ReadableStream<Uint8Array> {
  let client: PoolClient | null = null;
  let released = false;

  /** Release once, whatever happens. Called from every exit path. */
  const done = async () => {
    if (released || !client) return;
    released = true;
    try {
      await client.query("ROLLBACK");
    } catch {
      // A rolled-back or already-dead transaction is fine; the point of this
      // call is to leave the connection clean, not to succeed.
    } finally {
      client.release();
      client = null;
    }
  };

  let iterator: AsyncIterator<Uint8Array> | null = null;

  return new ReadableStream<Uint8Array>({
    async start() {
      client = await getPool().connect();
      // READ ONLY is belt and braces: this path exists to read a lot of rows,
      // and a transaction that cannot write cannot be talked into writing.
      await client.query("BEGIN READ ONLY");
      await setScope(client, scope.uid, scope.tenantId, scope.departments ?? []);
      iterator = rows(client)[Symbol.asyncIterator]();
    },
    async pull(controller) {
      try {
        const next = await iterator!.next();
        if (next.done) {
          await done();
          controller.close();
          return;
        }
        controller.enqueue(next.value);
      } catch (err) {
        await done();
        controller.error(err);
      }
    },
    async cancel() {
      // The tab closed, or the download was aborted. Without this the
      // connection sits in the pool holding an open transaction.
      try {
        await iterator?.return?.();
      } finally {
        await done();
      }
    },
  });
}
