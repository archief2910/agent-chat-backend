import { createApiKeyBodySchema } from "@/contracts";
import { requireUser } from "@/lib/auth";
import { json, readJson, route } from "@/lib/http";
import { createApiKey, listApiKeys } from "@/server/api-keys";

export const dynamic = "force-dynamic";

export const GET = route(async ({ request }) => {
  const user = await requireUser(request);
  return json({ keys: await listApiKeys(user.id) });
});

export const POST = route(async ({ request }) => {
  const user = await requireUser(request);
  const body = await readJson(request, createApiKeyBodySchema);
  return json(await createApiKey(user.id, body.name), 201);
});
