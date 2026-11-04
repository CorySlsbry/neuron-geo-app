import "server-only";
import { withTenant, type TenantScope } from "@/lib/db/tenant";
import { CURRENT_KEY_VERSION, open, seal } from "./crypto";
import { ChannelError, revokeAtProvider, type TokenGrant } from "./oauth";
import { availability, isNetwork, NETWORKS, type ChannelIdentity, type Network, type NetworkAvailability } from "./networks";

/** One connected (or previously connected) account, as the screen sees it. */
export interface Channel {
  id: string;
  network: Network;
  handle: string | null;
  accountId: string;
  status: "connected" | "disconnected" | "error";
  scopes: string[];
  connectedAt: string | null;
  disconnectedAt: string | null;
  lastError: string | null;
}

interface ChannelRow {
  id: string;
  network: string;
  handle: string | null;
  account_id: string;
  status: string;
  scopes: string[] | null;
  connected_at: string | null;
  disconnected_at: string | null;
  last_error: string | null;
}

function toChannel(r: ChannelRow): Channel {
  return {
    id: r.id,
    // The CHECK constraint already closed this vocabulary in the database;
    // the guard is here so a row written by some future migration cannot
    // widen the client-facing type without this failing loudly first.
    network: isNetwork(r.network) ? r.network : "youtube",
    handle: r.handle,
    accountId: r.account_id,
    status: r.status === "connected" || r.status === "error" ? r.status : "disconnected",
    scopes: r.scopes ?? [],
    connectedAt: r.connected_at,
    disconnectedAt: r.disconnected_at,
    lastError: r.last_error,
  };
}

const SELECT_COLUMNS = `
  id, network, handle, account_id, status, scopes,
  connected_at::text AS connected_at,
  disconnected_at::text AS disconnected_at,
  last_error`;

/**
 * Unseal a stored credential and return its access token, or null.
 *
 * ⛔ THE ONE PLACE THAT KNOWS THE SEALED PAYLOAD'S SHAPE, and it is a shared
 * function for a reason that already bit once: the field is `access`, and a
 * second reader written from memory used `accessToken` instead. That does not
 * throw and does not fail a type check — it silently yields null, which every
 * caller correctly treats as "no usable credential". The result is a publish
 * path that refuses every valid token while reporting exactly the message it
 * would report if the customer had never connected an account.
 *
 * Null covers three cases deliberately made indistinguishable: no payload, a
 * payload sealed with a retired key, and a corrupted row. None of them can
 * publish, and none of them is the caller's business to tell apart.
 */
export function readAccessToken(sealed: Buffer): string | null {
  try {
    const payload: SealedTokens = JSON.parse(open(sealed.toString("utf8")));
    return payload.access ?? null;
  } catch {
    return null;
  }
}

/**
 * ⛔ THE SEALED PAYLOAD'S SHAPE, DECLARED ONCE AND USED BY BOTH SIDES.
 *
 * `saveConnection` seals it and `readAccessToken` opens it, and they now share
 * this declaration rather than each writing an object literal from memory. The
 * field is `access`, not `accessToken` — a second reader that guessed the
 * latter type-checked, never threw, and returned null, which every caller
 * correctly treats as "no credential stored". That is a publish path refusing
 * every valid token while reporting exactly the message it gives when nobody
 * has connected an account.
 *
 * The rule this exists to make mechanical: never re-declare a shape someone
 * else already reads. `shape-guard.test.ts` enforces it.
 */
export interface SealedTokens {
  access?: string;
  /** Nullable, not merely optional: `TokenGrant.refreshToken` is `string |
   *  null` for providers that do not issue one. Declaring it `string |
   *  undefined` made the writer fail to compile the moment the two sides were
   *  forced to share a type, which is the whole argument for sharing it. */
  refresh?: string | null;
}

/** Every channel row this tenant has, newest connection first. */
export async function listChannels(scope: TenantScope): Promise<Channel[]> {
  return withTenant(scope, async (c) => {
    const { rows } = await c.query<ChannelRow>(
      `SELECT ${SELECT_COLUMNS} FROM tenant_channels
        ORDER BY connected_at DESC NULLS LAST, network`,
    );
    return rows.map(toChannel);
  });
}

/** One card per network: what it is, whether it can be connected, and the
 *  tenant's channel on it if there is one. The shape the screen renders. */
export interface ChannelCard extends NetworkAvailability {
  channel: Channel | null;
}

export async function listChannelCards(scope: TenantScope): Promise<ChannelCard[]> {
  const channels = await listChannels(scope);
  return NETWORKS.map((network) => ({
    ...availability(network),
    // The live one wins when a tenant has connected the same network twice
    // (two accounts, or a reconnect after a disconnect) — the card is about
    // "is this network working right now", and a stale disconnected row must
    // not be what the customer sees while a connected one exists.
    channel:
      channels.find((ch) => ch.network === network && ch.status === "connected") ??
      channels.find((ch) => ch.network === network) ??
      null,
  }));
}

/**
 * Record a completed connection: the channel row and its sealed token, in ONE
 * transaction.
 *
 * Atomic on purpose. A channel row saying "connected" with no credential
 * beside it is a lie the customer can see — the card shows a live connection
 * that cannot publish anything — and it is the exact state a two-transaction
 * version leaves behind whenever the second one fails.
 *
 * Reconnecting the SAME account updates the row we already have. That is what
 * the (tenant_id, network, account_id) key is for: clicking Connect twice, or
 * re-authorising after adding a scope, must not grow a second card.
 */
export async function saveConnection(
  scope: TenantScope,
  network: Network,
  identity: ChannelIdentity,
  grant: TokenGrant,
): Promise<Channel> {
  // Both halves of the grant are sealed together. The refresh token is the
  // more valuable secret of the two — it is the one that does not expire —
  // so it never gets the weaker treatment of a separate plaintext column.
  // Typed on the way IN as well as on the way out. This is the writer half of
  // the one shared declaration; an object literal here would let the two sides
  // drift silently, which is exactly how the `accessToken` bug happened.
  const tokens: SealedTokens = {
    access: grant.accessToken,
    refresh: grant.refreshToken,
  };
  const sealed = seal(JSON.stringify(tokens));

  return withTenant(scope, async (c) => {
    const { rows } = await c.query<ChannelRow>(
      `INSERT INTO tenant_channels
         (tenant_id, network, handle, account_id, status, scopes, connected_at)
       VALUES ($1, $2, $3, $4, 'connected', $5, now())
       ON CONFLICT (tenant_id, network, account_id) DO UPDATE
         SET handle = EXCLUDED.handle,
             status = 'connected',
             scopes = EXCLUDED.scopes,
             connected_at = now(),
             disconnected_at = NULL,
             last_error = NULL
       RETURNING ${SELECT_COLUMNS}`,
      [scope.tenantId, network, identity.handle, identity.accountId, grant.scopes],
    );
    const row = rows[0];
    if (!row) throw new ChannelError(502, "channel_not_saved");

    await c.query(
      `INSERT INTO tenant_credentials
         (tenant_id, channel_id, enc_token, key_version, expires_at)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (channel_id) DO UPDATE
         SET enc_token   = EXCLUDED.enc_token,
             key_version = EXCLUDED.key_version,
             expires_at  = EXCLUDED.expires_at,
             rotated_at  = now()`,
      [scope.tenantId, row.id, Buffer.from(sealed, "utf8"), CURRENT_KEY_VERSION, grant.expiresAt],
    );

    await c.query(
      `INSERT INTO events (tenant_id, name, subject_type, subject_id, actor_uid, payload)
       VALUES ($1, 'channel_connected', 'tenant_channel', $2, $3, $4::jsonb)`,
      [scope.tenantId, row.id, scope.uid, JSON.stringify({ network, handle: identity.handle })],
    );

    return toChannel(row);
  });
}

/**
 * Disconnect: destroy our copy of the token, mark the channel, then ask the
 * provider to forget it.
 *
 * ⛔ THAT ORDER IS THE POINT. The local delete is what the customer was
 * promised and it is the half we control, so it commits first and
 * unconditionally. The provider call is a courtesy that can hang, rate-limit
 * or 500, and a customer who wants out must not be held hostage by somebody
 * else's outage. The reverse order — revoke, then delete — leaves a
 * decryptable token in our table every time the provider is slow.
 */
export async function disconnectChannel(
  scope: TenantScope,
  channelId: string,
): Promise<{ revokedAtProvider: boolean }> {
  const found = await withTenant(scope, async (c) => {
    const { rows } = await c.query<{ network: string; enc_token: Buffer | null }>(
      `SELECT ch.network, cr.enc_token
         FROM tenant_channels ch
         LEFT JOIN tenant_credentials cr ON cr.channel_id = ch.id
        WHERE ch.id = $1`,
      [channelId],
    );
    const row = rows[0];
    // RLS already made another tenant's channel invisible, so "not found" and
    // "not yours" are the same answer here — which is the answer we want.
    if (!row) throw new ChannelError(404, "channel_not_found");

    await c.query(`DELETE FROM tenant_credentials WHERE channel_id = $1`, [channelId]);
    await c.query(
      `UPDATE tenant_channels
          SET status = 'disconnected', disconnected_at = now(), last_error = NULL
        WHERE id = $1`,
      [channelId],
    );
    await c.query(
      `INSERT INTO events (tenant_id, name, subject_type, subject_id, actor_uid, payload)
       VALUES ($1, 'channel_disconnected', 'tenant_channel', $2, $3, $4::jsonb)`,
      [scope.tenantId, channelId, scope.uid, JSON.stringify({ network: row.network })],
    );
    return row;
  });

  if (!found.enc_token) return { revokedAtProvider: false };

  // The token we just deleted may not open — a rotated or missing key. Nothing
  // to revoke with, and nothing the customer can do about it. Their copy is
  // gone either way, which is what disconnect promised.
  const accessToken = readAccessToken(found.enc_token);
  if (!accessToken || !isNetwork(found.network)) return { revokedAtProvider: false };

  return { revokedAtProvider: await revokeAtProvider(found.network, accessToken) };
}

/** How many channels are live right now. Home's only channel number. */
export async function connectedChannelCount(scope: TenantScope): Promise<number> {
  return withTenant(scope, async (c) => {
    const { rows } = await c.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM tenant_channels WHERE status = 'connected'`,
    );
    return Number(rows[0]?.n ?? 0);
  });
}
