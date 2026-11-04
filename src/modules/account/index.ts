// account module — public port.
//
// Data ownership, self-service: download everything (one ZIP, one CSV per
// table, read under the tenant's own RLS scope so a cross-tenant export is
// impossible by construction) and delete everything (typed confirmation,
// subscription canceled, then a definer purge bound to the session's own
// tenant — the only path that may touch the append-only money tables).
import "server-only";

export {
  AccountError,
  deleteEverything,
  deletionPreview,
} from "./internal/store";
export type { DeletionPreview } from "./internal/store";

// The streamed export — one server-side cursor per table, flat memory no
// matter how much history the tenant has. (The old buffered exportEverything
// went with the construction domain; the route always used this one.)
export { streamExport } from "./internal/export-stream";
