/**
 * The facts the public legal pages state, in ONE place.
 *
 * ⛔ WHY THIS FILE EXISTS. `/privacy` has to list exactly the permissions the
 * app asks each network for. That list already exists, as the `scopes` arrays in
 * `modules/channels/internal/networks.ts`, and it is the OAuth code's copy that
 * is true by construction because it is the one sent in the authorize URL.
 *
 * So this file does NOT re-derive the scopes. It carries the human sentence for
 * each one, the part a reviewer actually reads and no machine can generate, and
 * `legal-facts.test.ts` asserts that the scope KEYS here are exactly the scopes
 * `networks.ts` requests. Add a scope to the OAuth request and forget the
 * policy, or leave a scope in the policy after dropping it from the request, and
 * the test fails.
 *
 * That direction matters. Asking for a permission the privacy policy does not
 * disclose is a rejection on every one of the five platforms, and it is the
 * failure mode that happens silently, months later, when someone edits
 * `networks.ts` in a hurry and never opens `/privacy`.
 *
 * Deliberately NOT `server-only`: the test imports it, and there is nothing
 * secret here. Everything in this file is meant to be read by strangers.
 */

/** Stated on `/privacy` and `/terms`. A literal, so it cannot drift per render
 *  or differ between server and client. Bump it when the policy materially
 *  changes, which is also when customers have to be told in-app. */
export const POLICY_EFFECTIVE = "17 August 2026";

export interface ScopeReason {
  /** Must match a scope string in `networks.ts` exactly. Enforced by test. */
  readonly scope: string;
  /** Plain language, aimed at a reviewer and a customer, not a lawyer. */
  readonly why: string;
}

export interface NetworkPermissions {
  readonly network: string;
  readonly label: string;
  readonly scopes: readonly ScopeReason[];
}

export const NETWORK_PERMISSIONS: readonly NetworkPermissions[] = [
  {
    network: "youtube",
    label: "YouTube",
    scopes: [
      {
        scope: "https://www.googleapis.com/auth/youtube.upload",
        why: "to upload the videos you approve to your channel. This is the only way a video you approved can reach YouTube.",
      },
      {
        scope: "https://www.googleapis.com/auth/youtube.readonly",
        why: "to read which channel you connected, so we can show you its name and confirm we are publishing to the right place.",
      },
    ],
  },
  {
    network: "facebook",
    label: "Facebook",
    scopes: [
      {
        scope: "pages_show_list",
        why: "to list the Pages you manage, so you can choose which one to connect.",
      },
      {
        scope: "pages_manage_posts",
        why: "to publish the posts you approve to the Page you chose.",
      },
      {
        scope: "pages_read_engagement",
        why: "to read back the post we published, so we can show you it went live and link to it.",
      },
    ],
  },
  {
    network: "instagram",
    label: "Instagram",
    scopes: [
      {
        scope: "instagram_basic",
        why: "to read the professional account you connected, so we can show you its handle.",
      },
      {
        scope: "instagram_content_publish",
        why: "to publish the Reels and posts you approve.",
      },
      {
        scope: "pages_show_list",
        why: "to find the Facebook Page your Instagram professional account is linked to. Instagram publishing runs through that link.",
      },
      {
        scope: "pages_read_engagement",
        why: "to read back the post we published, so we can show you it went live and link to it. Instagram requires this alongside publishing.",
      },
    ],
  },
  {
    network: "tiktok",
    label: "TikTok",
    scopes: [
      {
        scope: "user.info.basic",
        why: "to read your display name, so we can show you which account is connected.",
      },
      {
        scope: "video.publish",
        why: "to publish the videos you approve to your account.",
      },
    ],
  },
  {
    network: "linkedin",
    label: "LinkedIn",
    scopes: [
      {
        scope: "openid",
        why: "to complete sign-in with LinkedIn and identify the member who granted access.",
      },
      {
        scope: "profile",
        why: "to read your name, so we can show you which profile is connected.",
      },
      {
        scope: "w_member_social",
        why: "to publish the posts you approve to your profile.",
      },
    ],
  },
] as const;
