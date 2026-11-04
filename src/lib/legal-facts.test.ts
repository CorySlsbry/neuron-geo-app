import { describe, expect, it } from "vitest";
import { NETWORKS, networkDef } from "@/modules/channels/internal/networks";
import { NETWORK_PERMISSIONS } from "./legal-facts";

/**
 * The privacy policy and the OAuth request must ask for the same thing.
 *
 * ⛔ THIS IS A COMPLIANCE TEST, NOT A TIDINESS TEST. Every one of the five
 * platforms rejects an app whose disclosed permissions do not match the ones it
 * requests, and Meta and Google both check it by hand during review. The drift
 * is silent in both directions:
 *
 *   - add a scope to `networks.ts` and the app starts asking for a permission
 *     no published document discloses;
 *   - drop a scope from `networks.ts` and the policy keeps claiming we take
 *     something we no longer take, which reads as carelessness to a reviewer
 *     and is a false statement to a customer.
 *
 * Neither shows up in typecheck, lint, or any user-facing behaviour. Only this.
 */

describe("legal-facts agrees with the OAuth request", () => {
  it("covers every network the app can connect", () => {
    const documented = NETWORK_PERMISSIONS.map((n) => n.network).sort();
    expect(documented).toEqual([...NETWORKS].sort());
  });

  it.each([...NETWORKS])("documents exactly the scopes %s requests", (network) => {
    const requested = [...networkDef(network).scopes].sort();
    const entry = NETWORK_PERMISSIONS.find((n) => n.network === network);
    expect(entry, `no privacy-policy entry for ${network}`).toBeDefined();
    const documented = entry!.scopes.map((s) => s.scope).sort();
    expect(documented).toEqual(requested);
  });

  it("gives every scope a non-trivial reason", () => {
    for (const n of NETWORK_PERMISSIONS) {
      for (const s of n.scopes) {
        // A reviewer reads these. "required" or "needed" is not a reason.
        expect(s.why.length, `${n.network}/${s.scope} reason too short`).toBeGreaterThan(30);
      }
    }
  });

  it("uses the network's own label, so the policy names what the customer clicked", () => {
    for (const n of NETWORK_PERMISSIONS) {
      expect(n.label).toBe(networkDef(n.network as (typeof NETWORKS)[number]).label);
    }
  });
});
