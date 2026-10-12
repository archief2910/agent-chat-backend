import { directToolRunBodySchema } from "@/contracts";
import { requireUser } from "@/lib/auth";
import { json, readJson, route } from "@/lib/http";
import { startDirectToolRun } from "@/server/direct-tools";

export const dynamic = "force-dynamic";

export const POST = route(async ({ request, params }) => {
  const user = await requireUser(request);
  const body = await readJson(request, directToolRunBodySchema);
  const result = await startDirectToolRun({
    userId: user.id,
    name: params.name ?? "",
    toolInput: body.input,
    clientRequestId: body.clientRequestId,
  });
  return json(result, result.replayed ? 200 : 202);
});
