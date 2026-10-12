import { createWebhookBodySchema } from "@/contracts";
import { requireUser } from "@/lib/auth";
import { getPrisma } from "@/lib/db";
import { json, readJson, route } from "@/lib/http";
import { assertWebhookUrl, createWebhookSecret } from "@/server/webhooks";

export const dynamic = "force-dynamic";

export const GET = route(async ({ request }) => {
  const user = await requireUser(request);
  const endpoints = await getPrisma().webhookEndpoint.findMany({
    where: { userId: user.id, disabledAt: null },
    orderBy: { createdAt: "desc" },
    take: 20,
    select: { id: true, url: true, createdAt: true },
  });
  return json({
    endpoints: endpoints.map((endpoint) => ({ ...endpoint, createdAt: endpoint.createdAt.toISOString() })),
  });
});

export const POST = route(async ({ request }) => {
  const user = await requireUser(request);
  const body = await readJson(request, createWebhookBodySchema);
  assertWebhookUrl(body.url);
  const secret = createWebhookSecret();
  const endpoint = await getPrisma().webhookEndpoint.create({
    data: { userId: user.id, url: body.url, secret },
  });
  return json({ id: endpoint.id, url: endpoint.url, secret, createdAt: endpoint.createdAt.toISOString() }, 201);
});
