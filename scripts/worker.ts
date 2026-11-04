/**
 * The publishing worker.
 *
 *   pnpm worker            # drain the queue, then keep polling
 *   pnpm worker --once     # claim at most one job and exit (the CI/dev shape)
 *   pnpm worker --drain    # work until the queue is empty, then exit
 *
 * Connects as `app_worker` via WORKER_DATABASE_URL. There is deliberately no
 * fallback to DATABASE_URL: running this on the app's role makes every job
 * function a permission error, and the queue would simply look empty — a
 * failure indistinguishable from a quiet night.
 *
 * ⛔ THIS PROCESS CANNOT POST ANYWHERE TODAY, and it says so at startup. Live
 * sends need `PUBLISH_LIVE_ENABLED=true` AND a stored credential that opens
 * with the current key. No OAuth client exists yet, so no token has ever been
 * stored, and every job it runs is a rehearsal that stops before the network.
 */
import { closeWorkerPool } from "../src/lib/db/worker";
import { checkIn, reapExpired, runOnce } from "../src/modules/publishing/internal/worker";
import { hostname } from "node:os";

const IDLE_SLEEP_MS = 5_000;

function log(msg: string, extra?: Record<string, unknown>): void {
  const line = { at: new Date().toISOString(), msg, ...extra };
  process.stdout.write(`${JSON.stringify(line)}\n`);
}

async function main(): Promise<number> {
  const once = process.argv.includes("--once");
  const drain = process.argv.includes("--drain");
  const workerId = process.env.WORKER_ID ?? `worker-${hostname()}-${process.pid}`;
  const liveEnabled = process.env.PUBLISH_LIVE_ENABLED === "true";

  // Say what this process can do BEFORE it does anything. An operator reading
  // the first line should never have to infer whether real posts are possible.
  log("worker starting", {
    workerId,
    mode: liveEnabled
      ? "LIVE ENABLED — jobs marked live may contact real platforms"
      : "rehearsal only — PUBLISH_LIVE_ENABLED is not \"true\", nothing can be sent",
  });

  await checkIn(workerId, hostname());

  let stopping = false;
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      if (stopping) return;
      stopping = true;
      // Finish the job in hand rather than dropping it. Anything still
      // running when the process dies is recovered by its lease expiring,
      // so a hard kill is survivable too — this is just the tidy path.
      log("stopping after the current job", { signal });
    });
  }

  let worked = 0;
  while (!stopping) {
    let result;
    try {
      result = await runOnce({ workerId });
    } catch (cause) {
      // A failure to even claim is infrastructure, not a job. Log and back
      // off; do not spin a tight loop against a database that is down.
      log("claim failed", { error: String(cause) });
      if (once || drain) return 1;
      await sleep(IDLE_SLEEP_MS);
      continue;
    }

    if (result.claimed) {
      worked += 1;
      log("job finished", {
        jobId: result.jobId,
        outcome: result.outcome,
        detail: result.detail,
      });
      if (once) break;
      continue;
    }

    // Idle. Return any abandoned work to the queue before sleeping — this is
    // the only thing that recovers a job whose worker died mid-flight.
    const reaped = await reapExpired().catch(() => 0);
    if (reaped > 0) {
      log("returned abandoned jobs to the queue", { count: reaped });
      continue;
    }

    if (once || drain) break;
    await sleep(IDLE_SLEEP_MS);
  }

  log("worker stopped", { jobsHandled: worked });
  return 0;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main()
  .then(async (code) => {
    await closeWorkerPool();
    process.exit(code);
  })
  .catch(async (err) => {
    log("worker crashed", { error: String(err) });
    await closeWorkerPool().catch(() => {});
    process.exit(1);
  });
