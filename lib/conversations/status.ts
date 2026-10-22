/**
 * Conversation status machine (pure). Every status change in the app goes
 * through `nextStatus`; an event that isn't allowed from a status returns
 * null and the caller refuses the change. Table-tested in
 * tests/unit/conversation-status.test.ts.
 */
export type ConversationStatus =
  "bot" | "waiting" | "live" | "collecting" | "ticket" | "replied" | "closed";

export type ConversationEvent =
  /** Billie (or the person) wants the team and someone is available: live chat. */
  | "handover_live"
  /** Wants the team, nobody available: ask for contact details. */
  | "handover_offline"
  /** The person left their details. */
  | "details_left"
  /** The person carried on with Billie instead of leaving details. */
  | "form_cancelled"
  /** A team member wrote in the chat. */
  | "staff_replied"
  /** The team handed the chat back to Billie. */
  | "hand_back"
  /** The person wrote again (reopens a finished chat). */
  | "visitor_wrote"
  | "close";

const T: Record<ConversationStatus, Partial<Record<ConversationEvent, ConversationStatus>>> = {
  bot: {
    handover_live: "waiting",
    handover_offline: "collecting",
    staff_replied: "live",
    visitor_wrote: "bot",
    close: "closed",
  },
  waiting: {
    staff_replied: "live",
    handover_offline: "collecting",
    hand_back: "bot",
    visitor_wrote: "waiting",
    close: "closed",
  },
  live: {
    staff_replied: "live",
    hand_back: "bot",
    visitor_wrote: "live",
    close: "closed",
  },
  collecting: {
    details_left: "ticket",
    form_cancelled: "bot",
    staff_replied: "live",
    visitor_wrote: "collecting",
    close: "closed",
  },
  ticket: {
    staff_replied: "replied",
    visitor_wrote: "ticket",
    close: "closed",
  },
  replied: {
    staff_replied: "replied",
    visitor_wrote: "bot",
    close: "closed",
  },
  closed: {
    visitor_wrote: "bot",
  },
};

export function nextStatus(
  from: ConversationStatus,
  event: ConversationEvent,
): ConversationStatus | null {
  return T[from][event] ?? null;
}

/** Statuses that need a person, newest first in the Inbox's "Needs you" list. */
export const NEEDS_PERSON: readonly ConversationStatus[] = ["waiting", "ticket"];

/** While here, Billie doesn't answer the person's messages (a person is on it or about to be). */
export function botPaused(status: ConversationStatus): boolean {
  return (
    status === "waiting" || status === "live" || status === "collecting" || status === "ticket"
  );
}

export const STATUS_LABEL: Record<ConversationStatus, string> = {
  bot: "Billie",
  waiting: "Waiting",
  live: "Live",
  collecting: "Taking details",
  ticket: "Ticket",
  replied: "Replied",
  closed: "Closed",
};
