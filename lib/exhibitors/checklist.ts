/**
 * A signed-in exhibitor's list of things to do before the show (pure): the
 * bot's deadlines, ticked off by their row of the exhibitor list, and the
 * tasks they can do in the chat. Shown at the top of their chat while
 * something is still to do, and given to Billie with their record so "What
 * do I still need to do?" gets a true answer.
 */
import type { BotLink, ChecklistItem } from "@/lib/types";
import { daysLeft, daysUntil, dueLabel, isDone } from "./deadline-rules";

export const MAX_CHECKLIST = 12;

type Deadline = {
  id: string;
  name: string;
  dueOn: string;
  column: string;
  doneValues: string[];
  linkId: string | null;
};

type Task = {
  id: string;
  name: string;
  deadlineId: string | null;
  /** For this exhibitor's stand (a task can be for some stand types only). */
  open: boolean;
};

export function buildChecklist(input: {
  deadlines: Deadline[];
  /** The exhibitor list's columns: a deadline whose column has gone can't be ticked off. */
  columns: string[];
  /** Their row of the list. */
  fields: Record<string, string>;
  /** The bot's tasks (requests marked as tasks from the exhibitor manual). */
  tasks: Task[];
  /** Tasks they've already sent through Billie. */
  sent: ReadonlySet<string>;
  links: BotLink[];
}): ChecklistItem[] {
  const out: ChecklistItem[] = [];
  const shown = new Set<string>();
  const sorted = [...input.deadlines].sort(
    (a, b) => a.dueOn.localeCompare(b.dueOn) || a.name.localeCompare(b.name),
  );
  for (const d of sorted) {
    if (!input.columns.includes(d.column)) continue;
    const linked = input.tasks.filter((t) => t.deadlineId === d.id);
    linked.forEach((t) => shown.add(t.id));
    // Tied to a task that isn't for their stand (electrics for space only): not theirs.
    if (linked.length && !linked.some((t) => t.open)) continue;
    const task = linked.find((t) => t.open);
    const state = isDone(input.fields, d.column, d.doneValues)
      ? "done"
      : task && input.sent.has(task.id)
        ? "sent"
        : "todo";
    const link = d.linkId ? input.links.find((l) => l.id === d.linkId) : undefined;
    out.push({
      id: d.id,
      name: d.name,
      due: d.dueOn,
      state,
      ...(state === "todo" && task ? { task: task.id } : {}),
      ...(state === "todo" && link ? { link: { label: link.label, url: link.url } } : {}),
    });
  }
  for (const t of input.tasks) {
    if (shown.has(t.id) || !t.open) continue;
    const sent = input.sent.has(t.id);
    out.push({
      id: `task:${t.id}`,
      name: t.name,
      due: null,
      state: sent ? "sent" : "todo",
      ...(sent ? {} : { task: t.id }),
    });
  }
  return out.slice(0, MAX_CHECKLIST);
}

/** Whether to show it: only while something is still to do. */
export function hasToDo(items: ChecklistItem[]): boolean {
  return items.some((i) => i.state === "todo");
}

/** The list as lines for Billie, after their record. */
export function checklistText(items: ChecklistItem[], today: string): string {
  if (!items.length) return "";
  const line = (i: ChecklistItem) => {
    const due = i.due
      ? `due ${dueLabel(i.due)} (${daysLeft(daysUntil(i.due, today))})`
      : "no deadline";
    const state =
      i.state === "done"
        ? "Done."
        : i.state === "sent"
          ? "Sent through this chat: with the team."
          : `Not done yet.${i.link ? ` They do it at "${i.link.label}" (a button in the chat).` : i.task ? " They can do it in this chat (the button for it)." : ""}`;
    return `- ${i.name}: ${due}. ${state}`;
  };
  return ["Things to do before the show:", ...items.map(line)].join("\n");
}
