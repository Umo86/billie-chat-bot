import "server-only";
import { appUrl, emailConfigured } from "@/lib/config";
import { getSettings } from "@/lib/settings";
import { sendEmail } from "@/lib/email/send";
import { kpis, topQuestions } from "./queries";

/** The Monday email: last week's volumes, Billie's share and the gaps to fill. */
export function summaryText(input: {
  k: Awaited<ReturnType<typeof kpis>>;
  top: { question: string; times: number }[];
  link: string;
}): string {
  const { k, top } = input;
  return [
    "Billie, last 7 days",
    "",
    `Chats: ${k.chats}`,
    `Answered by Billie alone: ${k.answeredAlonePct === null ? "–" : `${k.answeredAlonePct}%`}`,
    `Passed to the team: ${k.handedOver}`,
    `Email replies drafted: ${k.emailsDrafted}`,
    `Open gaps (questions Billie couldn't answer): ${k.openGaps}`,
    "",
    top.length ? "Top questions:" : "",
    ...top.map((q) => `- ${q.question} (${q.times})`),
    "",
    `Open Billie: ${input.link}`,
  ]
    .filter((l, i, all) => !(l === "" && all[i - 1] === ""))
    .join("\n");
}

export async function sendWeeklySummary(now = new Date()): Promise<boolean> {
  const s = await getSettings();
  const to = s.alertEmails.split(/[,;\s]+/).filter((x) => x.includes("@"));
  if (!s.weeklySummary || !to.length || !emailConfigured()) return false;
  const since = new Date(now.getTime() - 7 * 86_400_000);
  const text = summaryText({ k: await kpis(since), top: await topQuestions(since, 5), link: `${appUrl()}/reports` });
  await sendEmail({ to, subject: "Billie: your weekly summary", text });
  return true;
}
