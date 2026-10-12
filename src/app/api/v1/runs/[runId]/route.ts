import { requireUser } from "@/lib/auth";
import { json, route } from "@/lib/http";
import { getRunSnapshot } from "@/server/runs";

export const dynamic = "force-dynamic";

export const GET = route(async ({ request, params }) => {
  const user = await requireUser(request);
  return json(await getRunSnapshot(user.id, params.runId ?? ""));
});
