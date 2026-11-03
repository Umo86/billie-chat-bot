import { getActor } from "@/lib/auth/actor";
import { can } from "@/lib/authz";
import { mayOnBot } from "@/lib/auth/bots";
import { botById } from "@/lib/bots/load";
import { reportRange, showReport } from "@/lib/reports/show-report";
import { showReportPdf } from "@/lib/reports/show-report-pdf";

/** The end-of-show report as a PDF file (the days as on the page). */
export const dynamic = "force-dynamic";

export async function GET(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const actor = await getActor();
  if (!actor || !can(actor, "reports.view")) return new Response("Not found", { status: 404 });
  const { id } = await ctx.params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) return new Response("Not found", { status: 404 });
  const bot = await botById(id);
  if (!bot || !(await mayOnBot(actor, "reports.view", bot.id)))
    return new Response("Not found", { status: 404 });
  const url = new URL(request.url);
  const range = reportRange(bot, {
    from: url.searchParams.get("from") ?? undefined,
    to: url.searchParams.get("to") ?? undefined,
  });
  const report = await showReport(bot.id, range, { withCost: can(actor, "settings.manage") });
  if (!report) return new Response("Not found", { status: 404 });
  const bytes = await showReportPdf(report);
  return new Response(Buffer.from(bytes), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="${bot.slug}-report-${report.from}-to-${report.to}.pdf"`,
      "Cache-Control": "no-store",
    },
  });
}
