import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { ChatApp } from "@/components/chat/chat-app";
import { botBySlug } from "@/lib/bots/load";
import { publicBot, SLUG } from "@/lib/chat/public";

/** The chat on its own page: for emails, the exhibitor portal and QR codes at the show. */
export const dynamic = "force-dynamic";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const bot = SLUG.test(slug) ? await botBySlug(slug) : null;
  return {
    title:
      bot?.status === "live" ? `${bot.name}${bot.showName ? ` · ${bot.showName}` : ""}` : "Chat",
    robots: { index: false },
  };
}

export default async function HostedChatPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const bot = SLUG.test(slug) ? await botBySlug(slug) : null;
  if (!bot || bot.status !== "live") notFound();
  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-[760px] flex-col sm:justify-center sm:px-4 sm:py-6">
      <ChatApp bot={await publicBot(bot)} mode="page" channel="hosted" pageUrl={null} />
    </main>
  );
}
