import { requireUser } from "@/lib/auth";
import { json, route } from "@/lib/http";
import { duplicateChat } from "@/server/chats";

export const dynamic = "force-dynamic";

export const POST = route(async ({ request, params }) => {
  const user = await requireUser(request);
  return json(await duplicateChat(user.id, params.chatId ?? ""));
});
