import { task } from "@trigger.dev/sdk";
import { getPrisma } from "@/lib/db";
import { deliverPendingWebhooks } from "@/server/webhooks";

export const deliverWebhooks = task({
  id: "deliver-webhooks",
  retry: { maxAttempts: 3 },
  run: async () => ({ delivered: await deliverPendingWebhooks(getPrisma()) }),
});
