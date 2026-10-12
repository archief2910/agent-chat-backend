import { listQuerySchema } from "@/contracts";
import { requireUser } from "@/lib/auth";
import { json, route } from "@/lib/http";
import { listAssets } from "@/server/assets";

export const dynamic = "force-dynamic";

export const GET = route(async ({ request }) => {
  const user = await requireUser(request);
  const url = new URL(request.url);
  const query = listQuerySchema.parse({
    cursor: url.searchParams.get("cursor") ?? undefined,
    limit: url.searchParams.get("limit") ?? undefined,
  });
  return json(await listAssets(user.id, query));
});
