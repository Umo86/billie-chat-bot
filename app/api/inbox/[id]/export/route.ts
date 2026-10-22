import { getActor } from "@/lib/auth/actor";
import { can } from "@/lib/authz";
import { conversationDetail, transcriptText } from "@/lib/conversations/inbox";
import { writeAudit } from "@/lib/audit";
import { db } from "@/lib/db/client";

/** A chat's transcript as a text file (for a complaint, a contract question, a record). */
export const dynamic = "force-dynamic";

export async function GET(_request: Request, ctx: { params: Promise<{ id: string }> }) {
  const actor = await getActor();
  if (!actor || !can(actor, "inbox.view")) return new Response("Not found", { status: 404 });
  const { id } = await ctx.params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) return new Response("Not found", { status: 404 });
  const detail = await conversationDetail(id);
  if (!detail) return new Response("Not found", { status: 404 });
  await writeAudit(db, {
    actorUserId: actor.id,
    entityType: "conversation",
    entityId: id,
    action: "export",
    summary: "Downloaded a chat transcript",
  });
  return new Response(transcriptText(detail), {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Content-Disposition": `attachment; filename="chat-${id.slice(0, 8)}.txt"`,
      "Cache-Control": "no-store",
    },
  });
}
