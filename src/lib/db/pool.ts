import "server-only";
import { Pool } from "pg";
import { requireDatabaseUrl } from "@/env";

let _pool: Pool | undefined;

/**
 * The shared pg Pool. The app connects as a NON-superuser role (no BYPASSRLS)
 * in every environment — RLS is the tenant/department boundary, so the app
 * must never hold a role that can bypass it.
 */
export function getPool(): Pool {
  if (!_pool) {
    _pool = new Pool({
      connectionString: requireDatabaseUrl(),
      max: 10,
      // Fail fast rather than hang a request on a dead DB.
      connectionTimeoutMillis: 5_000,
      idleTimeoutMillis: 30_000,
    });
  }
  return _pool;
}

export async function closePool(): Promise<void> {
  if (_pool) {
    await _pool.end();
    _pool = undefined;
  }
}
