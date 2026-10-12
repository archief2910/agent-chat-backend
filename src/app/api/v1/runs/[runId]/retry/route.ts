import { retryBodySchema, sendMessageResponseSchema } from "@/contracts";
import { requireUser } from "@/lib/auth";
import { json, readJson, route } from "@/lib/http";
import { mintRealtimeToken, triggerDispatcher } from "@/server/dispatcher";
import { retryRun } from "@/server/turns";

export const dynamic = "force-dynamic";

export const POST = route(async ({ request, params, traceId }) => {
  const user = await requireUser(request);
  const body = await readJson(request, retryBodySchema);
  const result = await retryRun({
    userId: user.id,
    runId: params.runId ?? "",
    traceId,
    clientMessageId: body.clientMessageId ?? crypto.randomUUID(),
    dispatcher: triggerDispatcher,
    mintToken: mintRealtimeToken,
  });
  return json(sendMessageResponseSchema.parse(result), 202);
});
