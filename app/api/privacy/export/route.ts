import { getActor } from "@/lib/auth/actor";
import { can } from "@/lib/authz";
import { exportPerson } from "@/lib/privacy/requests";
import { UserError } from "@/lib/errors";

/** A person's data as a JSON file, for a subject access request (admins only). */
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const actor = await getActor();
  if (!actor || !can(actor, "data.export")) return new Response("Not found", { status: 404 });
  const q = new URL(request.url).searchParams.get("q") ?? "";
  try {
    const data = await exportPerson(actor, q);
    return new Response(JSON.stringify(data, null, 2), {
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Disposition": 'attachment; filename="billie-personal-data.json"',
        "Cache-Control": "no-store",
      },
    });
  } catch (err) {
    if (err instanceof UserError) return new Response(err.message, { status: 400 });
    throw err;
  }
}
