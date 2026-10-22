import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { agentPresence, botKnowledgeBases, bots, knowledgeBases, users } from "@/lib/db/schema";
import { defaultRules } from "@/lib/bots/defaults";
import { addSource, type NewSource } from "@/lib/knowledge/sources";
import { ingestSource } from "@/lib/knowledge/ingest";
import { putFile } from "@/lib/storage";
import type { Actor } from "@/lib/authz";

/** DB-backed tests run only when TEST_DATABASE_URL is set (CI and local). */
export const hasDb = Boolean(process.env.TEST_DATABASE_URL);

export async function makeUser(role: Actor["role"] = "admin"): Promise<Actor> {
  const email = `${randomUUID().slice(0, 8)}@example.test`;
  const [u] = await db.insert(users).values({ email, fullName: "Sam Tester", role }).returning();
  return { id: u.id, email: u.email, name: u.fullName, role: u.role, status: u.status };
}

export async function makeBot(opts: { audience?: "visitors" | "exhibitors"; status?: "draft" | "live" } = {}) {
  const audience = opts.audience ?? "exhibitors";
  const [kb] = await db.insert(knowledgeBases).values({ name: `KB ${randomUUID().slice(0, 6)}` }).returning();
  const [bot] = await db
    .insert(bots)
    .values({
      name: "Exhibitor Help",
      slug: `bot-${randomUUID().slice(0, 8)}`,
      audience,
      showName: "UKCW London 2027",
      rules: defaultRules(audience),
      status: opts.status ?? "live",
      quality: "fast",
    })
    .returning();
  await db.insert(botKnowledgeBases).values({ botId: bot.id, knowledgeBaseId: kb.id });
  return { bot, kb };
}

/** Adds a source and reads it straight away (no queue), as the job would. */
export async function addAndRead(actor: Actor, kbId: string, input: NewSource): Promise<string> {
  const id = await addSource(actor, kbId, input);
  await ingestSource(id);
  return id;
}

export async function addFixture(actor: Actor, kbId: string, name: string, mimeType: string): Promise<string> {
  const bytes = await readFile(path.join(__dirname, "..", "fixtures", name));
  const fileKey = await putFile(name, bytes, mimeType);
  return addAndRead(actor, kbId, { kind: "file", name, fileKey, size: bytes.length, mimeType });
}

export async function setAvailableAgent(userId: string, available: boolean) {
  const until = available ? new Date(Date.now() + 3_600_000) : null;
  await db
    .insert(agentPresence)
    .values({ userId, availableUntil: until })
    .onConflictDoUpdate({ target: agentPresence.userId, set: { availableUntil: until } });
}

export async function clearPresence() {
  await db.update(agentPresence).set({ availableUntil: null }).where(eq(agentPresence.availableUntil, agentPresence.availableUntil));
}
