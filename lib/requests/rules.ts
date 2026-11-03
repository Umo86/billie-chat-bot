/**
 * Requests from chat (pure; tested in tests/unit/requests-pure.test.ts).
 * A bot can take requests through its chat, such as extra build-up hours or
 * a vehicle on a stand: the bot offers the form when someone wants one, and
 * the request goes to the team with a status the person can follow.
 */
import type {
  ContactDetails,
  ContactField,
  RequestAnswer,
  RequestField,
  RequestOffer,
  RequestStatus,
  RequestType,
} from "@/lib/types";

export const MAX_REQUEST_TYPES = 10;
export const MAX_REQUEST_FIELDS = 8;

/** Always asked with a request: who it's from and how to reach them. Name and email are required. */
export const REQUEST_CONTACT: ContactField[] = ["name", "company", "stand", "email", "phone"];

export const REQUEST_STATUS_LABEL: Record<RequestStatus, string> = {
  new: "New",
  in_progress: "In progress",
  done: "Done",
  declined: "Declined",
};

/** What the person reads on their request's page. */
export const REQUEST_STATUS_TEXT: Record<RequestStatus, string> = {
  new: "The team has your request and will look at it soon.",
  in_progress: "The team is working on your request.",
  done: "Your request is done.",
  declined: "The team couldn't do this request.",
};

export function requestRef(ref: number): string {
  return `R-${ref}`;
}

export function newRequestId(): string {
  return Math.random().toString(36).slice(2, 10).padEnd(8, "0");
}

type Template = Omit<RequestType, "id" | "handlerId" | "fields"> & {
  fields: Omit<RequestField, "id">[];
};

/** Ready-made requests for exhibitor bots, from the requests ops teams take by email today. */
export const REQUEST_TEMPLATES: Template[] = [
  {
    name: "Extra build-up or breakdown hours",
    when: "They need to work outside the published build-up or breakdown hours.",
    fields: [
      { label: "Which days and times", kind: "long", required: true },
      { label: "Why you need them", kind: "long", required: false },
    ],
  },
  {
    name: "Vehicle or trailer on the stand",
    when: "They want a vehicle or trailer as part of their stand.",
    fields: [
      { label: "Vehicle make, model and size", kind: "long", required: true },
      { label: "Weight", kind: "short", required: false },
      { label: "When it needs to arrive", kind: "short", required: false },
    ],
  },
  {
    name: "Rigging over a space only stand",
    when: "They want to hang anything from the ceiling above their space only stand.",
    fields: [
      { label: "What you want to rig, and its weight", kind: "long", required: true },
      { label: "Link to your stand plan", kind: "short", required: false },
    ],
  },
  {
    name: "Fascia or nameboard change",
    when: "They want their shell scheme fascia removed, or their nameboard changed.",
    fields: [
      { label: "What you'd like changed", kind: "long", required: true },
      { label: "Name on the nameboard, if it's changing", kind: "short", required: false },
    ],
  },
  {
    name: "Special treatments on the stand",
    when: "They plan to offer massage, beauty or other treatments to the public.",
    fields: [
      { label: "Which treatments", kind: "long", required: true },
      { label: "Who will carry them out, and their qualifications", kind: "long", required: true },
    ],
  },
];

export function fromTemplate(t: Template): RequestType {
  return {
    id: newRequestId(),
    name: t.name,
    when: t.when,
    handlerId: null,
    fields: t.fields.map((f) => ({ ...f, id: newRequestId() })),
  };
}

/** The form to show for a request type the bot offered, or null if it no longer exists. */
export function offerFor(types: RequestType[], typeId: string | null): RequestOffer | null {
  const t = typeId ? types.find((x) => x.id === typeId) : null;
  if (!t) return null;
  return { typeId: t.id, name: t.name, fields: t.fields, contact: REQUEST_CONTACT };
}

const MAX_VALUE = { short: 200, long: 2000, date: 40 } as const;

/** Checks and tidies what the person filled in; errors are keyed by field id. */
export function cleanAnswers(
  type: RequestType,
  input: Record<string, unknown>,
): { answers: RequestAnswer[]; errors: Record<string, string> } {
  const answers: RequestAnswer[] = [];
  const errors: Record<string, string> = {};
  for (const f of type.fields) {
    const value = String(input[f.id] ?? "")
      .trim()
      .slice(0, MAX_VALUE[f.kind]);
    if (!value) {
      if (f.required) errors[f.id] = "Fill this in.";
      continue;
    }
    if (f.kind === "date" && !/^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isNaN(Date.parse(value)))
      errors[f.id] = "Pick a date.";
    else answers.push({ label: f.label, value });
  }
  return { answers, errors };
}

/** "2026-11-25" as "Wednesday 25 November 2026"; anything else as it was typed. */
export function showValue(value: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  const d = new Date(`${value}T12:00:00Z`);
  if (Number.isNaN(d.getTime())) return value;
  return new Intl.DateTimeFormat("en-GB", {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "Europe/London",
  })
    .format(d)
    .replace(",", "");
}

/** One line for lists and Teams: who, from where. */
export function requestFrom(contact: ContactDetails): string {
  return (
    [contact.company, contact.stand ? `stand ${contact.stand}` : "", contact.name]
      .filter(Boolean)
      .join(", ") || "Someone"
  );
}
