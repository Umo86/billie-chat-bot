"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { ClipboardList, Plus, Trash2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Note, Panel } from "@/components/ui/bits";
import { Field, Input, Select } from "@/components/ui/form";
import { useRunner } from "@/components/ui/use-runner";
import { updateBotAction } from "@/app/actions/bots";
import {
  fromTemplate,
  MAX_REQUEST_FIELDS,
  MAX_REQUEST_TYPES,
  newRequestId,
  REQUEST_TEMPLATES,
} from "@/lib/requests/rules";
import type { RequestField, RequestType } from "@/lib/types";

const KIND_LABEL = { short: "A line", long: "A paragraph", date: "A date" } as const;

/**
 * The requests a bot takes through its chat: the bot offers the form when
 * someone wants one, and the request goes to the Requests page with a
 * reference the person can follow.
 */
export function RequestsPanel({
  botId,
  initial,
  people,
  canEdit,
  exhibitors,
}: {
  botId: string;
  initial: RequestType[];
  people: { id: string; name: string }[];
  canEdit: boolean;
  exhibitors: boolean;
}) {
  const router = useRouter();
  const [types, setTypes] = useState<RequestType[]>(initial);
  const [dirty, setDirty] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const { pending, run } = useRunner();
  const unused = REQUEST_TEMPLATES.filter((t) => !types.some((x) => x.name === t.name));

  function change(next: RequestType[]) {
    setTypes(next);
    setDirty(true);
  }
  const edit = (id: string, patch: Partial<RequestType>) =>
    change(types.map((t) => (t.id === id ? { ...t, ...patch } : t)));
  const editField = (typeId: string, fieldId: string, patch: Partial<RequestField>) =>
    change(
      types.map((t) =>
        t.id === typeId
          ? { ...t, fields: t.fields.map((f) => (f.id === fieldId ? { ...f, ...patch } : f)) }
          : t,
      ),
    );

  function save() {
    setErrors({});
    run(() => updateBotAction({ id: botId, requestTypes: types }), {
      failed: (r) => !r.ok && setErrors(r.fieldErrors ?? {}),
      done: () => {
        setDirty(false);
        router.refresh();
      },
    });
  }

  return (
    <Panel className="flex flex-col gap-3" data-testid="requests-panel">
      <div>
        <h2 className="flex items-center gap-2 text-[1.05rem]">
          <ClipboardList className="size-5 text-primary" aria-hidden /> Requests it can take
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          When someone wants one of these, the bot shows a short form in the chat. The request goes
          to the Requests page with a reference they can follow, and whoever handles it gets a Teams
          message. Forms show on websites and the chat page, not on WhatsApp.
        </p>
      </div>

      {types.length ? (
        <ol className="flex flex-col gap-3" aria-label="Requests">
          {types.map((t, n) => (
            <li
              key={t.id}
              className="flex flex-col gap-3 rounded-[12px] border border-border p-3"
              data-testid="request-type"
            >
              <div className="grid gap-3 sm:grid-cols-2">
                <Field
                  id={`rt-name-${t.id}`}
                  label="Request"
                  error={errors[`requestTypes.${n}.name`]}
                >
                  <Input
                    id={`rt-name-${t.id}`}
                    value={t.name}
                    disabled={!canEdit}
                    maxLength={60}
                    onChange={(e) => edit(t.id, { name: e.target.value })}
                  />
                </Field>
                <Field id={`rt-who-${t.id}`} label="Handled by">
                  <Select
                    id={`rt-who-${t.id}`}
                    value={t.handlerId ?? ""}
                    disabled={!canEdit}
                    onChange={(e) => edit(t.id, { handlerId: e.target.value || null })}
                  >
                    <option value="">Whoever manages the event mailbox</option>
                    {people.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                  </Select>
                </Field>
              </div>
              <Field
                id={`rt-when-${t.id}`}
                label="When to offer it"
                hint="In your words, so the bot knows when someone wants this."
                error={errors[`requestTypes.${n}.when`]}
              >
                <Input
                  id={`rt-when-${t.id}`}
                  value={t.when}
                  disabled={!canEdit}
                  maxLength={200}
                  onChange={(e) => edit(t.id, { when: e.target.value })}
                />
              </Field>
              <div className="flex flex-col gap-2">
                <p className="text-[0.9rem] font-semibold">
                  Questions on the form{" "}
                  <span className="font-normal text-muted-foreground">
                    (name, company, stand, email and phone are always asked)
                  </span>
                </p>
                {t.fields.map((f, i) => (
                  <div key={f.id} className="flex flex-wrap items-center gap-2">
                    <Input
                      aria-label={`Question ${i + 1} of ${t.name || "this request"}`}
                      value={f.label}
                      disabled={!canEdit}
                      maxLength={80}
                      className="min-w-48 flex-1"
                      onChange={(e) => editField(t.id, f.id, { label: e.target.value })}
                    />
                    <Select
                      aria-label={`Answer type for question ${i + 1}`}
                      value={f.kind}
                      disabled={!canEdit}
                      className="w-auto"
                      onChange={(e) =>
                        editField(t.id, f.id, { kind: e.target.value as RequestField["kind"] })
                      }
                    >
                      {(["short", "long", "date"] as const).map((k) => (
                        <option key={k} value={k}>
                          {KIND_LABEL[k]}
                        </option>
                      ))}
                    </Select>
                    <label className="inline-flex items-center gap-1.5 text-sm">
                      <input
                        type="checkbox"
                        checked={f.required}
                        disabled={!canEdit}
                        onChange={(e) => editField(t.id, f.id, { required: e.target.checked })}
                      />
                      Required
                    </label>
                    {canEdit ? (
                      <Button
                        size="icon"
                        variant="ghost"
                        aria-label={`Remove question ${i + 1}`}
                        onClick={() =>
                          edit(t.id, { fields: t.fields.filter((x) => x.id !== f.id) })
                        }
                      >
                        <X />
                      </Button>
                    ) : null}
                  </div>
                ))}
                {canEdit ? (
                  <div className="flex flex-wrap gap-2">
                    <Button
                      size="sm"
                      disabled={t.fields.length >= MAX_REQUEST_FIELDS}
                      onClick={() =>
                        edit(t.id, {
                          fields: [
                            ...t.fields,
                            { id: newRequestId(), label: "", kind: "short", required: false },
                          ],
                        })
                      }
                    >
                      <Plus /> Add a question
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="text-bad"
                      onClick={() => change(types.filter((x) => x.id !== t.id))}
                    >
                      <Trash2 /> Remove this request
                    </Button>
                  </div>
                ) : null}
              </div>
            </li>
          ))}
        </ol>
      ) : (
        <Note>This bot doesn&apos;t take any requests yet.</Note>
      )}

      {canEdit ? (
        <div className="flex flex-wrap items-end gap-2">
          {exhibitors && unused.length ? (
            <Select
              aria-label="Add a ready-made request"
              value=""
              className="w-auto"
              disabled={types.length >= MAX_REQUEST_TYPES}
              onChange={(e) => {
                const t = unused.find((x) => x.name === e.target.value);
                if (t) change([...types, fromTemplate(t)]);
              }}
            >
              <option value="">Add a ready-made request…</option>
              {unused.map((t) => (
                <option key={t.name} value={t.name}>
                  {t.name}
                </option>
              ))}
            </Select>
          ) : null}
          <Button
            disabled={types.length >= MAX_REQUEST_TYPES}
            onClick={() =>
              change([
                ...types,
                {
                  id: newRequestId(),
                  name: "",
                  when: "",
                  handlerId: null,
                  fields: [{ id: newRequestId(), label: "Details", kind: "long", required: true }],
                },
              ])
            }
          >
            <Plus /> Add your own
          </Button>
          <Button variant="primary" disabled={pending || !dirty} onClick={save}>
            Save requests
          </Button>
        </div>
      ) : null}
      {errors.requestTypes ? <p className="text-sm text-bad">{errors.requestTypes}</p> : null}
      {dirty && !pending ? (
        <p className="text-sm text-muted-foreground" role="status">
          Not saved yet.
        </p>
      ) : null}
    </Panel>
  );
}
