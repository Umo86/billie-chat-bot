import { Rail } from "@/components/shell/rail";
import { signOut } from "@/app/actions/auth";
import { requireActor } from "@/lib/auth/actor";
import { can, ROLE_LABEL } from "@/lib/authz";
import { navCounts } from "@/lib/shell";

export const dynamic = "force-dynamic";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const actor = await requireActor();
  const counts = await navCounts(actor);
  return (
    <div className="mx-auto grid min-h-dvh w-full max-w-[1440px] grid-cols-1 gap-4 py-4 pl-[max(16px,env(safe-area-inset-left))] pr-[max(16px,env(safe-area-inset-right))] lg:grid-cols-[236px_minmax(0,1fr)] lg:gap-6">
      <Rail
        name={actor.name}
        roleLabel={ROLE_LABEL[actor.role]}
        counts={counts}
        access={{
          bots: can(actor, "bots.view"),
          knowledge: can(actor, "knowledge.view"),
          reports: can(actor, "reports.view"),
          settings: can(actor, "settings.manage"),
        }}
        signOut={signOut}
      />
      <main id="main" className="flex min-w-0 flex-col gap-5 pb-14">
        {children}
      </main>
    </div>
  );
}
