// The plan catalog — pure, the single source of truth for what a plan costs,
// how many people it covers, and what usage it includes. FLAT pricing on
// purpose: no per-head fee, no metered surprise — overage asks, never bills.
//
// Price IDs are NEVER hardcoded — Stripe prices are resolved at runtime by
// lookup_key, so the same code works in test and live and survives any
// price object being recreated.

export type PlanKey = "start" | "growth";

export interface Plan {
  key: PlanKey;
  name: string;
  /** Monthly price in integer cents (display + the price we create in Stripe). */
  priceCents: number;
  /** How many people the plan covers, owner included. */
  seatCap: number;
  lookupKey: string;
  /** Included GEO posts per month (usage allowance, not a feature gate). */
  includedPosts: number;
  /** Included reels per month (usage allowance, not a feature gate). */
  includedReels: number;
  /** Monthly AI spend ceiling in whole USD (the usage guard's budget). */
  aiBudgetUsd: number;
  blurb: string;
}

/**
 * ⛔ TWO FLAT TIERS (Cory 2026-08-14, plan spicy-noodling-pixel): $89 Start,
 * $199 Growth. The lookup keys geo_start_89 / geo_growth_199 are the contract
 * with Stripe — prices are resolved at runtime by lookup_key, so the same code
 * works in test and live and survives any price object being recreated. The
 * keys embed the amount so a stale one is visible on sight.
 *
 * A tier never gates a FEATURE — both plans are the whole product. What a tier
 * buys is capacity: seats, included posts/reels per month, and the monthly AI
 * budget the usage guard enforces. Those are allowances, not switches.
 *
 * ⛔ The allowance numbers (includedPosts / includedReels / aiBudgetUsd) are
 * P0 PLACEHOLDERS pending Cory's pricing pass — the mechanism is real, the
 * quantities are not final.
 */
export const PLANS: Record<PlanKey, Plan> = {
  start: {
    key: "start",
    name: "Start",
    priceCents: 8_900,
    seatCap: 2,
    lookupKey: "geo_start_89",
    includedPosts: 8,
    includedReels: 8,
    aiBudgetUsd: 15,
    blurb:
      "Standard cadence for one brand: 2 posts and 2 reels a week, plus weekly citation sweeps that check where the AI engines mention you.",
  },
  growth: {
    key: "growth",
    name: "Growth",
    priceCents: 19_900,
    seatCap: 10,
    lookupKey: "geo_growth_199",
    includedPosts: 30,
    includedReels: 30,
    aiBudgetUsd: 50,
    blurb:
      "Heavier cadence and priority runs, with room for the whole team. For brands that want to be everywhere their buyers ask.",
  },
};

export const PLAN_LIST: Plan[] = [PLANS.start, PLANS.growth];

export function planFor(key: string): Plan {
  const p = PLANS[key as PlanKey];
  if (!p) throw new Error(`unknown_plan:${key}`);
  return p;
}

/** Upgrade = more seats. Drives proration behavior and the UI's wording. */
export function isUpgrade(from: PlanKey, to: PlanKey): boolean {
  return PLANS[to].seatCap > PLANS[from].seatCap;
}

export interface SeatCheck {
  allowed: boolean;
  seatCap: number;
  used: number;
  /** The plan that would fit, when the current one doesn't. */
  suggestPlan: PlanKey | null;
  message: string;
}

/**
 * Can this tenant add one more person? Plain-language answer either way —
 * a seat wall should read like a person wrote it, not a paywall.
 */
/** ⛔ Counts here can be 1 (a Start plan with one of its two seats filled),
 *  so they pluralise. "1 people" and "1 spots are open" is the kind of sentence
 *  that erodes trust, which is not a trade worth making for one helper
 *  function. The seatCap === 1 branches below are kept deliberately: no plan
 *  has a cap of 1 today, and if one is ever added the wording should already
 *  be right rather than shipping "1 people". */
const people = (n: number) => `${n} ${n === 1 ? "person" : "people"}`;
const spots = (n: number) => `${n} ${n === 1 ? "spot" : "spots"}`;

export function checkSeat(plan: PlanKey, currentMembers: number): SeatCheck {
  const { seatCap, name } = PLANS[plan];
  if (currentMembers < seatCap) {
    const open = seatCap - currentMembers;
    return {
      allowed: true,
      seatCap,
      used: currentMembers,
      suggestPlan: null,
      message: `${open} of your ${spots(seatCap)} ${open === 1 ? "is" : "are"} open.`,
    };
  }
  // PLAN_LIST is ordered cheapest first, so the first larger cap is the next
  // rung up, not an arbitrary bigger one.
  const bigger = PLAN_LIST.find((p) => p.seatCap > seatCap);
  const taken =
    seatCap === 1
      ? `Your ${name} plan covers just you, and that spot is taken.`
      : `Your ${name} plan covers ${people(seatCap)} and all ${seatCap} spots are taken.`;
  return {
    allowed: false,
    seatCap,
    used: currentMembers,
    suggestPlan: bigger?.key ?? null,
    message: bigger
      ? `${taken} Moving to ${bigger.name} ($${bigger.priceCents / 100}/mo) makes room for ${bigger.seatCap}.`
      : `${taken} Give us a call and we'll sort out a bigger plan.`,
  };
}

const money = (cents: number) =>
  `$${Math.floor(cents / 100).toLocaleString("en-US")}${cents % 100 ? `.${String(cents % 100).padStart(2, "0")}` : ""}`;

/** What the plan covers, said the way a person would, never "up to 1 people". */
const covers = (p: Plan) => (p.seatCap === 1 ? "just you" : `up to ${p.seatCap} people`);

/** Plain-language state line for the billing screen. Figures verbatim. */
export function explainSubscription(s: {
  plan: PlanKey;
  status: string;
  cancelAtPeriodEnd: boolean;
  currentPeriodEnd: string | null;
  trialEndsAt: string | null;
}): string {
  const p = PLANS[s.plan];
  const when = (d: string | null) => (d ? d.slice(0, 10) : "soon");
  if (s.status === "canceled") {
    return `Your subscription is canceled. Your data is still yours. Download everything any time from this page.`;
  }
  if (s.cancelAtPeriodEnd) {
    return `You're on ${p.name} (${money(p.priceCents)}/mo) and it ends ${when(s.currentPeriodEnd)}. Nothing more will be charged. Change your mind before then and one click brings it back.`;
  }
  if (s.status === "trialing") {
    return `You're on a free trial of ${p.name} through ${when(s.trialEndsAt)}, ${covers(p)}, everything included. No card needed until you're ready.`;
  }
  if (s.status === "past_due") {
    return `The last payment didn't go through, so ${p.name} is past due. Update your card below and everything picks up where it left off. Nothing has been deleted.`;
  }
  return `You're on ${p.name}: ${money(p.priceCents)} a month, ${covers(p)}, everything included. Renews ${when(s.currentPeriodEnd)}.`;
}
