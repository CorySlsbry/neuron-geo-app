/**
 * Is the publishing fleet actually working?
 *
 * ⛔ PURE, FOR THE SAME REASON `decidePublish` IS PURE. A health check is a
 * thing you trust when it is quiet, which makes it exactly the kind of code
 * that must be shown able to say NO. Tested against a value, this verdict has
 * an assertion for every unhealthy shape; buried inside a script that talks to
 * a database it would only ever be observed returning "ok".
 *
 * ⛔ AND THE FAILURE THIS EXISTS TO CATCH IS SILENCE. An empty queue and a dead
 * worker look identical from the outside: nothing is happening either way. The
 * difference is whether anything is WAITING, so every rule below is stated in
 * terms of work waiting versus workers reporting, never in terms of one alone.
 */

export interface WorkerRow {
  workerId: string;
  hostname: string | null;
  /** Seconds since this worker last checked in. */
  lastSeenSecondsAgo: number;
  currentJob: string | null;
}

export interface FleetSnapshot {
  workers: WorkerRow[];
  queue: {
    queued: number;
    running: number;
    succeeded: number;
    failed: number;
    dead: number;
  };
  /** Age of the oldest job still waiting to be claimed, or null if none is. */
  oldestQueuedSeconds: number | null;
  /** Running jobs whose lease has passed. Each one means a worker died. */
  expiredLeases: number;
}

export type HealthLevel = "ok" | "warn" | "down";

export interface Health {
  level: HealthLevel;
  /** Plain lines, worst first. Written to be read at 3am. */
  lines: string[];
}

export interface HealthThresholds {
  /** A worker quieter than this is presumed gone. Default 5 minutes. */
  staleAfterSeconds?: number;
  /** Work waiting longer than this is a backlog. Default 15 minutes. */
  backlogAfterSeconds?: number;
}

export function assessFleet(s: FleetSnapshot, t: HealthThresholds = {}): Health {
  const staleAfter = t.staleAfterSeconds ?? 300;
  const backlogAfter = t.backlogAfterSeconds ?? 900;

  const waiting = s.queue.queued + s.queue.running;
  const live = s.workers.filter((w) => w.lastSeenSecondsAgo <= staleAfter);

  const down: string[] = [];
  const warn: string[] = [];

  // ---- the silence cases -------------------------------------------------
  if (s.workers.length === 0) {
    // No worker has EVER checked in. Only urgent if something is waiting for
    // one; otherwise it is an idle deployment, which is a normal state.
    (waiting > 0 ? down : warn).push(
      waiting > 0
        ? `No worker has ever checked in, and ${waiting} job(s) are waiting. Nothing will publish.`
        : "No worker has ever checked in. Nothing is waiting, so nothing is stuck.",
    );
  } else if (live.length === 0) {
    const quietest = Math.min(...s.workers.map((w) => w.lastSeenSecondsAgo));
    (waiting > 0 ? down : warn).push(
      `Every worker is silent (quietest checked in ${fmt(quietest)} ago)` +
        (waiting > 0
          ? `, and ${waiting} job(s) are waiting. Nothing will publish.`
          : ". Nothing is waiting, so nothing is stuck."),
    );
  }

  // ---- a worker died mid-job --------------------------------------------
  if (s.expiredLeases > 0) {
    warn.push(
      `${s.expiredLeases} job(s) hold an expired lease: a worker stopped ` +
        "mid-flight. They return to the queue on the next idle pass.",
    );
  }

  // ---- work is waiting too long even though somebody is alive ------------
  if (
    s.oldestQueuedSeconds !== null &&
    s.oldestQueuedSeconds > backlogAfter &&
    live.length > 0
  ) {
    warn.push(
      `The oldest queued job has been waiting ${fmt(s.oldestQueuedSeconds)} ` +
        `with ${live.length} worker(s) alive. Something is refusing to drain.`,
    );
  }

  // ---- dead letters are a person's problem, by design --------------------
  if (s.queue.dead > 0) {
    warn.push(
      `${s.queue.dead} job(s) are dead-lettered and will not retry. ` +
        "Read their last_error; this is the state that exists to be looked at.",
    );
  }

  if (down.length > 0) return { level: "down", lines: [...down, ...warn] };
  if (warn.length > 0) return { level: "warn", lines: warn };
  return {
    level: "ok",
    lines: [
      `${live.length} worker(s) reporting, ${waiting} job(s) in flight, ` +
        `nothing stuck.`,
    ],
  };
}

function fmt(seconds: number): string {
  if (seconds < 90) return `${Math.round(seconds)}s`;
  if (seconds < 5400) return `${Math.round(seconds / 60)}m`;
  return `${(seconds / 3600).toFixed(1)}h`;
}
