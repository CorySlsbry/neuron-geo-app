import "server-only";
import type { PoolClient } from "pg";
import { streamWithTenant, type TenantScope } from "@/lib/db/tenant";
import { streamZip, type StreamZipEntry } from "@/lib/zip-stream";
import { csvEscapeRow } from "./csv";

/**
 * "Download everything" — STREAMED, not buffered.
 *
 * ── What was wrong with the old one ───────────────────────────────────────
 * `exportEverything` read every tenant table fully into memory, built a
 * complete CSV string for each, concatenated the whole archive, and then
 * copied it again into a Buffer for the response. Four copies of a customer's
 * entire history, on a Cloud Run instance with 1 GiB.
 *
 * It worked, because it was only ever tested against a demo tenant with a few
 * hundred rows. The first real customer with a couple of years of history
 * would have OOM-killed the instance — and the request that does it is
 * "give me my data", the one request that must never fail, because a customer
 * doing it is often a customer leaving.
 *
 * ── The shape now ─────────────────────────────────────────────────────────
 * One server-side CURSOR per table, a batch of rows at a time, CSV encoded and
 * pushed straight into a streaming zip. Peak memory is one batch — a few
 * hundred rows — no matter how big the business is.
 *
 * The transaction is held open by `streamWithTenant` for the life of the
 * download, READ ONLY, with the tenant GUCs set by the same code path every
 * other query uses.
 */

/** Rows per FETCH. Big enough to be efficient, small enough to stay flat. */
const BATCH = 500;

/** Postgres identifier quoting for a name that came from the catalog. */
function ident(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

async function tableNames(c: PoolClient): Promise<string[]> {
  const r = await c.query<{ table_name: string }>(`
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

function cell(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (v instanceof Date) return v.toISOString();
  return typeof v === "object" ? JSON.stringify(v) : String(v);
}

/**
 * Stream one table as CSV chunks.
 *
 * A DECLARE/FETCH cursor rather than LIMIT/OFFSET: offset pagination re-scans
 * from the top on every page, so exporting a large table would get quadratically
 * slower exactly where it hurts. The cursor lives in the same transaction
 * `streamWithTenant` opened, so it sees the same tenant scope.
 */
async function* tableCsv(
  c: PoolClient,
  table: string,
  onCount: (table: string, rows: number) => void,
  onSkip: (table: string) => void,
): AsyncGenerator<Uint8Array> {
  const enc = new TextEncoder();
  const cursor = `exp_${table.replace(/[^a-z0-9_]/gi, "")}`;
  let declared = false;
  let rows = 0;

  try {
    // SAVEPOINT so a table this role genuinely cannot read (internal plumbing)
    // aborts only its own DECLARE, leaving the export transaction usable.
    await c.query("SAVEPOINT tbl");
    await c.query(`DECLARE ${cursor} NO SCROLL CURSOR FOR SELECT * FROM ${ident(table)}`);
    declared = true;

    let header: string[] | null = null;
    for (;;) {
      const batch = await c.query(`FETCH ${BATCH} FROM ${cursor}`);
      if (batch.rows.length === 0) break;
      if (!header) {
        header = batch.fields.map((f) => f.name);
        yield enc.encode(csvEscapeRow(header));
      }
      let out = "";
      for (const row of batch.rows as Record<string, unknown>[]) {
        out += csvEscapeRow(header.map((h) => cell(row[h])));
      }
      rows += batch.rows.length;
      yield enc.encode(out);
    }
    // An empty table still gets a file, with its header. A missing file reads
    // as "we lost your data"; an empty one reads as "you have none".
    if (!header) {
      const cols = await c.query(
        `SELECT column_name FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = $1
          ORDER BY ordinal_position`,
        [table],
      );
      yield enc.encode(csvEscapeRow(cols.rows.map((r) => String(r.column_name))));
    }
    onCount(table, rows);
  } catch {
    await c.query("ROLLBACK TO SAVEPOINT tbl");
    onSkip(table);
    return;
  } finally {
    if (declared) {
      await c.query(`CLOSE ${cursor}`).catch(() => {});
    }
    await c.query("RELEASE SAVEPOINT tbl").catch(() => {});
  }
}

/**
 * The whole export, as a stream of zip bytes.
 *
 * README goes LAST on purpose: it carries the row counts, and those are only
 * known once every table has been read. A zip's central directory is written
 * at the end anyway, so ordering costs nothing.
 */
export function streamExport(scope: TenantScope): ReadableStream<Uint8Array> {
  return streamWithTenant(scope, (client) => zipBytes(client));
}

async function* zipBytes(client: PoolClient): AsyncGenerator<Uint8Array> {
  const counts: string[] = [];
  const skipped: string[] = [];

  async function* entries(): AsyncGenerator<StreamZipEntry> {
    const tables = await tableNames(client);
    for (const table of tables) {
      yield {
        name: `${table}.csv`,
        chunks: tableCsv(
          client,
          table,
          (t, n) => counts.push(`${t}: ${n}`),
          (t) => skipped.push(t),
        ),
      };
    }
    yield {
      name: "README.txt",
      chunks: (async function* () {
        yield new TextEncoder().encode(readme(counts, skipped));
      })(),
    };
  }

  yield* streamZip(entries());
}

function readme(counts: string[], skipped: string[]): string {
  return [
    "Your data: everything we hold for your business.",
    "",
    "One CSV per table. Open them in Excel or Google Sheets, or hand the",
    "whole folder to whoever you like. This export works forever, with or",
    "without a subscription.",
    "",
    `Exported ${new Date().toISOString()}`,
    "",
    "Row counts:",
    ...counts.map((c) => `  ${c}`),
    ...(skipped.length
      ? [
          "",
          "Not included (internal plumbing your account can't read;",
          "these hold no business data of yours):",
          ...skipped.map((t) => `  ${t}`),
        ]
      : []),
  ].join("\n");
}
