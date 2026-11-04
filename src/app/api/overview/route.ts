import { NextResponse } from "next/server";
import { getBrand, requireScope } from "@/modules/auth-tenancy";
import { connectedChannelCount } from "@/modules/channels";
import { counts } from "@/modules/content";
import { route } from "@/lib/http/route";

export const dynamic = "force-dynamic";

/**
 * Everything Home shows, and nothing it doesn't.
 *
 * ⛔ EVERY NUMBER BELOW IS A `count(*)` OVER REAL ROWS. There is no
 * projection, no estimate, no "expected reach", and no placeholder that gets
 * swapped for a real value later — because a placeholder that ships is
 * indistinguishable from a lie, and this screen is the first thing a platform
 * reviewer sees. `sampleContent` travels with the counts so the screen can
 * say out loud when the only rows behind them are the demo ones.
 */
export const GET = route(async () => {
  const scope = await requireScope();
  const [brand, channelsConnected, content] = await Promise.all([
    getBrand(scope),
    connectedChannelCount(scope),
    counts(scope),
  ]);

  return NextResponse.json({
    brand,
    channelsConnected,
    awaitingReview: content.awaitingReview,
    approved: content.approved,
    published: content.published,
    sampleContent: content.sample,
    totalContent: content.total,
    /** Has this workspace finished the wizard? Drives Home's next-step card. */
    onboarded: brand.onboardedAt !== null,
  });
});
