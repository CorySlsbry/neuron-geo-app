import "server-only";
import { Pool, type PoolClient } from "pg";

/**
 * The publishing worker's database connection.
 *
 * ⛔ IT IS A SEPARATE POOL, ON A SEPARATE DSN, AS A SEPARATE ROLE, AND ALL
 * THREE MATTER.
 *
 * `getPool()` connects as `app_user`, which sees exactly one tenant and has no
 * EXECUTE on any of the job functions. The worker connects as `app_worker`,
 * which sees the whole queue. Sharing a pool would mean a stray web request
 * could land on a connection holding queue-wide visibility, and the difference
 * between the two principals — the entire point of migration 0005 — would come
 * down to which connection the pool happened to hand out.
 *
 * So the web tier cannot reach this file (nothing in `src/app` imports it) and
 * the worker cannot reach `getPool()` (it runs from `scripts/worker.ts`, which
 * imports only this).
 */
let _pool: Pool | undefined;

export class WorkerConfigError extends Error {}

/**
 * The worker's DSN. Deliberately its OWN variable rather than falling back to
 * DATABASE_URL: a fallback would silently run the worker as `app_user`, where
 * every job function is a permission error and the queue looks permanently
 * empty. An empty queue is indistinguishable from a quiet night, so this
 * failure has to be loud at startup rather than invisible at runtime.
 */
function workerDsn(): string {
  const url = process.env.WORKER_DATABASE_URL;
  if (!url) {
    throw new WorkerConfigError(
      "WORKER_DATABASE_URL is not set. The worker connects as app_worker, " +
        "not as app_user, and there is deliberately no fallback: running it " +
        "on the app's DSN would make every job function a permission error " +
        "and the queue would just look empty.",
    );
  }
  return url;
}

export function getWorkerPool(): Pool {
  if (!_pool) {
    _pool = new Pool({
      connectionString: workerDsn(),
      // Small on purpose. The worker's concurrency is the number of jobs it
      // leases, not the number of connections it can open.
      max: 4,
      connectionTimeoutMillis: 5_000,
      idleTimeoutMillis: 30_000,
    });
  }
  return _pool;
}

export async function closeWorkerPool(): Promise<void> {
  if (_pool) {
    await _pool.end();
    _pool = undefined;
  }
}

/**
 * Runs `fn` in one transaction on a worker connection.
 *
 * No scope is set here, and that is correct: `app.claim_next_job()` sets
 * `app.current_tenant` itself, from the row it claimed. A worker that has not
 * claimed anything has no tenant, and therefore sees no tenant data at all —
 * the same fail-closed direction as every other role in the schema.
 */
export async function withWorker<T>(
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await getWorkerPool().connect();
  try {
    await client.query("BEGIN");
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
 * A worker transaction scoped to one tenant.
 *
 * ⛔ `tenantId` MUST come from a job row this worker has already claimed —
 * never from an argument that originated outside the worker, and never from
 * anything a provider sent back. That is the same rule the OAuth callback
 * follows (resolve the tenant from the session, not from the payload), and it
 * is why `claim_next_job` returns the tenant instead of taking one.
 *
 * It exists because claiming and publishing are deliberately SEPARATE
 * transactions: the claim has to commit so the lease is visible to other
 * workers, and a network call must never be made with a transaction held
 * open. The GUC set by the claim dies with its transaction, so the work that
 * follows re-establishes it here.
 */
export async function withWorkerTenant<T>(
  tenantId: string,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  return withWorker(async (client) => {
    await client.query("SELECT set_config('app.current_tenant', $1, true)", [tenantId]);
    return fn(client);
  });
}
