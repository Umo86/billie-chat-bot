import "server-only";
import { teamsLinkProblem } from "@/lib/emails/mailbox-rules";

/**
 * Posting to a Teams channel through a Teams Workflows link. Each bot can
 * have its event's own channel; TEAMS_WEBHOOK_URL is the company-wide one
 * for anything without. A failure throws, so the job that posts retries.
 */
export function teamsLinkFor(botLink: string | null | undefined): string | null {
  const own = botLink?.trim();
  if (own) return own;
  return process.env.TEAMS_WEBHOOK_URL?.trim() || null;
}

export async function postToTeams(link: string, payload: unknown): Promise<void> {
  // Only Microsoft's own hosts (checked when saved; checked again here).
  const problem = teamsLinkProblem(link);
  if (problem) throw new Error(`Teams link refused: ${problem}`);
  const res = await fetch(link, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
    redirect: "error",
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok && res.status !== 202) throw new Error(`Teams answered ${res.status}`);
}
