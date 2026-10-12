import { requireUser } from "@/lib/auth";
import { json, route } from "@/lib/http";
import { getPrisma } from "@/lib/db";
import { mintRealtimeToken } from "@/server/dispatcher";
import { realtimeSubscriptionId } from "@/server/realtime-id";
import { notFound } from "@/server/users";

export const dynamic = "force-dynamic";

export const POST = route(async ({ request, params }) => {
  const user = await requireUser(request);
  const run = await getPrisma().agentRun.findFirst({
    where: { id: params.runId ?? "", userId: user.id },
    select: { triggerRunId: true },
  });
  if (!run) throw notFound("Run not found.");
  if (!run.triggerRunId) return json({ token: null, triggerRunId: null, streamId: "agent-output" });
  const subscriptionId = realtimeSubscriptionId(run.triggerRunId);
  const token = await mintRealtimeToken(subscriptionId);
  return json({ token, triggerRunId: subscriptionId, streamId: "agent-output" });
});
