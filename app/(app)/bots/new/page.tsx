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
        lede="First choose the kind: an exhibitor chatbot for BluePrint, the exhibitor manual, or a visitor chatbot for the event website. Then eight short steps: how it looks, how it comes across, what it knows, when it passes to a person, who works on it, its email, a test, then the code for the site. Exhibitor chatbots also have a step for the exhibitor list."
      />
      <WizardSteps current="look" />
      <LookForm />
    </>
  );
}
