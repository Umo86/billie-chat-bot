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
  RequestOrder,
  RequestStatus,
  RequestType,
} from "@/lib/types";

export const MAX_REQUEST_TYPES = 10;
export const MAX_REQUEST_FIELDS = 8;
export const MAX_REQUEST_ITEMS = 30;
/** The most of one item an order can have, so a slip of the keyboard can't order 10,000. */
export const MAX_QUANTITY = 99;

/** Always asked with a request: who it's from and how to reach them. Name and email are required. */
export const REQUEST_CONTACT: ContactField[] = ["name", "company", "stand", "email", "phone"];
/** Visitors and leads aren't exhibitors (yet): no stand to ask for. */
export const LEAD_CONTACT: ContactField[] = ["name", "company", "email", "phone"];

export type Audience = "visitors" | "exhibitors";

/** The contact details a request asks for: a stand only from exhibitors. */
export function contactFor(t: Pick<RequestType, "crm">, audience: Audience): ContactField[] {
  return t.crm || audience === "visitors" ? LEAD_CONTACT : REQUEST_CONTACT;
}

/** Said on a lead's form, so people know where their details go. */
export const LEAD_PROMISE =
  "We'll pass your details to our sales team, who will contact you about exhibiting.";

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
    name: "Electrics order",
    when: "They want to order electrics (power sockets, lighting) for their space only stand.",
    task: true,
    forColumn: "Stand type",
    forValues: ["Space only"],
    items: [],
    fields: [
      { label: "Where on the stand, and anything else to know", kind: "long", required: false },
    ],
  },
  {
    name: "Nameboard",
    when: "They want to give or change the name on their shell scheme stand's nameboard.",
    task: true,
    forColumn: "Stand type",
    forValues: ["Shell scheme"],
    fields: [
      { label: "Name on the nameboard, exactly as it should read", kind: "short", required: true },
    ],
  },
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

/** Ready-made requests for visitor bots: someone keen to exhibit becomes a lead. */
export const VISITOR_REQUEST_TEMPLATES: Template[] = [
  {
    name: "Interested in exhibiting",
    when: "They're thinking of exhibiting or sponsoring, ask about stand prices, space or packages, or want to talk to the sales team.",
    crm: true,
    fields: [
      { label: "What does your company do or sell?", kind: "long", required: true },
      { label: "Your job title", kind: "short", required: false },
      { label: "What size of stand are you thinking of?", kind: "short", required: false },
      { label: "Anything else our sales team should know", kind: "long", required: false },
    ],
  },
];

export function fromTemplate(t: Template): RequestType {
  return {
    ...t,
    id: newRequestId(),
    handlerId: null,
    fields: t.fields.map((f) => ({ ...f, id: newRequestId() })),
    items: t.items?.map((i) => ({ ...i, id: newRequestId() })),
  };
}

/** The form to show for a request type the bot offered, or null if it no longer exists. */
export function offerFor(
  types: RequestType[],
  typeId: string | null,
  audience: Audience,
  known?: RequestOffer["known"],
): RequestOffer | null {
  const t = typeId ? types.find((x) => x.id === typeId) : null;
  if (!t) return null;
  return {
    typeId: t.id,
    name: t.name,
    fields: t.fields,
    contact: contactFor(t, audience),
    ...(t.crm ? { promise: LEAD_PROMISE } : {}),
    ...(t.items?.length ? { items: t.items } : {}),
    ...(known ? { known } : {}),
  };
}

/** The exhibitor signed in to a chat, as far as tasks need: their list row. */
export type TaskExhibitor = { fields: Record<string, string>; stand: string; company: string };

const norm = (v: string) => v.trim().toLowerCase();

/**
 * Who a request is for. One for some stands only (e.g. Stand type: Space
 * only) needs the exhibitor signed in, and their row to say so; anything
 * else is open to everyone.
 */
export function openTo(type: RequestType, ex: TaskExhibitor | null): "yes" | "sign_in" | "no" {
  const column = type.forColumn?.trim();
  const values = (type.forValues ?? []).map(norm).filter(Boolean);
  if (!column || !values.length) return "yes";
  if (!ex) return "sign_in";
  const own =
    Object.entries(ex.fields).find(([k]) => norm(k) === norm(column))?.[1] ??
    (norm(column) === "stand" ? ex.stand : norm(column) === "company" ? ex.company : "");
  return values.includes(norm(own ?? "")) ? "yes" : "no";
}

/** Pounds, as the chat shows them: £1,234.50. */
export function money(pounds: number): string {
  return new Intl.NumberFormat("en-GB", { style: "currency", currency: "GBP" }).format(pounds);
}

/** An order as filled in (how many of each item), checked against the type's items and prices. */
export function cleanOrder(
  type: RequestType,
  input: Record<string, unknown>,
): { order: RequestOrder | null; error: string | null } {
  const items = type.items ?? [];
  if (!items.length) return { order: null, error: null };
  const lines: RequestOrder["lines"] = [];
  for (const item of items) {
    const raw = input[item.id];
    if (raw === undefined || raw === null || raw === "" || Number(raw) === 0) continue;
    const quantity = Number(raw);
    if (!Number.isInteger(quantity) || quantity < 0 || quantity > MAX_QUANTITY)
      return { order: null, error: `Order between 0 and ${MAX_QUANTITY} of each.` };
    lines.push({ name: item.name, quantity, price: item.price });
  }
  if (!lines.length) return { order: null, error: "Choose how many of at least one item." };
  const pence = lines.reduce((sum, l) => sum + Math.round(l.price * 100) * l.quantity, 0);
  return { order: { lines, total: pence / 100 }, error: null };
}

/** An order as lines of the request, for the team, the person's page and emails. */
export function orderAnswers(order: RequestOrder): RequestAnswer[] {
  return [
    ...order.lines.map((l) => ({
      label: l.name,
      value: `${l.quantity} × ${money(l.price)} = ${money(l.price * l.quantity)}`,
    })),
    { label: "Total", value: `${money(order.total)} (invoiced through BluePrint)` },
  ];
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
