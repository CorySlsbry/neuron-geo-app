/**
 * Operator status: is the publishing fleet alive, and is anything stuck?
 *
 *   pnpm ops:status          # human-readable
 *   pnpm ops:status --json   # for a monitor
 *
 * Exit code is the point: **0 ok, 1 warn, 2 down**, so this works as a health
 * probe and not only as something to read.
 *
 * ⛔ WHY THIS IS A SCRIPT AND NOT A SCREEN. The obvious place for "worker
 * health" is an admin page, and there is deliberately no admin principal in
 * this app to put one behind. `job_workers` has NO `app_user` policy at all —
 * the customer app cannot read the fleet, by design — and inventing a
 * cross-tenant web surface to show it would undo the isolation the whole
 * schema exists to enforce. So it runs as `app_worker`, from an operator's
 * own machine, over the same DSN the worker uses.
 *
 * ⛔ AND IT SHOWS NO CUSTOMER CONTENT. Per-tenant lines carry a tenant id and
 * counts. No titles, no bodies, no handles, no tokens. An operator needs to
 * know WHICH tenant is stuck, never WHAT they wrote.
 */
import { closeWorkerPool, withWorker } from "../src/lib/db/worker";
import { assessFleet, type FleetSnapshot } from "../src/modules/publishing/internal/health";

async function snapshot(): Promise<FleetSnapshot & { perTenant: TenantRow[]; dead: DeadRow[] }> {
  return withWorker(async (c) => {
    const workers = await c.query<{
      worker_id: string;
      hostname: string | null;
      seconds_ago: number;
      current_job: string | null;
    }>(`SELECT worker_id, hostname, current_job,
               EXTRACT(EPOCH FROM (now() - last_seen_at))::float8 AS seconds_ago
          FROM job_workers ORDER BY last_seen_at DESC`);

    // One pass for every counter, so the numbers cannot disagree with each
    // other by being read at different instants.
    const q = await c.query<{
      queued: string; running: string; succeeded: string;
      failed: string; dead: string; oldest: number | null; expired: string;
    }>(`SELECT
          count(*) FILTER (WHERE status = 'queued')    AS queued,
          count(*) FILTER (WHERE status = 'running')   AS running,
          count(*) FILTER (WHERE status = 'succeeded') AS succeeded,
          count(*) FILTER (WHERE status = 'failed')    AS failed,
          count(*) FILTER (WHERE status = 'dead')      AS dead,
          EXTRACT(EPOCH FROM (now() - min(created_at) FILTER (WHERE status = 'queued')))::float8 AS oldest,
          count(*) FILTER (WHERE status = 'running' AND lease_expires_at < now()) AS expired
        FROM jobs`);
    const r = q.rows[0]!;

    const perTenant = await c.query<TenantRow>(
      `SELECT tenant_id::text AS tenant_id,
              count(*) FILTER (WHERE status IN ('queued','running'))::int AS in_flight,
              count(*) FILTER (WHERE status = 'dead')::int AS dead,
              count(*) FILTER (WHERE status = 'succeeded')::int AS done
         FROM jobs GROUP BY tenant_id
         HAVING count(*) FILTER (WHERE status IN ('queued','running','dead')) > 0
         ORDER BY 2 DESC, 3 DESC`,
    );

    const dead = await c.query<DeadRow>(
      `SELECT id::text AS id, tenant_id::text AS tenant_id, mode,
              left(coalesce(last_error, ''), 120) AS last_error
         FROM jobs WHERE status = 'dead'
         ORDER BY finished_at DESC NULLS LAST LIMIT 10`,
    );

    return {
      workers: workers.rows.map((w) => ({
        workerId: w.worker_id,
        hostname: w.hostname,
        lastSeenSecondsAgo: w.seconds_ago,
        currentJob: w.current_job,
      })),
      queue: {
        queued: Number(r.queued), running: Number(r.running),
        succeeded: Number(r.succeeded), failed: Number(r.failed),
        dead: Number(r.dead),
      },
      oldestQueuedSeconds: r.oldest,
      expiredLeases: Number(r.expired),
      perTenant: perTenant.rows,
      dead: dead.rows,
    };
  });
}

interface TenantRow { tenant_id: string; in_flight: number; dead: number; done: number }
interface DeadRow { id: string; tenant_id: string; mode: string; last_error: string }

async function main(): Promise<number> {
  const asJson = process.argv.includes("--json");
  const s = await snapshot();
  const health = assessFleet(s);

  if (asJson) {
    process.stdout.write(`${JSON.stringify({ health, ...s }, null, 2)}\n`);
  } else {
    const mark = health.level === "ok" ? "OK" : health.level === "warn" ? "WARN" : "DOWN";
    process.stdout.write(`\n[${mark}] publishing fleet\n`);
    for (const line of health.lines) process.stdout.write(`  ${line}\n`);

    process.stdout.write(`\nWorkers (${s.workers.length})\n`);
    if (s.workers.length === 0) {
      // Not "0 healthy". Nothing has ever reported, and saying it that way is
      // the difference between a fact and an inference.
      process.stdout.write("  none has ever checked in\n");
    }
    for (const w of s.workers) {
      process.stdout.write(
        `  ${w.workerId} (${w.hostname ?? "unknown host"}) last seen ` +
          `${Math.round(w.lastSeenSecondsAgo)}s ago` +
          `${w.currentJob ? ` — on job ${w.currentJob.slice(0, 8)}` : ""}\n`,
      );
    }

    const q = s.queue;
    process.stdout.write(
      `\nQueue\n  queued ${q.queued} · running ${q.running} · succeeded ${q.succeeded}` +
        ` · failed ${q.failed} · dead ${q.dead}\n`,
    );

    if (s.perTenant.length > 0) {
      process.stdout.write("\nBy tenant (ids and counts only, never content)\n");
      for (const t of s.perTenant) {
        process.stdout.write(
          `  ${t.tenant_id}  in-flight ${t.in_flight} · dead ${t.dead} · done ${t.done}\n`,
        );
      }
    }

    if (s.dead.length > 0) {
      process.stdout.write("\nDead letters (newest first)\n");
      for (const d of s.dead) {
        process.stdout.write(`  ${d.id.slice(0, 8)} [${d.mode}] ${d.last_error}\n`);
      }
    }
    process.stdout.write("\n");
  }

  return health.level === "down" ? 2 : health.level === "warn" ? 1 : 0;
}

main()
  .then(async (code) => {
    await closeWorkerPool();
    process.exit(code);
  })
  .catch(async (err) => {
    process.stderr.write(`ops:status failed: ${String(err)}\n`);
    await closeWorkerPool().catch(() => {});
    // A status check that cannot reach the database is not "ok" and not
    // "warn" — it knows nothing, which is the same operational position as
    // down.
    process.exit(2);
  });
