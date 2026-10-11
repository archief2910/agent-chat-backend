/**
 * `tasks.trigger` returns `run_xxx.1` (the attempt). The realtime API only
 * accepts the run id. A token or URL that still has the attempt suffix is rejected.
 */
export function realtimeSubscriptionId(triggerRunId: string): string {
  return triggerRunId.replace(/\.\d+$/, "");
}
