import { requireUser } from "@/lib/auth";
import { json, route } from "@/lib/http";
import { revokeApiKey } from "@/server/api-keys";

export const dynamic = "force-dynamic";

export const DELETE = route(async ({ request, params }) => {
  const user = await requireUser(request);
  await revokeApiKey(user.id, params.keyId ?? "");
  return json({ revoked: true });
});
