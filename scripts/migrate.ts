/**
 * Minimal forward-only SQL migration runner.
 *
 * Applies `migrations/*.sql` in filename order, each in its own transaction,
 * tracked in a `_migrations` table. Runs as MIGRATE_DATABASE_URL — a
 * superuser/owner role, NOT the app role — so migrations can create roles,
 * RLS policies, grants, and triggers. Migrations must be transaction-safe.
 *
 *   pnpm migrate          # apply pending
 *   pnpm migrate:status   # show applied / pending
 */
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Client } from "pg";

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(HERE, "..", "migrations");

function dsn(): string {
  const url = process.env.MIGRATE_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      "Set MIGRATE_DATABASE_URL (a superuser/owner DSN) to run migrations.",
    );
  }
  return url;
}

function migrationFiles(): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();
}

async function ensureTable(c: Client): Promise<void> {
  await c.query(
    `CREATE TABLE IF NOT EXISTS _migrations (
       id text PRIMARY KEY,
       applied_at timestamptz NOT NULL DEFAULT now()
     )`,
  );
}

async function appliedIds(c: Client): Promise<Set<string>> {
  const { rows } = await c.query<{ id: string }>("SELECT id FROM _migrations");
  return new Set(rows.map((r) => r.id));
}

async function up(): Promise<void> {
  const c = new Client({ connectionString: dsn() });
  await c.connect();
  try {
    await ensureTable(c);
    const done = await appliedIds(c);
    let n = 0;
    for (const file of migrationFiles()) {
      if (done.has(file)) continue;
      const sql = readFileSync(join(MIGRATIONS_DIR, file), "utf8");
      process.stdout.write(`applying ${file} ... `);
      await c.query("BEGIN");
      try {
        await c.query(sql);
        await c.query("INSERT INTO _migrations (id) VALUES ($1)", [file]);
        await c.query("COMMIT");
        console.log("ok");
        n += 1;
      } catch (err) {
        await c.query("ROLLBACK");
        console.log("FAILED");
        throw err;
      }
    }
    console.log(n === 0 ? "already up to date" : `applied ${n} migration(s)`);
  } finally {
    await c.end();
  }
}

async function status(): Promise<void> {
  const c = new Client({ connectionString: dsn() });
  await c.connect();
  try {
    await ensureTable(c);
    const done = await appliedIds(c);
    for (const file of migrationFiles()) {
      console.log(`${done.has(file) ? "[x]" : "[ ]"} ${file}`);
    }
  } finally {
    await c.end();
  }
}

const cmd = process.argv[2] ?? "up";
(cmd === "status" ? status : up)().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
