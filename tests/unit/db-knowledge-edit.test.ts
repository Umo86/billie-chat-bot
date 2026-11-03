import { afterEach, describe, expect, it, vi } from "vitest";
import { and, eq, like } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { auditLog, jobs, passages, sources } from "@/lib/db/schema";
import { ingestSource } from "@/lib/knowledge/ingest";
import {
  editSource,
  previewReplace,
  replaceInKnowledge,
  sourceForEdit,
} from "@/lib/knowledge/edit";
import { retrieve } from "@/lib/knowledge/search";
import { addAndRead, hasDb, makeBot, makeUser } from "../helpers/db";

// Lets a test change the source while Billie is half-way through reading it.
const during = vi.hoisted(() => ({ embed: null as null | (() => Promise<void>) }));
vi.mock("@/lib/knowledge/embed", () => ({
  embeddingsEnabled: () => false,
  embedQuery: async () => null,
  embed: async () => {
    await during.embed?.();
    return null;
  },
}));

async function textOf(sourceId: string) {
  const rows = await db
    .select({ text: passages.text })
    .from(passages)
    .where(eq(passages.sourceId, sourceId))
    .orderBy(passages.ordinal);
  return rows.map((r) => r.text).join("\n\n");
}

async function readQueued(sourceId: string) {
  const queued = await db
    .select()
    .from(jobs)
    .where(and(eq(jobs.kind, "ingest_source"), like(jobs.dedupeKey, `ingest:${sourceId}%`)));
  for (const j of queued.filter((j) => j.status === "queued")) {
    await ingestSource(sourceId);
    await db.update(jobs).set({ status: "done" }).where(eq(jobs.id, j.id));
  }
  return queued;
}

describe.skipIf(!hasDb)("editing knowledge in place (Postgres)", () => {
  afterEach(() => {
    during.embed = null;
  });

  it("edits pasted text: saves it, reads it again and records who changed it", async () => {
    const editor = await makeUser("editor");
    const { kb } = await makeBot();
    const id = await addAndRead(editor, kb.id, {
      kind: "text",
      title: "Electrics",
      body: "The 2KW socket is 8amp.",
    });
    expect(await sourceForEdit(id)).toMatchObject({
      kind: "text",
      title: "Electrics",
      body: "The 2KW socket is 8amp.",
      version: expect.stringMatching(/^[0-9a-f]{16}$/),
    });

    const changed = await editSource(editor, id, {
      kind: "text",
      title: "Electrics and power",
      body: "The 2KW socket is 10amp.",
    });
    expect(changed).toBe(true);
    const row = await db.query.sources.findFirst({ where: eq(sources.id, id) });
    expect(row).toMatchObject({ title: "Electrics and power", status: "queued" });
    expect(await readQueued(id)).not.toHaveLength(0);
    expect(await textOf(id)).toBe("The 2KW socket is 10amp.");

    const audit = await db.select().from(auditLog).where(eq(auditLog.entityId, id));
    expect(audit.map((a) => a.summary)).toContain('Edited "Electrics" (now "Electrics and power")');
    // Saving the same text again changes nothing and reads nothing.
    expect(
      await editSource(editor, id, {
        kind: "text",
        title: "Electrics and power",
        body: "The 2KW socket is 10amp.",
      }),
    ).toBe(false);
  });

  it("edits a typed answer's question and answer", async () => {
    const editor = await makeUser("editor");
    const { kb } = await makeBot();
    const id = await addAndRead(editor, kb.id, {
      kind: "qa",
      question: "When does build-up start?",
      answer: "Monday at 8am.",
    });
    expect(await sourceForEdit(id)).toMatchObject({
      kind: "qa",
      question: "When does build-up start?",
      answer: "Monday at 8am.",
    });
    await editSource(editor, id, {
      kind: "qa",
      question: "When does space only build-up start?",
      answer: "Tuesday 24 November at 10:30.",
    });
    await readQueued(id);
    expect(await textOf(id)).toBe(
      "Q: When does space only build-up start?\nA: Tuesday 24 November at 10:30.",
    );
    expect((await db.query.sources.findFirst({ where: eq(sources.id, id) }))?.title).toBe(
      "When does space only build-up start?",
    );
  });

  it("never lets a read of the old text overwrite the new one", async () => {
    const editor = await makeUser("editor");
    const { kb } = await makeBot();
    const id = await addAndRead(editor, kb.id, { kind: "text", title: "Hours", body: "Old." });
    await db.update(sources).set({ body: "Older." }).where(eq(sources.id, id));
    // A read of "Older." is running when someone saves "New.".
    during.embed = async () => {
      during.embed = null;
      await editSource(editor, id, { kind: "text", title: "Hours", body: "New." });
    };
    await ingestSource(id);
    expect(await textOf(id)).toBe("Old."); // the stale read wrote nothing
    // The edit queued its own read, which isn't blocked by the one that was running.
    await readQueued(id);
    expect(await textOf(id)).toBe("New.");
  });

  it("keeps answering from the old text until the new one is read", async () => {
    const editor = await makeUser("editor");
    const { kb } = await makeBot();
    const id = await addAndRead(editor, kb.id, {
      kind: "text",
      title: "Breakdown",
      body: "Breakdown ends at 22:00 on Sunday.",
    });
    await editSource(editor, id, {
      kind: "text",
      title: "Breakdown",
      body: "Breakdown ends at 22:30 on Sunday.",
    });
    // Waiting to be read again: bots still have the old passage.
    const before = await retrieve([kb.id], "When does breakdown end?");
    expect(before.map((p) => p.text)).toEqual(["Breakdown ends at 22:00 on Sunday."]);
    await readQueued(id);
    const after = await retrieve([kb.id], "When does breakdown end?");
    expect(after.map((p) => p.text)).toEqual(["Breakdown ends at 22:30 on Sunday."]);
  });

  it("never saves over a newer change made while the Edit dialog was open", async () => {
    const editor = await makeUser("editor");
    const { kb } = await makeBot();
    const id = await addAndRead(editor, kb.id, { kind: "text", title: "Contacts", body: "Old." });
    const opened = await sourceForEdit(id);
    await replaceInKnowledge(editor, kb.id, "Old", "Newer");
    await expect(
      editSource(editor, id, { kind: "text", title: "Contacts", body: "Mine." }, opened.version),
    ).rejects.toThrow(/changed after you opened it/);
    const fresh = await sourceForEdit(id);
    expect(fresh).toMatchObject({ body: "Newer." });
    expect(
      await editSource(
        editor,
        id,
        { kind: "text", title: "Contacts", body: "Mine." },
        fresh.version,
      ),
    ).toBe(true);
  });

  it("reads the newest text even after a run of quick edits", async () => {
    const editor = await makeUser("editor");
    const { kb } = await makeBot();
    const id = await addAndRead(editor, kb.id, { kind: "text", title: "T", body: "v1" });
    await editSource(editor, id, { kind: "text", title: "T", body: "v2" });
    await editSource(editor, id, { kind: "text", title: "T", body: "v3" });
    // Both reads are running (both read v3) when v2 is saved again.
    await db
      .update(jobs)
      .set({ status: "running" })
      .where(and(eq(jobs.kind, "ingest_source"), like(jobs.dedupeKey, `ingest:${id}:%`)));
    during.embed = async () => {
      during.embed = null;
      await editSource(editor, id, { kind: "text", title: "T", body: "v2" });
    };
    await ingestSource(id); // reads v3, finds v2: writes nothing, queues a fresh read
    await ingestSource(id); // the other running read: the same
    await readQueued(id);
    expect(await textOf(id)).toBe("v2");
    expect((await db.query.sources.findFirst({ where: eq(sources.id, id) }))?.status).toBe("ready");
  });

  it("won't edit files or web pages", async () => {
    const editor = await makeUser("editor");
    const { kb } = await makeBot();
    const [file] = await db
      .insert(sources)
      .values({ knowledgeBaseId: kb.id, kind: "file", title: "Manual", status: "ready" })
      .returning();
    await expect(sourceForEdit(file.id)).rejects.toThrow(/can't be edited here/);
    await expect(
      editSource(editor, file.id, { kind: "text", title: "x", body: "y" }),
    ).rejects.toThrow(/can't be edited here/);
  });
});

describe.skipIf(!hasDb)("find and replace across a knowledge base (Postgres)", () => {
  it("previews every match, changes pasted text and typed answers, and lists files", async () => {
    const editor = await makeUser("editor");
    const { kb } = await makeBot();
    const other = await makeBot(); // another knowledge base is never touched
    const text = await addAndRead(editor, kb.id, {
      kind: "text",
      title: "Contacts",
      body: "Email idealhomeshow@eventcreate.co.uk. EventCreate replies within a day.",
    });
    const qa = await addAndRead(editor, kb.id, {
      kind: "qa",
      question: "Who issues manual logins?",
      answer: "EventCreate, from IDEALHOMESHOW@EVENTCREATE.CO.UK.",
    });
    const none = await addAndRead(editor, kb.id, { kind: "text", title: "Hours", body: "10:00." });
    const elsewhere = await addAndRead(editor, other.kb.id, {
      kind: "text",
      title: "Other show",
      body: "idealhomeshow@eventcreate.co.uk",
    });
    const [file] = await db
      .insert(sources)
      .values({ knowledgeBaseId: kb.id, kind: "file", title: "Sales FAQ", status: "ready" })
      .returning();
    await db.insert(passages).values({
      sourceId: file.id,
      knowledgeBaseId: kb.id,
      ordinal: 0,
      text: "Queries to idealhomeshow@eventcreate.co.uk please.",
    });

    const find = "idealhomeshow@eventcreate.co.uk";
    const preview = await previewReplace(kb.id, find, "ops@media10.test");
    expect(preview.editable.map((s) => [s.title, s.kind, s.count])).toEqual([
      ["Contacts", "text", 1],
      ["Who issues manual logins?", "qa", 1],
    ]);
    expect(preview.editable[0].samples[0]).toMatchObject({
      before: expect.stringContaining("Email idealhomeshow@eventcreate.co.uk."),
      after: expect.stringContaining("Email ops@media10.test."),
    });
    expect(preview.elsewhere).toEqual([
      { id: file.id, title: "Sales FAQ", kind: "file", count: 1 },
    ]);

    expect(await replaceInKnowledge(editor, kb.id, find, "ops@media10.test")).toEqual({
      sources: 2,
      matches: 2,
    });
    await readQueued(text);
    await readQueued(qa);
    expect(await textOf(text)).toBe("Email ops@media10.test. EventCreate replies within a day.");
    expect(await textOf(qa)).toBe(
      "Q: Who issues manual logins?\nA: EventCreate, from ops@media10.test.",
    );
    expect(await textOf(none)).toBe("10:00.");
    expect(await textOf(elsewhere)).toBe("idealhomeshow@eventcreate.co.uk");
    expect(await textOf(file.id)).toContain("idealhomeshow@eventcreate.co.uk"); // files aren't changed

    const audit = await db.select().from(auditLog).where(eq(auditLog.entityId, text));
    expect(audit.map((a) => a.summary)).toContain(`Replaced text in "Contacts" (${kb.name})`);
    // The text itself (often an email address or phone number) never goes in the log.
    expect(JSON.stringify(audit)).not.toContain("ops@media10.test");
    // Nothing left to replace.
    expect(await replaceInKnowledge(editor, kb.id, find, "ops@media10.test")).toEqual({
      sources: 0,
      matches: 0,
    });
  });

  it("renames a typed answer when its question changes", async () => {
    const editor = await makeUser("editor");
    const { kb } = await makeBot();
    const qa = await addAndRead(editor, kb.id, {
      kind: "qa",
      question: "Can EventCreate resend my login?",
      answer: "Yes, ask EventCreate.",
    });
    await replaceInKnowledge(editor, kb.id, "EventCreate", "the Operations team");
    const row = await db.query.sources.findFirst({ where: eq(sources.id, qa) });
    expect(row?.title).toBe("Can the Operations team resend my login?");
    expect(row?.body).toBe(
      "Q: Can the Operations team resend my login?\nA: Yes, ask the Operations team.",
    );
  });
});
