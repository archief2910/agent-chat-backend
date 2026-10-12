import { usageQuerySchema } from "@/contracts";
import { requireUser } from "@/lib/auth";
import { json, route } from "@/lib/http";
import { getUsage } from "@/server/usage";

export const dynamic = "force-dynamic";

export const GET = route(async ({ request }) => {
  const user = await requireUser(request);
  const url = new URL(request.url);
  const query = usageQuerySchema.parse({
    period: url.searchParams.get("period") ?? undefined,
  });
  return json(await getUsage(user.id, query.period ?? "current"));
});
