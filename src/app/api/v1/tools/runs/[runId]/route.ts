import { requireUser } from "@/lib/auth";
import { json, route } from "@/lib/http";
import { getDirectToolRun } from "@/server/direct-tools";

export const dynamic = "force-dynamic";

export const GET = route(async ({ request, params }) => {
  const user = await requireUser(request);
  return json(await getDirectToolRun(user.id, params.runId ?? ""));
});
