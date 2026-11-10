"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { ExternalLink, Link2, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Note, Panel } from "@/components/ui/bits";
import { Field, Input } from "@/components/ui/form";
import { useRunner } from "@/components/ui/use-runner";
import { updateBotAction } from "@/app/actions/bots";
import {
  LINK_LABEL_MAX,
  LINK_SUGGESTIONS,
  LINK_WHEN_MAX,
  linkProblem,
  MAX_LINKS,
  newLinkId,
} from "@/lib/bots/links";
import type { BotLink } from "@/lib/types";

/**
 * Links Billie can share: the team's own addresses, shown as buttons under
 * an answer when they help (register to visit, badges, the website listing,
 * ordering). Billie never writes out an address of its own.
 */
export function LinksPanel({
  botId,
  audience,
  initial,
  canEdit,
}: {
  botId: string;
  audience: "visitors" | "exhibitors";
  initial: BotLink[];
  canEdit: boolean;
}) {
  const router = useRouter();
  const [links, setLinks] = useState<BotLink[]>(initial);
  const [dirty, setDirty] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const { pending, run } = useRunner();
  const suggestions = LINK_SUGGESTIONS[audience].filter(
    (s) => !links.some((l) => l.label.toLowerCase() === s.label.toLowerCase()),
  );

  function change(next: BotLink[]) {
    setLinks(next);
    setDirty(true);
  }
  const edit = (id: string, patch: Partial<BotLink>) =>
    change(links.map((l) => (l.id === id ? { ...l, ...patch } : l)));

  function save() {
    // Checked here first, so each problem shows beside its link.
    const found: Record<string, string> = {};
    links.forEach((l, i) => {
      const p = linkProblem(l.url);
      if (p) found[`links.${i}.url`] = p;
      if (l.label.trim().length < 2) found[`links.${i}.label`] = "Give the button its words.";
      if (l.when.trim().length < 5) found[`links.${i}.when`] = "Say when Billie should offer it.";
    });
    setErrors(found);
    if (Object.keys(found).length) return;
    run(() => updateBotAction({ id: botId, links }), {
      failed: (r) => !r.ok && setErrors(r.fieldErrors ?? {}),
      done: () => {
        setDirty(false);
        router.refresh();
      },
    });
  }

  return (
    <Panel className="flex flex-col gap-4">
      <div className="flex items-start gap-3">
        <Link2 className="mt-0.5 size-5 shrink-0 text-muted-foreground" aria-hidden />
        <div>
          <h2 className="text-[1.05rem]">Links Billie can share</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            {audience === "visitors"
              ? "Billie shows these as buttons when they help, such as Register to visit for someone keen to come."
              : "Billie shows these as buttons when they help, such as badges on Visit Connect or the company listing on the show's website."}{" "}
            It never writes out an address itself, so these are the only links it gives.
          </p>
        </div>
      </div>

      {links.length ? (
        <ul className="flex flex-col gap-3" aria-label="Links">
          {links.map((l, i) => (
            <li
              key={l.id}
              className="flex flex-col gap-3 rounded-[12px] border border-border p-3"
              data-testid="bot-link"
            >
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <Field
                  id={`link-${l.id}-label`}
                  label="Words on the button"
                  error={errors[`links.${i}.label`]}
                >
                  <Input
                    id={`link-${l.id}-label`}
                    value={l.label}
                    maxLength={LINK_LABEL_MAX}
                    disabled={!canEdit}
                    onChange={(e) => edit(l.id, { label: e.target.value })}
                  />
                </Field>
                <Field id={`link-${l.id}-url`} label="Address" error={errors[`links.${i}.url`]}>
                  <Input
                    id={`link-${l.id}-url`}
                    type="url"
                    value={l.url}
                    placeholder="https://"
                    disabled={!canEdit}
                    onChange={(e) => edit(l.id, { url: e.target.value })}
                  />
                </Field>
              </div>
              <Field
                id={`link-${l.id}-when`}
                label="Offer it when"
                hint="In your words, e.g. they ask about tickets or getting in."
                error={errors[`links.${i}.when`]}
              >
                <Input
                  id={`link-${l.id}-when`}
                  value={l.when}
                  maxLength={LINK_WHEN_MAX}
                  disabled={!canEdit}
                  onChange={(e) => edit(l.id, { when: e.target.value })}
                />
              </Field>
              <div className="flex flex-wrap items-center gap-2">
                {!linkProblem(l.url) ? (
                  <a
                    href={l.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 text-sm font-semibold text-primary underline-offset-2 hover:underline"
                  >
                    Check the address <ExternalLink className="size-3.5" aria-hidden />
                  </a>
                ) : null}
                {canEdit ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    className="ml-auto"
                    aria-label={`Remove the link ${l.label || i + 1}`}
                    onClick={() => change(links.filter((x) => x.id !== l.id))}
                  >
                    <Trash2 /> Remove
                  </Button>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-muted-foreground">No links yet.</p>
      )}

      {canEdit && links.length < MAX_LINKS ? (
        <div className="flex flex-col gap-2">
          {suggestions.length ? (
            <>
              <span className="text-sm font-semibold">Add a ready-made one, then its address</span>
              <div className="flex flex-wrap gap-2">
                {suggestions.map((s) => (
                  <Button
                    key={s.label}
                    size="sm"
                    title={s.hint}
                    onClick={() =>
                      change([...links, { id: newLinkId(), label: s.label, url: "", when: s.when }])
                    }
                  >
                    <Plus /> {s.label}
                  </Button>
                ))}
              </div>
            </>
          ) : null}
          <div>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => change([...links, { id: newLinkId(), label: "", url: "", when: "" }])}
            >
              <Plus /> Add your own link
            </Button>
          </div>
        </div>
      ) : null}

      {errors.links ? <Note tone="bad">{errors.links}</Note> : null}
      {canEdit ? (
        <div className="flex flex-wrap items-center gap-3">
          <Button variant="primary" disabled={pending || !dirty} onClick={save}>
            Save links
          </Button>
          {dirty ? <span className="text-sm text-muted-foreground">Not saved yet.</span> : null}
        </div>
      ) : null}
    </Panel>
  );
}
