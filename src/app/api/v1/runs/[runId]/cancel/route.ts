import { requireUser } from "@/lib/auth";
import { json, route } from "@/lib/http";
import { cancelRun } from "@/server/runs";

export const dynamic = "force-dynamic";

export const POST = route(async ({ request, params }) => {
  const user = await requireUser(request);
  return json(await cancelRun(user.id, params.runId ?? ""));
});
