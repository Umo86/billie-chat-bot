import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { auditLog, bots, chatRequests, conversations, exhibitors } from "@/lib/db/schema";
import { uploadList } from "@/lib/exhibitors/service";
import { makeBlueprintKey } from "@/lib/exhibitors/blueprint";
import { botById } from "@/lib/bots/load";
import {
  ChatError,
  startConversation,
  startTask,
  submitRequest,
  visitorUpdates,
} from "@/lib/conversations/service";
import { cleanOrder, orderAnswers } from "@/lib/requests/rules";
import { outstandingTasks, taskExhibitor, typesFor } from "@/lib/requests/tasks";
import { GET as tasksGet, POST as tasksPost } from "@/app/api/public/blueprint/tasks/route";
import type { RequestType } from "@/lib/types";
import { hasDb, makeBot, makeUser } from "../helpers/db";

vi.mock("next/headers", () => ({
  headers: async () => new Headers({ "x-forwarded-for": "203.0.113.9" }),
}));
vi.mock("@/lib/jobs/kick", () => ({ kickJobs: async () => undefined }));

const csv = (rows: string[][]) =>
  Buffer.from(rows.map((r) => r.map((c) => `"${c}"`).join(",")).join("\n"));

const TYPES: RequestType[] = [
  {
    id: "elec0001",
    name: "Electrics order",
    when: "They want electrics for a space only stand.",
    handlerId: null,
    task: true,
    forColumn: "Stand type",
    forValues: ["Space only"],
    items: [
      { id: "sock0001", name: "16A single socket", price: 120 },
      { id: "lamp0001", name: "Floodlight", price: 45.5 },
    ],
    fields: [],
  },
  {
    id: "name0001",
    name: "Nameboard",
    when: "They want to give the name on their shell scheme nameboard.",
    handlerId: null,
    task: true,
    forColumn: "Stand type",
    forValues: ["Shell scheme"],
    fields: [{ id: "text0001", label: "Name on the nameboard", kind: "short", required: true }],
  },
  {
    id: "hour0001",
    name: "Extra build-up hours",
    when: "They need to work outside the build-up hours.",
    handlerId: null,
    fields: [{ id: "when0001", label: "When", kind: "long", required: true }],
  },
];

describe.skipIf(!hasDb)("tasks from the exhibitor manual, done in the chat (Postgres)", () => {
  it("lists a signed-in exhibitor's tasks for their stand, takes the order, and BluePrint collects it", async () => {
    const admin = await makeUser("admin");
    const { bot: made } = await makeBot();
    const d = randomUUID().slice(0, 8);
    const sam = `sam@acme-${d}.test`;
    await uploadList(admin, made.id, {
      name: "exhibitors.csv",
      bytes: csv([
        ["Company", "Stand", "Contact", "Email", "Stand type"],
        ["Acme Ltd", "B12", "Sam Patel", sam, "Space only"],
        ["Bolt & Co", "C4", "Jo Bloggs", `jo@bolt-${d}.test`, "Shell scheme"],
      ]),
    });
    await db
      .update(bots)
      .set({ requestTypes: TYPES, personalAnswers: true })
      .where(eq(bots.id, made.id));
    const bot = (await botById(made.id))!;
    const [row] = await db
      .select()
      .from(exhibitors)
      .where(and(eq(exhibitors.botId, bot.id), eq(exhibitors.stand, "B12")));

    // Not signed in: only the request for everyone, and no tasks.
    const { conversation } = await startConversation({ bot, channel: "web" });
    expect(typesFor(bot, null).map((t) => t.id)).toEqual(["hour0001"]);
    expect((await visitorUpdates(bot, conversation, null)).checklist).toBeUndefined();

    // Signed in as Sam, a space only stand: the electrics order, not the nameboard.
    await db
      .update(conversations)
      .set({ exhibitorId: row.id, signedInEmail: sam, signedInAt: new Date() })
      .where(eq(conversations.id, conversation.id));
    const signed = (await db.query.conversations.findFirst({
      where: eq(conversations.id, conversation.id),
    }))!;
    expect((await visitorUpdates(bot, signed, null)).checklist).toEqual([
      { id: "task:elec0001", name: "Electrics order", due: null, state: "todo", task: "elec0001" },
    ]);
    await expect(startTask(bot, conversation.id, "name0001")).rejects.toBeInstanceOf(ChatError);

    // Pressing it: the form, with the items and Sam's details, and no Claude call.
    const turn = await startTask(bot, conversation.id, "elec0001");
    expect(turn.request).toMatchObject({
      typeId: "elec0001",
      items: TYPES[0].items,
      known: { name: "Sam Patel", company: "Acme Ltd", stand: "B12", email: sam },
    });
    expect(turn.messages[0].text).toMatch(/^Here's the Electrics order form/);

    // Sent: the order at the team's prices, kept with the exhibitor; nothing left to do.
    const { order } = cleanOrder(TYPES[0], { sock0001: 2, lamp0001: 1 });
    const done = await submitRequest(
      bot,
      conversation.id,
      TYPES[0],
      orderAnswers(order!),
      { name: "Sam Patel", email: sam, company: "Acme Ltd", stand: "B12" },
      { order, exhibitorId: row.id },
    );
    // Sent: on their list as sent, and with nothing else to do the list goes.
    expect(done.checklist).toBeUndefined();
    expect(await outstandingTasks(bot, await taskExhibitor(signed))).toEqual([]);
    const [req] = await db
      .select()
      .from(chatRequests)
      .where(eq(chatRequests.conversationId, conversation.id));
    expect(req).toMatchObject({ exhibitorId: row.id, order: { total: 285.5 } });

    // BluePrint collects it with the bot's key, and says it's done.
    const key = await makeBlueprintKey(admin, bot.id);
    const auth = { authorization: `Bearer ${key}` };
    const url = "https://billie.test/api/public/blueprint/tasks";
    const res = await tasksGet(new Request(`${url}?after=${req.ref - 1}`, { headers: auth }));
    const got = await res.json();
    expect(got.tasks[0]).toMatchObject({
      number: req.ref,
      type: "Electrics order",
      status: "new",
      exhibitor: { company: "Acme Ltd", stand: "B12", email: sam },
      order: { total: 285.5 },
    });
    expect(got.next).toBe(req.ref);
    expect(
      (await tasksGet(new Request(url, { headers: { authorization: "Bearer bp_wrong" } }))).status,
    ).toBe(401);
    const post = await tasksPost(
      new Request(url, {
        method: "POST",
        headers: { ...auth, "content-type": "application/json" },
        body: JSON.stringify({ ref: `R-${req.ref}`, status: "done", note: "Invoice sent." }),
      }),
    );
    expect(post.status).toBe(200);
    const after = await db.query.chatRequests.findFirst({ where: eq(chatRequests.id, req.id) });
    expect(after).toMatchObject({ status: "done", note: "Invoice sent." });
    const audit = await db.select().from(auditLog).where(eq(auditLog.entityId, req.id));
    expect(audit.map((a) => a.summary)).toContain(
      `BluePrint updated the message on R-${req.ref}, marked R-${req.ref} as done`,
    );
    // Another bot's request can't be touched with this key.
    const other = await tasksPost(
      new Request(url, {
        method: "POST",
        headers: { ...auth, "content-type": "application/json" },
        body: JSON.stringify({ ref: 999999999, status: "done" }),
      }),
    );
    expect(other.status).toBe(404);
  });
});
