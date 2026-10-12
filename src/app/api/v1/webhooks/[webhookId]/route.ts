import { requireUser } from "@/lib/auth";
import { getPrisma } from "@/lib/db";
import { json, route } from "@/lib/http";
import { notFound } from "@/server/users";

export const dynamic = "force-dynamic";

export const DELETE = route(async ({ request, params }) => {
  const user = await requireUser(request);
  const result = await getPrisma().webhookEndpoint.updateMany({
    where: { id: params.webhookId ?? "", userId: user.id, disabledAt: null },
    data: { disabledAt: new Date() },
  });
  if (result.count === 0) throw notFound("Webhook not found.");
  return json({ disabled: true });
});
