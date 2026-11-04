import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { availability, credentialsFor, NETWORKS, redirectUriFor } from "./networks";

/**
 * The honest "not configured yet" state.
 *
 * ⛔ THE POINT OF THESE ASSERTIONS IS A BUTTON THAT NEVER LIES. A Connect
 * button that renders enabled and then fails after the click is the single
 * worst thing that can happen on a platform-review recording: the reviewer
 * sees the product break at the exact step they are there to verify. So the
 * screen has to know BEFORE it draws whether a network can actually be
 * connected, and it has to be able to say why not.
 */

const KEY = "qjDpuHuq2jbrBgSMoawOY5TMtX59BmEEnBYTHZZ8wnI";

const OAUTH_KEYS = [
  "YOUTUBE_OAUTH_CLIENT_ID",
  "YOUTUBE_OAUTH_CLIENT_SECRET",
  "FACEBOOK_OAUTH_CLIENT_ID",
  "FACEBOOK_OAUTH_CLIENT_SECRET",
  "INSTAGRAM_OAUTH_CLIENT_ID",
  "INSTAGRAM_OAUTH_CLIENT_SECRET",
  "TIKTOK_OAUTH_CLIENT_KEY",
  "TIKTOK_OAUTH_CLIENT_SECRET",
  "LINKEDIN_OAUTH_CLIENT_ID",
  "LINKEDIN_OAUTH_CLIENT_SECRET",
];

function clearAll() {
  delete process.env.CHANNEL_TOKEN_KEY;
  for (const k of OAUTH_KEYS) delete process.env[k];
}

beforeEach(clearAll);
afterEach(clearAll);

describe("availability", () => {
  it("reports every network unconfigured when nothing is set", () => {
    for (const n of NETWORKS) {
      const a = availability(n);
      expect(a.configured).toBe(false);
      expect(a.reason).toBeTruthy();
    }
  });

  it("blames the missing sealing key FIRST, because it blocks every network", () => {
    // With a client id present but no key, saying "needs a client id" would
    // send an operator to fix five things that are already fine.
    process.env.YOUTUBE_OAUTH_CLIENT_ID = "id";
    process.env.YOUTUBE_OAUTH_CLIENT_SECRET = "secret";
    const a = availability("youtube");
    expect(a.configured).toBe(false);
    expect(a.reason).toMatch(/encryption/i);
  });

  it("names the exact env vars a network is missing", () => {
    process.env.CHANNEL_TOKEN_KEY = KEY;
    const a = availability("tiktok");
    expect(a.configured).toBe(false);
    // TikTok's client id is called client_key — the message has to say the
    // real variable name, not a guessed convention.
    expect(a.reason).toContain("TIKTOK_OAUTH_CLIENT_KEY");
    expect(a.reason).toContain("TIKTOK_OAUTH_CLIENT_SECRET");
  });

  it("reports configured once the key and both halves of the client are set", () => {
    process.env.CHANNEL_TOKEN_KEY = KEY;
    process.env.YOUTUBE_OAUTH_CLIENT_ID = "id";
    process.env.YOUTUBE_OAUTH_CLIENT_SECRET = "secret";
    const a = availability("youtube");
    expect(a.configured).toBe(true);
    expect(a.reason).toBeNull();
  });

  it("treats a half-configured network as unconfigured", () => {
    process.env.CHANNEL_TOKEN_KEY = KEY;
    process.env.YOUTUBE_OAUTH_CLIENT_ID = "id"; // no secret
    expect(availability("youtube").configured).toBe(false);
    expect(credentialsFor("youtube")).toBeNull();
  });

  it("treats whitespace-only values as absent", () => {
    process.env.CHANNEL_TOKEN_KEY = KEY;
    process.env.YOUTUBE_OAUTH_CLIENT_ID = "  ";
    process.env.YOUTUBE_OAUTH_CLIENT_SECRET = "secret";
    // A copy-paste that lands a blank line in an env file must not present a
    // working button.
    expect(credentialsFor("youtube")).toBeNull();
  });

  it("carries a customer-facing label and blurb for every network", () => {
    for (const n of NETWORKS) {
      const a = availability(n);
      expect(a.label.length).toBeGreaterThan(0);
      expect(a.blurb.length).toBeGreaterThan(0);
      // The em-dash ban on customer-facing strings.
      expect(a.label).not.toContain("—");
      expect(a.blurb).not.toContain("—");
    }
  });
});

describe("redirectUriFor", () => {
  it("builds the callback URL from APP_URL, one per network", () => {
    for (const n of NETWORKS) {
      expect(redirectUriFor(n)).toMatch(
        new RegExp(`^https?://[^/]+/api/channels/callback/${n}$`),
      );
    }
  });
});
