"use client";

import { useActionState } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Field, Input } from "@/components/ui/form";
import { Note } from "@/components/ui/bits";
import type { ActionResult } from "@/lib/actions/result";

type FormAction = (prev: ActionResult | null, form: FormData) => Promise<ActionResult>;

function Shell({
  title,
  lede,
  children,
}: {
  title: string;
  lede: string;
  children: React.ReactNode;
}) {
  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-[440px] flex-col justify-center gap-6 px-[max(16px,env(safe-area-inset-left))] py-10">
      <div className="flex items-center gap-2.5">
        <span className="brand-mark" aria-hidden />
        <span className="brand-word">Billie</span>
      </div>
      <div className="rounded-[14px] border border-border bg-card p-6 shadow-panel">
        <h1 className="text-[1.5rem]">{title}</h1>
        <p className="mt-1.5 text-muted-foreground">{lede}</p>
        <div className="mt-5">{children}</div>
      </div>
    </main>
  );
}

export function SignInForm({ action }: { action: FormAction }) {
  const [state, formAction, pending] = useActionState(action, null);
  return (
    <Shell title="Sign in" lede="The chat and email assistant for Media10 shows.">
      <form action={formAction} className="flex flex-col gap-4">
        <Field id="email" label="Email">
          <Input
            id="email"
            name="email"
            type="email"
            autoComplete="username"
            required
            placeholder="you@media10.com"
          />
        </Field>
        <Field id="password" label="Password">
          <Input
            id="password"
            name="password"
            type="password"
            autoComplete="current-password"
            required
          />
        </Field>
        {state && !state.ok ? <Note tone="bad">{state.error}</Note> : null}
        <Button type="submit" variant="primary" disabled={pending}>
          {pending ? "Signing in…" : "Sign in"}
        </Button>
        <p className="text-sm text-muted-foreground">
          Forgot your password? Ask an admin for a new sign-in link.
        </p>
      </form>
    </Shell>
  );
}

export function SetUpForm({
  action,
  lockedEmail,
}: {
  action: FormAction;
  lockedEmail: string | null;
}) {
  const [state, formAction, pending] = useActionState(action, null);
  return (
    <Shell
      title="Set up Billie"
      lede="Create the first account. It will be an admin, and can invite the rest of the team."
    >
      <form action={formAction} className="flex flex-col gap-4">
        <Field id="name" label="Your name">
          <Input
            id="name"
            name="name"
            autoComplete="name"
            required
            placeholder="e.g. Umit Bozdag"
          />
        </Field>
        <Field
          id="email"
          label="Work email"
          hint={lockedEmail ? "Only this address can create the first account." : undefined}
        >
          <Input
            id="email"
            name="email"
            type="email"
            autoComplete="username"
            required
            defaultValue={lockedEmail ?? ""}
            readOnly={Boolean(lockedEmail)}
          />
        </Field>
        <Field id="password" label="Password" hint="At least 10 characters.">
          <Input
            id="password"
            name="password"
            type="password"
            autoComplete="new-password"
            required
            minLength={10}
          />
        </Field>
        {state && !state.ok ? <Note tone="bad">{state.error}</Note> : null}
        <Button type="submit" variant="primary" disabled={pending}>
          {pending ? "Setting up…" : "Create account"}
        </Button>
      </form>
    </Shell>
  );
}

export function InviteForm({
  action,
  token,
  name,
  email,
}: {
  action: FormAction;
  token: string;
  name: string;
  email: string;
}) {
  const [state, formAction, pending] = useActionState(action, null);
  return (
    <Shell title={`Welcome, ${name.split(" ")[0]}`} lede={`Choose a password for ${email}.`}>
      <form action={formAction} className="flex flex-col gap-4">
        <input type="hidden" name="token" value={token} />
        <input type="email" name="username" autoComplete="username" value={email} readOnly hidden />
        <Field id="password" label="Password" hint="At least 10 characters.">
          <Input
            id="password"
            name="password"
            type="password"
            autoComplete="new-password"
            required
            minLength={10}
          />
        </Field>
        <Field id="confirm" label="Type it again">
          <Input
            id="confirm"
            name="confirm"
            type="password"
            autoComplete="new-password"
            required
            minLength={10}
          />
        </Field>
        {state && !state.ok ? <Note tone="bad">{state.error}</Note> : null}
        <Button type="submit" variant="primary" disabled={pending}>
          {pending ? "Saving…" : "Save password and sign in"}
        </Button>
      </form>
    </Shell>
  );
}

export function LinkProblem({ message }: { message: string }) {
  return (
    <Shell title="This link doesn't work" lede={message}>
      <Button asChild variant="primary">
        <Link href="/login">Go to sign in</Link>
      </Button>
    </Shell>
  );
}
