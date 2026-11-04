// content module — public port.
//
// The approval queue: what the generator produced, what is waiting on a
// person, and the one transition a person performs (approve / reject).
//
// ⛔ Nothing here publishes, and nothing here writes `published`. Approval
// stops at `approved` because publishing is a later phase — an approve that
// pretended to publish would put a lie on the platform-review recording that
// this whole surface exists to make truthful.
import "server-only";

export {
  ContentError,
  counts,
  decide,
  listDecided,
  listQueue,
  seedSamples,
} from "./internal/store";
export type {
  ContentCounts,
  ContentItem,
  ContentKind,
  ContentStatus,
  ReviewDecision,
  ReviewOutcome,
} from "./internal/store";
