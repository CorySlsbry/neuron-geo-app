// channels module — public port.
//
// Connecting a real social account through that network's OWN OAuth dialog,
// sealing the resulting token, and disconnecting again. Every per-provider
// difference is data in internal/networks.ts, so adding Meta or TikTok is
// two env vars and a table row — not a second code path.
//
// A network without credentials in the environment is reported as
// `configured: false` with a plain reason, and the screen renders its Connect
// button disabled. A button that fails after the click is the one outcome
// this module exists to prevent.
import "server-only";

export { ChannelError } from "./internal/oauth";
export {
  buildAuthorizeUrl,
  clearPending,
  exchangeCode,
  resolveIdentity,
  takePending,
} from "./internal/oauth";
export type { TokenGrant } from "./internal/oauth";

export { generateKey, sealingAvailable } from "./internal/crypto";

export { isNetwork, networkLabel, NETWORKS, redirectUriFor } from "./internal/networks";
export type { ChannelIdentity, Network, NetworkAvailability } from "./internal/networks";

export {
  connectedChannelCount,
  readAccessToken,
  disconnectChannel,
  listChannelCards,
  listChannels,
  saveConnection,
} from "./internal/store";
export type { Channel, ChannelCard } from "./internal/store";
