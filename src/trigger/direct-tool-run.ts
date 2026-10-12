import { task, wait } from "@trigger.dev/sdk";
import { getPrisma } from "@/lib/db";
import { executeDirectToolRun } from "@/server/direct-tools";

export const directToolRun = task({
  id: "direct-tool-run",
  retry: { maxAttempts: 3 },
  run: async (payload: { directToolRunId: string }) => {
    const run = await executeDirectToolRun(getPrisma(), payload.directToolRunId, async (ms) => {
      await wait.for({ seconds: Math.max(1, Math.ceil(ms / 1000)) });
    });
    return { id: payload.directToolRunId, status: run?.status ?? "missing" };
  },
});
