/**
 * Exhibitor bots that only signed-in exhibitors can use (pure; Exhibitors
 * step → "Only exhibitors who are signed in can chat"). The bot lives in the
 * exhibitor manual, which only exhibitors can open, but its chat page and
 * WhatsApp number can be reached by anyone: with this on, anyone not signed
 * in is told how to sign in, and Billie isn't asked anything for them.
 */

type GateBot = {
  audience: "visitors" | "exhibitors";
  personalAnswers: boolean;
  exhibitorsOnly: boolean;
};

/** Signing in needs "Answers about their own stand" on, so the setting only counts with it. */
export function exhibitorsOnly(bot: GateBot): boolean {
  return bot.audience === "exhibitors" && bot.personalAnswers && bot.exhibitorsOnly;
}

/** How someone can sign in to this bot's chat right now. */
export type SignInWays = {
  /** "Your stand": a code to the email they booked with. */
  code: boolean;
  /** From BluePrint, the exhibitor manual. */
  manual: boolean;
};

const team = (email: string) =>
  email.trim() ? `please email the event team at ${email.trim()}` : "please contact the event team";

/** What someone who isn't signed in sees instead of the message box. */
export function lockedLine(ways: SignInWays, contactEmail: string, whatsapp = false): string {
  if (whatsapp)
    return `This chat is only for exhibitors signed in to the exhibitor manual, so I can't answer here. Please open the chat in the manual, or ${team(contactEmail)}.`;
  if (ways.code && ways.manual)
    return "This chat is for exhibitors. Sign in with Your stand, using the email you booked with, or open the chat from the exhibitor manual.";
  if (ways.code)
    return "This chat is for exhibitors. Sign in with Your stand, using the email you booked with, to ask a question.";
  if (ways.manual)
    return "This chat is for exhibitors. Sign in to the exhibitor manual, then open the chat from there.";
  return `This chat is for exhibitors, and signing in isn't open yet. If you need something from us, ${team(contactEmail)}.`;
}
