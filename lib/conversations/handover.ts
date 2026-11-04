import type { ContactDetails, ContactField, HandoverKind } from "@/lib/types";

/**
 * When Billie passes a chat to the team (pure). Billie hands over when it
 * finds no answer, when someone asks for a person, when the topic is
 * always-human, after two thumbs-down in a row, or when Claude can't be
 * reached. "offer" asks the person first; "now" hands straight over.
 */
export type HandoverReason =
  "unknown" | "always_human" | "asked_for_person" | "thumbs_down" | "ai_unavailable";

export type HandoverDecision =
  | { kind: "none" }
  | { kind: "offer"; reason: HandoverReason }
  | { kind: "now"; reason: HandoverReason };

export const THUMBS_DOWN_LIMIT = 2;

export function afterAnswer(handover: HandoverKind): HandoverDecision {
  switch (handover) {
    case "always_human":
      return { kind: "now", reason: "always_human" };
    case "asked_for_person":
      return { kind: "now", reason: "asked_for_person" };
    case "unknown":
      return { kind: "offer", reason: "unknown" };
    default:
      return { kind: "none" };
  }
}

export function afterRating(thumbsDownStreak: number): HandoverDecision {
  return thumbsDownStreak >= THUMBS_DOWN_LIMIT
    ? { kind: "offer", reason: "thumbs_down" }
    : { kind: "none" };
}

/**
 * Live chat during the bot's working hours (the team answers in Slack, or
 * in the Inbox); outside them, the person's details, for a ticket.
 */
export function handoverRoute(withinHours: boolean): "live" | "details" {
  return withinHours ? "live" : "details";
}

/** A live chat nobody has answered in this long gets the details form instead. */
export const WAIT_MINUTES = 5;

export const WAITED_LINE =
  "Sorry, nobody from the team is free right now. Leave your details and they'll get back to you.";

/** Has Billie already got everything the form would ask (an exhibitor signed in from the manual)? */
export function contactComplete(
  fields: ContactField[],
  contact: ContactDetails | null | undefined,
): boolean {
  const c = contact ?? {};
  return (
    fields.length > 0 &&
    fields.every((f) => Boolean(c[f]?.trim())) &&
    (!fields.includes("email") || /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(c.email ?? ""))
  );
}

/**
 * Is a suggested reply worth a Claude call straight away? Only when Billie
 * hadn't tried the knowledge already: a topic that always goes to a person,
 * or someone who asked for one. When it had just found nothing (or its
 * answers were marked unhelpful, or Claude was down), the same knowledge
 * would only give a holding reply: the team can still press "Suggest a reply".
 */
export function suggestStraightAway(reason: HandoverReason): boolean {
  return reason === "always_human" || reason === "asked_for_person";
}

export const REASON_LABEL: Record<HandoverReason, string> = {
  unknown: "Billie didn't have the answer",
  always_human: "Always goes to a person",
  asked_for_person: "Asked for a person",
  thumbs_down: "Two answers marked not helpful",
  ai_unavailable: "Billie couldn't answer at the time",
};

/** What the person sees when the chat moves to the team. */
export function handoverLine(route: "live" | "details", reason: HandoverReason): string {
  if (route === "live") return "Connecting you to the team. Someone will reply here shortly.";
  return reason === "always_human"
    ? "The team handles this personally. Leave your details and they'll get back to you."
    : "Nobody from the team is online right now. Leave your details and they'll get back to you.";
}
