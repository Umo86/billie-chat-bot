"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { CheckCircle2, ListChecks, Play, Plus, Send, Trash2, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Chip, Note, Panel } from "@/components/ui/bits";
import { Input } from "@/components/ui/form";
import { useRunner } from "@/components/ui/use-runner";
import { runTestsAction, testAskAction, updateBotAction } from "@/app/actions/bots";
import type { HandoverKind, TestQuestion, TestRun } from "@/lib/types";

type Line =
  | { role: "visitor"; text: string }
  | {
      role: "bot";
      text: string;
      sources: { title: string; label: string }[];
      handover: HandoverKind;
    };

const HANDOVER_NOTE: Record<HandoverKind, string | null> = {
  none: null,
  unknown: "Not in the knowledge, so this would go to the team.",
  always_human: "An always-a-person topic, so this would go to the team.",
  asked_for_person: "They asked for a person, so this would go to the team.",
};

const newId = () => Math.random().toString(36).slice(2, 10);

export function TestStep({
  botId,
  tests: initialTests,
  lastRun,
  canEdit,
}: {
  botId: string;
  tests: TestQuestion[];
  lastRun: TestRun | null;
  canEdit: boolean;
}) {
  const router = useRouter();
  const [lines, setLines] = useState<Line[]>([]);
  const [question, setQuestion] = useState("");
  const [tests, setTests] = useState<TestQuestion[]>(initialTests);
  const [dirty, setDirty] = useState(false);
  const [run, setRun] = useState<TestRun | null>(lastRun);
  const ask = useRunner();
  const save = useRunner();
  const runner = useRunner();

  function send(e: React.FormEvent) {
    e.preventDefault();
    const q = question.trim();
    if (!q) return;
    const history = lines.slice(-10).map((l) => ({ role: l.role, text: l.text }));
    setLines((ls) => [...ls, { role: "visitor", text: q }]);
    setQuestion("");
    ask.run(() => testAskAction({ id: botId, question: q, history }), {
      done: (d) =>
        d &&
        setLines((ls) => [
          ...ls,
          { role: "bot", text: d.answer, sources: d.sources, handover: d.handover },
        ]),
    });
  }

  function addTest(q = "") {
    setTests((t) => [...t, { id: newId(), question: q, mustMention: "" }].slice(0, 50));
    setDirty(true);
  }

  function saveTests(then?: () => void) {
    const clean = tests.filter((t) => t.question.trim());
    save.run(() => updateBotAction({ id: botId, tests: clean }), {
      done: () => {
        setTests(clean);
        setDirty(false);
        then?.();
      },
    });
  }

  function runAll() {
    const go = () =>
      runner.run(() => runTestsAction({ id: botId }), {
        done: (r) => {
          if (r) setRun(r);
          router.refresh();
        },
      });
    if (dirty) saveTests(go);
    else go();
  }

  return (
    <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
      <Panel className="flex min-h-[420px] flex-col gap-3">
        <div>
          <h2 className="text-[1.05rem]">Try it</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Ask what exhibitors or visitors would ask. Nothing here is saved or seen by anyone.
          </p>
        </div>
        <ol className="flex flex-1 flex-col gap-2.5 overflow-y-auto" aria-live="polite">
          {lines.map((l, i) =>
            l.role === "visitor" ? (
              <li
                key={i}
                className="max-w-[85%] self-end rounded-[14px] rounded-tr-sm bg-primary px-3 py-2 text-primary-foreground"
              >
                <p className="whitespace-pre-wrap text-[0.92rem]">{l.text}</p>
                {canEdit ? (
                  <button
                    type="button"
                    onClick={() => addTest(l.text)}
                    className="mt-1 cursor-pointer text-xs font-semibold underline opacity-85"
                  >
                    Save as a test question
                  </button>
                ) : null}
              </li>
            ) : (
              <li key={i} className="flex max-w-[90%] flex-col gap-1.5">
                <p className="whitespace-pre-wrap rounded-[14px] rounded-tl-sm bg-muted px-3 py-2 text-[0.92rem]">
                  {l.text}
                </p>
                {l.sources.length ? (
                  <p className="text-xs text-muted-foreground">
                    From:{" "}
                    {l.sources.map((s) => `${s.title}${s.label ? ` (${s.label})` : ""}`).join("; ")}
                  </p>
                ) : null}
                {HANDOVER_NOTE[l.handover] ? (
                  <Note tone="warn" className="text-sm">
                    {HANDOVER_NOTE[l.handover]}
                  </Note>
                ) : null}
              </li>
            ),
          )}
          {ask.pending ? (
            <li className="text-sm text-muted-foreground" role="status">
              Billie is answering…
            </li>
          ) : null}
        </ol>
        <form onSubmit={send} className="flex gap-2">
          <Input
            aria-label="Question"
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            placeholder="When can we start building our stand?"
            maxLength={2000}
          />
          <Button type="submit" variant="primary" disabled={ask.pending || !question.trim()}>
            <Send /> Ask
          </Button>
        </form>
      </Panel>

      <Panel className="flex flex-col gap-3">
        <div>
          <h2 className="text-[1.05rem]">Test questions</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Questions the bot must get right. Run them before going live and after changing the
            knowledge. A test passes when the bot answers from the knowledge and mentions the words
            you list.
          </p>
        </div>
        <ul className="flex flex-col gap-2">
          {tests.map((t, i) => (
            <li
              key={t.id}
              className="flex flex-col gap-1.5 rounded-[12px] border border-border p-3"
            >
              <Input
                aria-label={`Test question ${i + 1}`}
                value={t.question}
                disabled={!canEdit}
                placeholder="Question"
                maxLength={300}
                onChange={(e) => {
                  setTests((ts) =>
                    ts.map((x) => (x.id === t.id ? { ...x, question: e.target.value } : x)),
                  );
                  setDirty(true);
                }}
              />
              <div className="flex gap-2">
                <Input
                  aria-label={`Words the answer must mention, test ${i + 1}`}
                  value={t.mustMention}
                  disabled={!canEdit}
                  placeholder="Must mention (optional), e.g. 8am, Monday"
                  maxLength={120}
                  onChange={(e) => {
                    setTests((ts) =>
                      ts.map((x) => (x.id === t.id ? { ...x, mustMention: e.target.value } : x)),
                    );
                    setDirty(true);
                  }}
                />
                {canEdit ? (
                  <Button
                    size="icon"
                    variant="ghost"
                    aria-label={`Remove test ${i + 1}`}
                    onClick={() => {
                      setTests((ts) => ts.filter((x) => x.id !== t.id));
                      setDirty(true);
                    }}
                  >
                    <Trash2 />
                  </Button>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
        {canEdit ? (
          <div className="flex flex-wrap gap-2">
            <Button onClick={() => addTest()}>
              <Plus /> Add a question
            </Button>
            {dirty ? (
              <Button onClick={() => saveTests()} disabled={save.pending}>
                Save questions
              </Button>
            ) : null}
            <Button
              variant="primary"
              onClick={runAll}
              disabled={runner.pending || !tests.some((t) => t.question.trim())}
            >
              <Play /> {runner.pending ? "Running…" : "Run all tests"}
            </Button>
          </div>
        ) : null}

        {run?.total ? (
          <div className="flex flex-col gap-2 border-t border-border pt-3" data-testid="test-run">
            <p className="flex items-center gap-2 font-semibold">
              <ListChecks className="size-5 text-primary" aria-hidden />
              {run.passed} of {run.total} passed
            </p>
            <ul className="flex flex-col gap-2">
              {run.results.map((r) => (
                <li key={r.id} className="rounded-[10px] bg-muted px-3 py-2 text-sm">
                  <p className="flex items-start gap-2 font-semibold">
                    {r.pass ? (
                      <CheckCircle2
                        className="mt-0.5 size-4 shrink-0 text-good"
                        aria-label="Passed"
                      />
                    ) : (
                      <XCircle className="mt-0.5 size-4 shrink-0 text-bad" aria-label="Failed" />
                    )}
                    {r.question}
                  </p>
                  <p className="mt-1 whitespace-pre-wrap text-muted-foreground">{r.answer}</p>
                  {!r.pass ? (
                    <p className="mt-1">
                      <Chip tone="bad">
                        {r.error
                          ? "Couldn't answer"
                          : r.missing.length
                            ? `Didn't mention: ${r.missing.join(", ")}`
                            : (HANDOVER_NOTE[r.handover] ?? "Didn't answer from the knowledge")}
                      </Chip>
                    </p>
                  ) : null}
                </li>
              ))}
            </ul>
            <div>
              <Button onClick={() => router.push(`/bots/${botId}?step=live`)}>
                Continue to Go live
              </Button>
            </div>
          </div>
        ) : null}
      </Panel>
    </div>
  );
}
