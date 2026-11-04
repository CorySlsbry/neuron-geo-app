import "server-only";
import { withTenant, type TenantScope } from "@/lib/db/tenant";
import { HttpError } from "@/lib/http/errors";

export class AccountError extends HttpError {
  constructor(status: 400 | 403 | 404 | 409, code: string) {
    super(status, code);
  }
}

// Self-service data ownership: download everything, delete everything.
// Both run under the tenant's OWN scope — the export can only ever read
// rows RLS already allows, so a cross-tenant export is impossible by
// construction rather than by a WHERE clause we remembered to write.

/**
 * The tables to export/preview, discovered at runtime: every table in
 * `public` that carries a tenant_id column.
 *
 * This used to be a hand-written list. It drifted — a table added to the
 * schema was simply absent from "download everything", and nothing failed.
 * Asking the catalog cannot drift, and it matches how app.purge_current_tenant()
 * decides what to delete, so export and delete always agree on scope.
 */
async function tenantTables(c: {
  query: (q: string) => Promise<{ rows: { table_name: string }[] }>;
}): Promise<string[]> {
  const r = await c.query(`
    SELECT c.relname AS table_name
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      JOIN pg_attribute a ON a.attrelid = c.oid
     WHERE n.nspname = 'public'
       AND c.relkind = 'r'
       AND a.attname = 'tenant_id'
       AND a.attnum > 0
       AND NOT a.attisdropped
     ORDER BY c.relname
  `);
  return r.rows.map((row) => row.table_name);
}

/**
 * Read one table with its own savepoint.
 *
 * The savepoint is the whole point: in Postgres, ONE failed statement aborts
 * the entire transaction, so a bare try/catch around a per-table query does
 * not isolate anything — it swallows the error and every later table fails
 * too, silently. That is exactly how the export shipped a ZIP containing
 * four tables and no books at all. A savepoint makes the skip real, and the
 * caller reports what was skipped instead of pretending it exported it.
 */
async function readTable(
  c: { query: (q: string) => Promise<{ rows: Record<string, unknown>[] }> },
  table: string,
  sql: string,
): Promise<Record<string, unknown>[] | null> {
  await c.query("SAVEPOINT tbl");
  try {
    const r = await c.query(sql);
    await c.query("RELEASE SAVEPOINT tbl");
    return r.rows;
  } catch {
    await c.query("ROLLBACK TO SAVEPOINT tbl");
    return null;
  }
}

export interface DeletionPreview {
  tenantName: string;
  rowCounts: { table: string; rows: number }[];
  totalRows: number;
}

/** What deletion will destroy — shown before the typed confirmation. */
export async function deletionPreview(scope: TenantScope): Promise<DeletionPreview> {
  return withTenant(scope, async (c) => {
    // tenants is member-read RLS — this MUST run inside the scope, not on
    // the raw pool, or the name comes back empty and the typed confirmation
    // becomes impossible. (Found by live probe 2026-07-24.)
    const name = await c.query<{ name: string }>(`SELECT name FROM tenants WHERE id = $1`, [
      scope.tenantId,
    ]);
    const rowCounts: { table: string; rows: number }[] = [];
    let total = 0;
    for (const table of await tenantTables(c)) {
      const rows = await readTable(c, table, `SELECT count(*) AS n FROM ${table}`);
      if (rows === null) continue;
      const n = Number((rows[0] as { n: string }).n);
      if (n > 0) {
        rowCounts.push({ table, rows: n });
        total += n;
      }
    }
    return {
      tenantName: name.rows[0]?.name ?? "your business",
      rowCounts,
      totalRows: total,
    };
  });
}

/**
 * Delete everything, for real. Requires the typed business name (a slip of
 * the mouse can't do this), cancels the subscription first, and runs the
 * whole cascade in ONE transaction with the ledger-purge hatch open — so
 * the append-only money tables can finally be removed for a customer who
 * asked to be forgotten, and only then.
 */
export async function deleteEverything(
  scope: TenantScope,
  typedName: string,
): Promise<{ deleted: number }> {
  const actual = await withTenant(scope, async (c) => {
    const t = await c.query<{ name: string }>(`SELECT name FROM tenants WHERE id = $1`, [
      scope.tenantId,
    ]);
    return t.rows[0]?.name;
  });
  if (!actual) throw new AccountError(404, "tenant_not_found");
  if (typedName.trim() !== actual.trim()) throw new AccountError(400, "name_mismatch");

  // The purge runs inside the tenant's own scope via a definer function
  // that takes NO tenant argument — it can only ever delete the tenant the
  // session is already scoped to, so it cannot be aimed at anyone else.
  const deleted = await withTenant(scope, async (c) => {
    const r = await c.query<{ purge: string }>(
      "SELECT app.purge_current_tenant() AS purge",
    );
    return Number(r.rows[0]!.purge);
  });
  return { deleted };
}
