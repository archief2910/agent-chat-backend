import { updateChatBodySchema } from "@/contracts";
import { requireUser } from "@/lib/auth";
import { json, readJson, route } from "@/lib/http";
import { deleteChat, getChat, updateChat } from "@/server/chats";

export const dynamic = "force-dynamic";

export const GET = route(async ({ request, params }) => {
  const user = await requireUser(request);
  return json(await getChat(user.id, params.chatId ?? ""));
});

export const PATCH = route(async ({ request, params }) => {
  const user = await requireUser(request);
  const body = await readJson(request, updateChatBodySchema);
  return json(await updateChat(user.id, params.chatId ?? "", body));
});

export const DELETE = route(async ({ request, params }) => {
  const user = await requireUser(request);
  await deleteChat(user.id, params.chatId ?? "");
  return json({ deleted: true });
});
