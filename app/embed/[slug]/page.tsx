import type { Metadata } from "next";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { timingSafeEqual } from "node:crypto";
import { ChatApp } from "@/components/chat/chat-app";
import { getActor } from "@/lib/auth/actor";
import { can } from "@/lib/authz";
import { botBySlug } from "@/lib/bots/load";
import { cleanPageUrl, publicBot, SLUG } from "@/lib/chat/public";
import { frameMark } from "@/lib/chat/frame-mark";

function checkedByProxy(value: string | null): boolean {
  const a = Buffer.from(value ?? "");
  const b = Buffer.from(frameMark());
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * The chat inside the website widget (an iframe made by /widget.js). Which
 * websites may show it is enforced by proxy.ts (CSP frame-ancestors). With
 * ?try=1 it is the Try page's frame: draft bots, signed-in staff only.
 */
export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Chat", robots: { index: false } };

export default async function EmbedPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const { slug } = await params;
  const sp = await searchParams;
  // Only requests that came through proxy.ts (which set the frame's CSP).
  if (!checkedByProxy((await headers()).get("x-billie-frame"))) notFound();
  const bot = SLUG.test(slug) ? await botBySlug(slug) : null;
  if (!bot) notFound();
  const trying = sp.try === "1" || bot.status !== "live";
  if (trying) {
    const actor = await getActor();
    if (!actor || !can(actor, "bots.view")) notFound();
  }
  return (
    <ChatApp
      bot={await publicBot(bot)}
      mode="widget"
      channel={trying ? "try" : "web"}
      pageUrl={cleanPageUrl(sp.page)}
    />
  );
}
