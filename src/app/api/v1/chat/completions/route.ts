import { completionBodySchema, sendMessageResponseSchema } from "@/contracts";
import { requireUser } from "@/lib/auth";
import { json, readJson, route } from "@/lib/http";
import { createChat } from "@/server/chats";
import { mintRealtimeToken, triggerDispatcher } from "@/server/dispatcher";
import { sendMessage } from "@/server/turns";

export const dynamic = "force-dynamic";

/** Starts one durable agent turn and returns before it finishes. Poll GET /runs/:id. */
export const POST = route(async ({ request, traceId }) => {
  const user = await requireUser(request);
  const body = await readJson(request, completionBodySchema);
  const chatId = body.chatId ?? (await createChat(user.id)).id;
  const result = await sendMessage({
    userId: user.id,
    chatId,
    traceId,
    dispatcher: triggerDispatcher,
    mintToken: mintRealtimeToken,
    body: {
      text: body.text,
      clientMessageId: body.clientMessageId ?? crypto.randomUUID(),
      ...(body.planMode === undefined ? {} : { planMode: body.planMode }),
    },
  });
  return json(sendMessageResponseSchema.parse(result), 202);
});
