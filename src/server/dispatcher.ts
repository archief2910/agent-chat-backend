import { tasks, auth } from "@trigger.dev/sdk";
import { realtimeSubscriptionId } from "@/server/realtime-id";
import type { RealtimeTokenMinter, RunDispatcher } from "@/server/turns";

export const triggerDispatcher: RunDispatcher = {
  async dispatch(input) {
    const handle = await tasks.trigger("agent-turn", input, {
      idempotencyKey: input.runId,
      idempotencyKeyTTL: "24h",
    });
    return { triggerRunId: handle.id };
  },
};

export const mintRealtimeToken: RealtimeTokenMinter = async (triggerRunId) =>
  auth.createPublicToken({
    scopes: { read: { runs: [realtimeSubscriptionId(triggerRunId)] } },
    expirationTime: "1h",
  });
