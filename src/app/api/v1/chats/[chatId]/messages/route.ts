import { listQuerySchema, sendMessageBodySchema, sendMessageResponseSchema } from "@/contracts";
import { requireUser } from "@/lib/auth";
import { json, readJson, route } from "@/lib/http";
import { listMessages } from "@/server/chats";
import { mintRealtimeToken, triggerDispatcher } from "@/server/dispatcher";
import { sendMessage } from "@/server/turns";

export const dynamic = "force-dynamic";

export const GET = route(async ({ request, params }) => {
  const user = await requireUser(request);
  const url = new URL(request.url);
  const query = listQuerySchema.parse({
    cursor: url.searchParams.get("cursor") ?? undefined,
    limit: url.searchParams.get("limit") ?? undefined,
  });
  return json(await listMessages(user.id, params.chatId ?? "", query));
});

export const POST = route(async ({ request, params, traceId }) => {
  const user = await requireUser(request);
  const body = await readJson(request, sendMessageBodySchema);
  const result = await sendMessage({
    userId: user.id,
    chatId: params.chatId ?? "",
    body,
    traceId,
    dispatcher: triggerDispatcher,
    mintToken: mintRealtimeToken,
  });
  return json(sendMessageResponseSchema.parse(result), 202);
});
