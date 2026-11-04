import "server-only";
import { withTenant, type TenantScope } from "@/lib/db/tenant";
import { AuthError } from "./guards";

/**
 * The two facts onboarding asks for, stored on the tenant's own row rather
 * than in a table of their own: the brand's name and the domain we are trying
 * to get cited. Both live in `tenants` because there is exactly one of each
 * per workspace and a one-row-per-tenant table is a join with no upside.
 *
 * `onboarded_at` is the third field and the reason this is not just an
 * UPDATE inline in a route: without it, "brand new workspace" and "set up,
 * deliberately connected nothing yet" are the same empty state, and Home
 * cannot pick the right sentence for either.
 */

export interface Brand {
  name: string;
  domain: string | null;
  onboardedAt: string | null;
}

export async function getBrand(scope: TenantScope): Promise<Brand> {
  return withTenant(scope, async (c) => {
    const { rows } = await c.query<{
      name: string;
      domain: string | null;
      onboarded_at: string | null;
    }>(
      `SELECT name, domain, onboarded_at::text AS onboarded_at
         FROM tenants WHERE id = $1`,
      [scope.tenantId],
    );
    const row = rows[0];
    if (!row) throw new AuthError(404, "tenant_not_found");
    return { name: row.name, domain: row.domain, onboardedAt: row.onboarded_at };
  });
}

/**
 * Normalise whatever the customer typed into a bare hostname.
 *
 * People type "https://neuron-hq.com/", "www.neuron-hq.com", and
 * "neuron-hq.com" interchangeably and all three mean the same brand. Storing
 * them as typed means the same domain compares unequal to itself later, so
 * the cleanup happens once, here, on the way in.
 */
export function normalizeDomain(input: string): string | null {
  const trimmed = input.trim().toLowerCase();
  if (!trimmed) return null;
  const withoutScheme = trimmed.replace(/^[a-z][a-z0-9+.-]*:\/\//, "");
  const host = (withoutScheme.split("/")[0] ?? "").replace(/^www\./, "");
  if (!host) return null;
  // One dot, no spaces, no obvious junk. Deliberately permissive about TLDs —
  // refusing a valid domain because a regex had not heard of it is worse than
  // accepting one that turns out to be a typo, which the customer can fix.
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(host)) return null;
  return host;
}

/**
 * Finish onboarding. Writes the brand name, the normalised domain, and stamps
 * `onboarded_at` the FIRST time only — re-editing the brand later must not
 * make the workspace look newly set up.
 */
export async function saveBrand(
  scope: TenantScope,
  name: string,
  domain: string,
): Promise<Brand> {
  const cleanName = name.trim();
  if (!cleanName || cleanName.length > 120) {
    throw new AuthError(422, "brand_name_invalid");
  }
  const host = normalizeDomain(domain);
  if (!host) throw new AuthError(422, "brand_domain_invalid");

  return withTenant(scope, async (c) => {
    const { rows } = await c.query<{
      name: string;
      domain: string | null;
      onboarded_at: string | null;
    }>(
      `UPDATE tenants
          SET name = $2, domain = $3, onboarded_at = coalesce(onboarded_at, now())
        WHERE id = $1
        RETURNING name, domain, onboarded_at::text AS onboarded_at`,
      [scope.tenantId, cleanName, host],
    );
    const row = rows[0];
    // Zero rows means the UPDATE policy or the column grant is missing — the
    // silent-failure pair from migration 0001's note. Loud, not silent.
    if (!row) throw new AuthError(404, "tenant_not_found");

    await c.query(
      `INSERT INTO events (tenant_id, name, actor_uid, payload)
       VALUES ($1, 'brand_saved', $2, $3::jsonb)`,
      [scope.tenantId, scope.uid, JSON.stringify({ domain: host })],
    );

    return { name: row.name, domain: row.domain, onboardedAt: row.onboarded_at };
  });
}
