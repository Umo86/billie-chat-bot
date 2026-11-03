"use client";

import { useState } from "react";
import { Check, Mail, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Panel } from "@/components/ui/bits";
import { Field, Input, Textarea } from "@/components/ui/form";
import { useRunner } from "@/components/ui/use-runner";
import { dismissLearningAction, saveLearningAction } from "@/app/actions/knowledge";
import type { LearningOffer } from "@/lib/emails/learn";

/**
 * Corrections from sent emails: the team changed one of Billie's drafts
 * before sending it, and the fact they changed can become a typed answer.
 * Edit it if needed, then save; or dismiss it.
 */
export function LearningList({ offers, canEdit }: { offers: LearningOffer[]; canEdit: boolean }) {
  if (!offers.length) return null;
  return (
    <section className="flex flex-col gap-3" aria-labelledby="learning-heading">
      <div>
        <h2 id="learning-heading" className="text-[1.05rem]">
          Corrections from sent emails
        </h2>
        <p className="mt-1 text-muted-foreground">
          The team changed these drafts before sending them. Save the fact as a typed answer and the
          bot gets it right next time.
        </p>
      </div>
      <ul className="flex flex-col gap-3" aria-label="Corrections from sent emails">
        {offers.map((o) => (
          <OfferItem key={o.emailId} offer={o} canEdit={canEdit} />
        ))}
      </ul>
    </section>
  );
}

function OfferItem({ offer, canEdit }: { offer: LearningOffer; canEdit: boolean }) {
  const [question, setQuestion] = useState(offer.learning.question);
  const [answer, setAnswer] = useState(offer.learning.answer);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const save = useRunner();
  const dismiss = useRunner();
  const id = `learn-${offer.emailId}`;

  return (
    <li>
      <Panel className="flex flex-col gap-3" data-testid="learning-row">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <p className="flex min-w-0 items-center gap-2 font-semibold">
            <Mail className="size-4 shrink-0 text-muted-foreground" aria-hidden />
            <span className="break-words">{offer.subject || "(no subject)"}</span>
          </p>
          <span className="text-sm text-muted-foreground">{offer.botName}</span>
        </div>
        {offer.learning.why ? (
          <p className="text-sm text-muted-foreground">What changed: {offer.learning.why}</p>
        ) : null}
        <details className="text-sm">
          <summary className="cursor-pointer font-semibold text-primary">
            Billie&apos;s draft and what was sent
          </summary>
          <div className="mt-2 grid grid-cols-1 gap-3 md:grid-cols-2">
            <div className="min-w-0">
              <p className="font-semibold">Billie wrote</p>
              <p className="mt-1 whitespace-pre-wrap break-words text-muted-foreground">
                {offer.draft}
              </p>
            </div>
            <div className="min-w-0">
              <p className="font-semibold">The team sent</p>
              <p className="mt-1 whitespace-pre-wrap break-words">{offer.sent}</p>
            </div>
          </div>
        </details>
        {canEdit ? (
          <form
            className="flex flex-col gap-3 border-t border-border pt-3"
            onSubmit={(e) => {
              e.preventDefault();
              setErrors({});
              save.run(() => saveLearningAction({ emailId: offer.emailId, question, answer }), {
                failed: (r) => !r.ok && setErrors(r.fieldErrors ?? {}),
              });
            }}
          >
            <Field id={`${id}-q`} label="Question" error={errors.question}>
              <Input
                id={`${id}-q`}
                value={question}
                maxLength={300}
                onChange={(e) => setQuestion(e.target.value)}
              />
            </Field>
            <Field id={`${id}-a`} label="Answer" error={errors.answer}>
              <Textarea
                id={`${id}-a`}
                value={answer}
                maxLength={4000}
                onChange={(e) => setAnswer(e.target.value)}
              />
            </Field>
            <div className="flex flex-wrap gap-2">
              <Button type="submit" variant="primary" disabled={save.pending}>
                <Check /> Save as a typed answer
              </Button>
              <Button
                type="button"
                variant="ghost"
                disabled={dismiss.pending}
                onClick={() => dismiss.run(() => dismissLearningAction({ emailId: offer.emailId }))}
              >
                <X /> Dismiss
              </Button>
            </div>
          </form>
        ) : null}
      </Panel>
    </li>
  );
}
