import { describe, expect, it } from "vitest";
import {
  DEFAULT_PLAN,
  isWeekend,
  nextRound,
  planOf,
  planSummary,
  repeatSubject,
  tooSoon,
  type ReminderPlan,
  type RoundState,
} from "@/lib/exhibitors/reminder-plan";
import { buildChecklist, checklistText, hasToDo } from "@/lib/exhibitors/checklist";

// Wednesday 3 February 2027; the deadline is Sunday 14 February, reminders from 7 days before.
const base = {
  today: "2027-02-03",
  dueOn: "2027-02-14",
  remindDaysBefore: 14,
  plan: DEFAULT_PLAN,
  latest: null as RoundState | null,
  hasSent: false,
};
const weekly: ReminderPlan = { ...DEFAULT_PLAN, repeatDays: 7 };
const round = (s: Partial<RoundState>): RoundState => ({
  status: "sent",
  createdOn: "2027-01-31",
  sentOn: "2027-01-31",
  ...s,
});

describe("when the schedule starts a round", () => {
  it("starts the first round from its reminder day, and never after the deadline", () => {
    expect(nextRound(base)).toBe("first");
    expect(nextRound({ ...base, today: "2027-01-29" })).toBeNull(); // before 31 January
    expect(nextRound({ ...base, today: "2027-02-15" })).toBeNull(); // passed
    expect(nextRound({ ...base, remindDaysBefore: 0 })).toBeNull(); // only when asked
  });

  it("waits for a weekday when asked to", () => {
    expect(isWeekend("2027-02-06")).toBe(true); // Saturday
    expect(isWeekend("2027-02-08")).toBe(false); // Monday
    expect(nextRound({ ...base, today: "2027-02-06" })).toBeNull();
    expect(
      nextRound({ ...base, today: "2027-02-06", plan: { ...DEFAULT_PLAN, weekdaysOnly: false } }),
    ).toBe("first");
  });

  it("does one round at a time, and once only unless the plan repeats", () => {
    expect(nextRound({ ...base, latest: round({ status: "ready", sentOn: null }) })).toBeNull();
    expect(nextRound({ ...base, latest: round({}), hasSent: true })).toBeNull();
    // One made by hand before the reminder day doesn't count.
    expect(nextRound({ ...base, latest: round({ createdOn: "2027-01-20" }) })).toBe("first");
  });

  it("repeats the approved round once enough days have gone", () => {
    const sent = { ...base, plan: weekly, hasSent: true };
    expect(nextRound({ ...sent, latest: round({ sentOn: "2027-01-31" }) })).toBeNull(); // 3 days
    // Made by hand before the reminder day: the reminder day still gets its first round.
    expect(
      nextRound({ ...sent, latest: round({ createdOn: "2027-01-27", sentOn: "2027-01-27" }) }),
    ).toBe("first");
    expect(
      nextRound({
        ...sent,
        remindDaysBefore: 14,
        today: "2027-02-08",
        latest: round({ createdOn: "2027-02-01", sentOn: "2027-02-01" }),
      }),
    ).toBe("repeat");
    // Nothing approved yet (the first was discarded): a new draft to check instead.
    expect(
      nextRound({
        ...sent,
        hasSent: false,
        today: "2027-02-08",
        latest: round({ status: "discarded", createdOn: "2027-02-01", sentOn: null }),
      }),
    ).toBe("first");
  });

  it("marks a repeat's subject once, and keeps reminders apart", () => {
    expect(repeatSubject("Your stand plan is due on 14 February")).toBe(
      "Reminder: Your stand plan is due on 14 February",
    );
    expect(repeatSubject("Reminder: stand plan")).toBe("Reminder: stand plan");
    expect(tooSoon("2027-02-07", "2027-02-08", 2)).toBe(true);
    expect(tooSoon("2027-02-06", "2027-02-08", 2)).toBe(false);
    expect(tooSoon("2027-02-08", "2027-02-08", 1)).toBe(true);
  });

  it("reads a saved plan safely, and says it in a sentence", () => {
    expect(planOf(null)).toEqual(DEFAULT_PLAN);
    expect(planOf({ repeatDays: 5, gapDays: 2, autoSend: "yes", weekdaysOnly: false })).toEqual({
      ...DEFAULT_PLAN,
      weekdaysOnly: false,
    });
    expect(planSummary(DEFAULT_PLAN)).toBe(
      "Billie drafts one round of reminders for each deadline, for you to check, on a weekday.",
    );
    expect(planSummary({ repeatDays: 7, autoSend: true, gapDays: 2, weekdaysOnly: true })).toBe(
      "Billie drafts the first round for you to check, then reminds again every week until they've done it or the deadline passes. Repeats go automatically, in the wording you approved. Nobody gets more than one reminder email in 2 days, and only on weekdays.",
    );
  });
});

describe("an exhibitor's checklist", () => {
  const links = [
    { id: "lbadge", label: "Get your badges", url: "https://visitconnect.test/ukcw", when: "" },
  ];
  const deadlines = [
    {
      id: "d-badges",
      name: "Exhibitor badges",
      dueOn: "2027-04-30",
      column: "Badges",
      doneValues: ["*any"],
      linkId: "lbadge",
    },
    {
      id: "d-plan",
      name: "Stand plan",
      dueOn: "2027-02-14",
      column: "Stand plan approved",
      doneValues: ["yes"],
      linkId: null,
    },
    {
      id: "d-elec",
      name: "Electrics",
      dueOn: "2027-03-01",
      column: "Electrics ordered",
      doneValues: ["yes"],
      linkId: null,
    },
    {
      id: "d-gone",
      name: "Insurance",
      dueOn: "2027-03-01",
      column: "Insurance",
      doneValues: ["yes"],
      linkId: null,
    },
  ];
  const tasks = [
    { id: "elec0001", name: "Electrics order", deadlineId: "d-elec", open: false },
    { id: "name0001", name: "Nameboard", deadlineId: null, open: true },
  ];
  const columns = ["Badges", "Stand plan approved", "Electrics ordered"];

  it("lists their deadlines, soonest first, with how to do each", () => {
    const items = buildChecklist({
      deadlines,
      columns,
      fields: { "Stand plan approved": "Yes", Badges: "" },
      tasks,
      sent: new Set(),
      links,
    });
    expect(items).toEqual([
      { id: "d-plan", name: "Stand plan", due: "2027-02-14", state: "done" },
      {
        id: "d-badges",
        name: "Exhibitor badges",
        due: "2027-04-30",
        state: "todo",
        link: { label: "Get your badges", url: "https://visitconnect.test/ukcw" },
      },
      // Electrics is for space only stands (its task isn't open to them); Insurance's column has gone.
      { id: "task:name0001", name: "Nameboard", due: null, state: "todo", task: "name0001" },
    ]);
    expect(hasToDo(items)).toBe(true);
    expect(checklistText(items, "2027-02-03")).toBe(
      [
        "Things to do before the show:",
        "- Stand plan: due Sunday 14 February 2027 (in 11 days). Done.",
        '- Exhibitor badges: due Friday 30 April 2027 (in 86 days). Not done yet. They do it at "Get your badges" (a button in the chat).',
        "- Nameboard: no deadline. Not done yet. They can do it in this chat (the button for it).",
      ].join("\n"),
    );
  });

  it("ticks off a task they sent through the chat, and has nothing to show when all is done", () => {
    const items = buildChecklist({
      deadlines: deadlines.slice(1, 3),
      columns,
      fields: { "Stand plan approved": "Yes", "Electrics ordered": "" },
      tasks: [{ ...tasks[0], open: true }],
      sent: new Set(["elec0001"]),
      links,
    });
    expect(items.map((i) => [i.name, i.state, i.task ?? null])).toEqual([
      ["Stand plan", "done", null],
      ["Electrics", "sent", null],
    ]);
    expect(hasToDo(items)).toBe(false);
    expect(checklistText([], "2027-02-03")).toBe("");
  });
});
