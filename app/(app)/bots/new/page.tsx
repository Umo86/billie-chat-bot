import type { Metadata } from "next";
import { PageHeader } from "@/components/ui/bits";
import { LookForm } from "@/components/bots/look-form";
import { WizardSteps } from "@/components/bots/wizard-steps";
import { requireActor } from "@/lib/auth/actor";

export const metadata: Metadata = { title: "New bot" };

export default async function NewBotPage() {
  await requireActor("bots.edit");
  return (
    <>
      <PageHeader
        title="New bot"
        lede="Seven short steps: how it looks, how it comes across, what it knows, when it passes to a person, its email, a test, then the code for your website."
      />
      <WizardSteps current="look" />
      <LookForm />
    </>
  );
}
