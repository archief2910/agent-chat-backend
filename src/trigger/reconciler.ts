import { runs, schedules } from "@trigger.dev/sdk";
import { reconcileRuns } from "@/server/reconcile";
import { triggerDispatcher } from "@/server/dispatcher";

export const reconcile = schedules.task({
  id: "reconcile-runs",
  cron: "* * * * *",
  run: async () =>
    reconcileRuns(triggerDispatcher, async (triggerRunId) => {
      const run = await runs.retrieve(triggerRunId);
      return run.status;
    }),
});
