"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { runAction } from "@/lib/actions/run";
import { answerQuestion } from "@/lib/ai/answer";
import { answerBotFor, botById } from "@/lib/bots/load";
import {
  createBot,
  deleteBot,
  restoreBot,
  runTests,
  setStatus,
  updateBot,
} from "@/lib/bots/service";
import { CONTACT_FIELDS, PERSONALITY_MAX, SIGN_OFF_MAX } from "@/lib/bots/defaults";
import { AVOID_MAX, LAUNCHER_LABEL_MAX } from "@/lib/bots/style";
import {
  cleanLinks,
  LINK_LABEL_MAX,
  LINK_WHEN_MAX,
  linkProblem,
  MAX_LINKS,
} from "@/lib/bots/links";
import { BAR_LEAD_MAX, BAR_TOPIC_MAX, BAR_TOPICS_MAX, cleanTopics } from "@/lib/chat/bar";
import { validTime } from "@/lib/conversations/hours";
import { UserError } from "@/lib/errors";
import { assertOnBot } from "@/lib/auth/bots";
import { setBotPeople } from "@/lib/bots/people";
import { setSlackPeople } from "@/lib/bots/slack-people";
import { copyBot, markDatesChecked } from "@/lib/bots/copy";
import { MAX_REQUEST_FIELDS, MAX_REQUEST_ITEMS, MAX_REQUEST_TYPES } from "@/lib/requests/rules";
import { showDaysProblem } from "@/lib/bots/show-days";
import { MAX_ROUTES, wordList } from "@/lib/conversations/routes";
import { saveRoutes } from "@/lib/conversations/routing";
import { cleanPageRules, MAX_PAGE_RULES, MAX_STARTERS, NUDGE_MAX } from "@/lib/bots/page-starters";

const AVATAR = /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/;
const EMAIL = /^[^\s@<>()",;:]+@[^\s@<>()",;:]+\.[a-z]{2,}$/i;

const look = z.object({
  name: z
    .string()
    .trim()
    .min(1, "Give the bot a name.")
    .max(60, "Keep the name under 60 characters."),
  audience: z.enum(["visitors", "exhibitors"], {
    error: "Choose what kind of chatbot it is: for exhibitors or for visitors.",
  }),
  showName: z.string().trim().max(80),
  contactEmail: z
    .string()
    .trim()
    .toLowerCase()
    .max(200)
    .refine((v) => !v || EMAIL.test(v), "Enter the event team's email address, like ops@show.com.")
    .optional(),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/, "Pick a colour."),
  avatarUrl: z
    .string()
    .max(200_000, "That picture is too large.")
    .regex(AVATAR, "Use a PNG, JPEG or WebP picture.")
    .nullable(),
  accentColor: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/, "Pick a colour.")
    .nullable()
    .optional(),
  logoUrl: z
    .string()
    .max(200_000, "That logo is too large.")
    .regex(AVATAR, "Use a PNG, JPEG or WebP logo.")
    .nullable()
    .optional(),
  launcherLabel: z
    .string()
    .trim()
    .max(LAUNCHER_LABEL_MAX, `Keep the button's words under ${LAUNCHER_LABEL_MAX} characters.`)
    .optional(),
  launcherStyle: z.enum(["button", "bar"]).optional(),
  barLead: z
    .string()
    .trim()
    .max(BAR_LEAD_MAX, `Keep the opening words under ${BAR_LEAD_MAX} characters.`)
    .optional(),
  barTopics: z
    .array(
      z.string().trim().max(BAR_TOPIC_MAX, `Keep each topic under ${BAR_TOPIC_MAX} characters.`),
    )
    .max(BAR_TOPICS_MAX, `Up to ${BAR_TOPICS_MAX} topics.`)
    .transform(cleanTopics)
    .optional(),
  barMascot: z.enum(["robot", "picture", "none"]).optional(),
  barMotion: z.boolean().optional(),
  welcome: z.string().trim().max(300),
  starters: z
    .array(z.string().trim().max(80))
    .max(3)
    .transform((a) => a.filter(Boolean)),
  /** Different starters on some pages: "the page address contains …". */
  pageStarters: z
    .array(
      z.object({
        match: z.string().trim().min(1, "Say which pages, e.g. /travel.").max(200),
        starters: z.array(z.string().trim().max(80)).max(MAX_STARTERS),
        nudge: z
          .string()
          .trim()
          .max(NUDGE_MAX, `Keep the nudge under ${NUDGE_MAX} characters.`)
          .optional(),
      }),
    )
    .max(MAX_PAGE_RULES, `Up to ${MAX_PAGE_RULES} page rules.`)
    .transform(cleanPageRules)
    .optional(),
  /** Build-up to breakdown, or null for none. */
  showDays: z
    .object({ from: z.string().max(10), to: z.string().max(10) })
    .superRefine((d, ctx) => {
      const problem = showDaysProblem(d);
      if (problem)
        ctx.addIssue({ code: "custom", message: problem.message, path: [problem.field] });
    })
    .nullable()
    .optional(),
});

const rules = z.object({
  alwaysHuman: z.array(z.string().trim().min(1).max(60)).max(20),
  hours: z.object({
    days: z.array(z.number().int().min(0).max(6)).max(7),
    start: z.string().refine(validTime, "Use a time like 09:00."),
    end: z.string().refine(validTime, "Use a time like 17:30."),
  }),
  collect: z
    .array(z.enum(CONTACT_FIELDS as [string, ...string[]]))
    .transform((a) => a as typeof CONTACT_FIELDS),
  promise: z.string().trim().min(3).max(60),
});

const patch = z.object({
  id: z.uuid(),
  look: look.partial().optional(),
  tone: z.enum(["friendly", "formal", "brief"]).optional(),
  personality: z
    .string()
    .trim()
    .max(PERSONALITY_MAX, `Keep it under ${PERSONALITY_MAX} characters.`)
    .optional(),
  emoji: z.boolean().optional(),
  answerLength: z.enum(["short", "normal", "detailed"]).optional(),
  useName: z.boolean().optional(),
  avoidWords: z
    .string()
    .trim()
    .max(AVOID_MAX, `Keep the words to avoid under ${AVOID_MAX} characters.`)
    .optional(),
  emailSignOff: z
    .string()
    .trim()
    .max(SIGN_OFF_MAX, `Keep the sign-off under ${SIGN_OFF_MAX} characters.`)
    .optional(),
  quality: z.enum(["fast", "thorough"]).optional(),
  personalAnswers: z.boolean().optional(),
  exhibitorsOnly: z.boolean().optional(),
  rules: rules.optional(),
  domains: z.array(z.string().max(253)).max(30).optional(),
  tests: z
    .array(
      z.object({
        id: z.string().min(1).max(40),
        question: z.string().trim().min(1).max(300),
        mustMention: z.string().trim().max(120),
      }),
    )
    .max(50)
    .optional(),
  /** Links Billie can share as buttons (Rules step, lib/bots/links.ts). */
  links: z
    .array(
      z.object({
        id: z.string().max(20),
        label: z
          .string()
          .trim()
          .min(2, "Give the button its words, e.g. Register to visit.")
          .max(LINK_LABEL_MAX, `Keep the button's words under ${LINK_LABEL_MAX} characters.`),
        url: z
          .string()
          .trim()
          .superRefine((u, ctx) => {
            const problem = linkProblem(u);
            if (problem) ctx.addIssue({ code: "custom", message: problem });
          }),
        when: z
          .string()
          .trim()
          .min(5, "Say when Billie should offer it.")
          .max(LINK_WHEN_MAX, `Keep it under ${LINK_WHEN_MAX} characters.`),
      }),
    )
    .max(MAX_LINKS, `Up to ${MAX_LINKS} links.`)
    .transform(cleanLinks)
    .optional(),
  requestTypes: z
    .array(
      z.object({
        id: z.string().regex(/^[a-z0-9]{4,20}$/),
        name: z.string().trim().min(2, "Give the request a name.").max(60),
        when: z.string().trim().min(5, "Say when the bot should offer it.").max(200),
        handlerId: z.uuid().nullable(),
        fields: z
          .array(
            z.object({
              id: z.string().regex(/^[a-z0-9]{4,20}$/),
              label: z.string().trim().min(2, "Write the question.").max(80),
              kind: z.enum(["short", "long", "date"]),
              required: z.boolean(),
            }),
          )
          .max(MAX_REQUEST_FIELDS),
        task: z.boolean().optional(),
        crm: z.boolean().optional(),
        forColumn: z.string().trim().max(80).nullable().optional(),
        forValues: z.array(z.string().trim().min(1).max(80)).max(20).optional(),
        items: z
          .array(
            z.object({
              id: z.string().regex(/^[a-z0-9]{4,20}$/),
              name: z.string().trim().min(1, "Name the item.").max(80),
              price: z
                .number("Give the item a price.")
                .min(0, "A price can't be below £0.")
                .max(100_000, "Check the price.")
                .transform((p) => Math.round(p * 100) / 100),
            }),
          )
          .max(MAX_REQUEST_ITEMS, `Up to ${MAX_REQUEST_ITEMS} items.`)
          .optional(),
        deadlineId: z.uuid().nullable().optional(),
      }),
    )
    .max(MAX_REQUEST_TYPES, `A bot can take up to ${MAX_REQUEST_TYPES} requests.`)
    .optional(),
});

function refresh(id?: string) {
  revalidatePath("/");
  if (id) revalidatePath(`/bots/${id}`);
}

// A new bot needs the event team's email: suspicious chats are sent there.
const newBot = look.refine((d) => Boolean(d.contactEmail), {
  path: ["contactEmail"],
  error: "Enter the event team's email. Billie gives it to anyone it can't help.",
});

export async function createBotAction(input: unknown) {
  return runAction("bots.edit", newBot, input, async (actor, data) => {
    const id = await createBot(actor, data);
    refresh();
    return { id };
  });
}

export async function updateBotAction(input: unknown) {
  return runAction(
    "bots.edit",
    patch,
    input,
    async (actor, data) => {
      await assertOnBot(actor, "bots.edit", data.id);
      await updateBot(actor, data.id, {
        ...(data.look ?? {}),
        ...(data.tone ? { tone: data.tone } : {}),
        ...(data.personality !== undefined ? { personality: data.personality } : {}),
        ...(data.emoji !== undefined ? { emoji: data.emoji } : {}),
        ...(data.answerLength ? { answerLength: data.answerLength } : {}),
        ...(data.useName !== undefined ? { useName: data.useName } : {}),
        ...(data.avoidWords !== undefined ? { avoidWords: data.avoidWords } : {}),
        ...(data.emailSignOff !== undefined ? { emailSignOff: data.emailSignOff } : {}),
        ...(data.quality ? { quality: data.quality } : {}),
        ...(data.personalAnswers !== undefined ? { personalAnswers: data.personalAnswers } : {}),
        ...(data.exhibitorsOnly !== undefined ? { exhibitorsOnly: data.exhibitorsOnly } : {}),
        ...(data.rules ? { rules: data.rules } : {}),
        ...(data.domains ? { domains: data.domains } : {}),
        ...(data.tests ? { tests: data.tests } : {}),
        ...(data.requestTypes ? { requestTypes: data.requestTypes } : {}),
        ...(data.links ? { links: data.links } : {}),
      });
      refresh(data.id);
    },
    "Saved.",
  );
}

export async function setBotStatusAction(input: unknown) {
  return runAction(
    "bots.publish",
    z.object({ id: z.uuid(), status: z.enum(["draft", "live"]) }),
    input,
    async (actor, d) => {
      await assertOnBot(actor, "bots.publish", d.id);
      await setStatus(actor, d.id, d.status);
      refresh(d.id);
    },
  );
}

export async function deleteBotAction(input: unknown) {
  return runAction("bots.delete", z.object({ id: z.uuid() }), input, async (actor, d) => {
    await assertOnBot(actor, "bots.delete", d.id);
    await deleteBot(actor, d.id);
    refresh();
  });
}

export async function restoreBotAction(input: unknown) {
  return runAction("bots.delete", z.object({ id: z.uuid() }), input, async (actor, d) => {
    await assertOnBot(actor, "bots.delete", d.id);
    await restoreBot(actor, d.id);
    refresh();
  });
}

export async function runTestsAction(input: unknown) {
  return runAction("bots.edit", z.object({ id: z.uuid() }), input, async (actor, d) => {
    await assertOnBot(actor, "bots.edit", d.id);
    const run = await runTests(actor, d.id);
    refresh(d.id);
    return run;
  });
}

/** The test console: answers like the live bot but saves nothing. */
export async function testAskAction(input: unknown) {
  const schema = z.object({
    id: z.uuid(),
    question: z.string().trim().min(1).max(2000),
    history: z
      .array(z.object({ role: z.enum(["visitor", "bot"]), text: z.string().max(4000) }))
      .max(20),
  });
  return runAction("bots.view", schema, input, async (actor, d) => {
    await assertOnBot(actor, "bots.view", d.id);
    const bot = await botById(d.id);
    if (!bot) throw new UserError("That bot no longer exists.");
    const a = await answerQuestion({
      bot: await answerBotFor(bot),
      history: d.history,
      question: d.question,
    });
    return {
      answer: a.answer,
      sources: a.sources.map((s) => ({ title: s.title, label: s.label })),
      handover: a.handover,
      request: bot.requestTypes.find((t) => t.id === a.request)?.name ?? null,
    };
  });
}

/** Who works on a bot (admins only; admins work on every bot). */
export async function setBotPeopleAction(input: unknown) {
  return runAction(
    "team.manage",
    z.object({ botId: z.uuid(), userIds: z.array(z.uuid()).max(500) }),
    input,
    async (actor, d) => {
      await setBotPeople(actor, d.botId, d.userIds);
      refresh(d.botId);
      revalidatePath("/settings");
    },
    "Saved.",
  );
}

/** Who's told in Slack about this bot's chats (its show's team), instead of @here. */
export async function setSlackPeopleAction(input: unknown) {
  return runAction(
    "team.manage",
    z.object({ botId: z.uuid(), userIds: z.array(z.uuid()).max(100) }),
    input,
    async (actor, d) => {
      await setSlackPeople(actor, d.botId, d.userIds);
      refresh(d.botId);
    },
    "Saved.",
  );
}

/** Who handles what: chats and emails about a topic go to that person first. */
export async function saveRoutesAction(input: unknown) {
  return runAction(
    "bots.edit",
    z.object({
      botId: z.uuid(),
      routes: z
        .array(
          z.object({
            id: z.string().regex(/^[a-z0-9]{4,20}$/),
            topic: z.string().trim().min(2, "Name the topic.").max(60),
            words: z
              .string()
              .max(600)
              .transform(wordList)
              .refine((w) => w.length > 0, "Give at least one word that means it."),
            userId: z.uuid("Choose who it goes to."),
          }),
        )
        .max(MAX_ROUTES, `Up to ${MAX_ROUTES} topics.`),
    }),
    input,
    async (actor, d) => {
      await assertOnBot(actor, "bots.edit", d.botId);
      await saveRoutes(actor, d.botId, d.routes);
      refresh(d.botId);
    },
    "Saved.",
  );
}

/** A copy of a bot for the next show or edition (a draft, with its dates to check). */
export async function copyBotAction(input: unknown) {
  const schema = z.object({
    id: z.uuid(),
    name: z
      .string()
      .trim()
      .min(1, "Give the copy a name.")
      .max(60, "Keep the name under 60 characters."),
    showName: z.string().trim().max(80).default(""),
  });
  return runAction("bots.edit", schema, input, async (actor, d) => {
    await assertOnBot(actor, "bots.edit", d.id);
    const id = await copyBot(actor, d.id, { name: d.name, showName: d.showName });
    refresh();
    return { id };
  });
}

/** The dates in a copied bot have been checked. */
export async function datesCheckedAction(input: unknown) {
  return runAction("bots.edit", z.object({ id: z.uuid() }), input, async (actor, d) => {
    await assertOnBot(actor, "bots.edit", d.id);
    await markDatesChecked(actor, d.id);
    refresh(d.id);
  });
}
