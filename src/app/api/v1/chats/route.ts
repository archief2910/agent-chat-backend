import { createChatBodySchema, listQuerySchema } from "@/contracts";
import { requireUser } from "@/lib/auth";
import { json, readJson, route } from "@/lib/http";
import { createChat, listChats } from "@/server/chats";

export const dynamic = "force-dynamic";

export const GET = route(async ({ request }) => {
  const user = await requireUser(request);
  const url = new URL(request.url);
  const query = listQuerySchema.parse({
    cursor: url.searchParams.get("cursor") ?? undefined,
    limit: url.searchParams.get("limit") ?? undefined,
    q: url.searchParams.get("q") ?? undefined,
  });
  return json(await listChats(user.id, query));
});

export const POST = route(async ({ request }) => {
  const user = await requireUser(request);
  const body = await readJson(request, createChatBodySchema);
  return json(await createChat(user.id, body.title), 201);
});
