// publishing module — public port.
//
// The path from an approved item to a real post, and the honest rehearsal of
// that path. Two halves that never share a database role:
//
//   the WEB tier  — `enqueuePublish`, `recentJobs`, `jobsForItem`. Runs as
//                   app_user, sees one tenant, and cannot claim or complete
//                   anything. A request handler that could mark work done
//                   could mark work done without doing it.
//
//   the WORKER    — `runOnce`, `checkIn`, `reapExpired`. Runs as app_worker
//                   from `scripts/worker.ts`, never from a request.
//
// ⛔ THREE INDEPENDENT THINGS MUST BE TRUE BEFORE ANYTHING REACHES A REAL
// PLATFORM, and each fails closed on its own:
//   1. the job row's `mode` says 'live' (the column default is 'dry_run');
//   2. PUBLISH_LIVE_ENABLED is exactly "true";
//   3. a stored credential exists AND opens with the current key.
// (3) is false for every network today — no OAuth client exists yet, so no
// token has ever been stored. Until one does, every job in this system is a
// rehearsal, and `decidePublish` is where you can read that as a value rather
// than infer it from control flow.
import "server-only";

export {
  PublishError,
  enqueuePublish,
  enqueuePublishOn,
  jobsForItem,
  publishModeForNewJobs,
  recentJobs,
} from "./internal/queue";
export type { JobStatus, PublishJob } from "./internal/queue";

export { checkIn, reapExpired, runOnce } from "./internal/worker";
export type { ClaimedJob, RunOptions, RunResult } from "./internal/worker";

export { decidePublish } from "./internal/decide";
export type { Decision, DecisionInput } from "./internal/decide";

export { SendError, prepare } from "./internal/senders";
export type { PreparedSend, SendRequest, SendResult } from "./internal/senders";
