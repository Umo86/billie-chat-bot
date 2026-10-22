import type { HandoverKind } from "@/lib/types";

/**
 * When Billie passes a chat to the team (pure). Billie hands over when it
 * finds no answer, when someone asks for a person, when the topic is
 * always-human, after two thumbs-down in a row, or when Claude can't be
 * reached. "offer" asks the person first; "now" hands straight over.
 */
export type HandoverReason =
  | "unknown"
  | "always_human"
  | "asked_for_person"
  | "thumbs_down"
  | "ai_unavailable";

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

/** Live chat when someone is available, otherwise take details for a ticket. */
export function handoverRoute(agentsAvailable: number): "live" | "details" {
  return agentsAvailable > 0 ? "live" : "details";
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
