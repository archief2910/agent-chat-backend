import type { RunStatus } from "@/generated/prisma/client";
import { getPrisma } from "@/lib/db";
import { logger } from "@/lib/logger";
import { createPrismaPersistence } from "@/server/agent/persistence";
import { parseBlocks, type RunDispatcher } from "@/server/turns";
import { expireStaleWaitpoints } from "@/server/waitpoints/service";
import { deliverPendingWebhooks } from "@/server/webhooks";

/** One recovery pass can see a thousand queued runs, one per chat. Live turns are still dispatched immediately. */
export const RECONCILE_DISPATCH_LIMIT = 1_000;

const TERMINAL = new Set<RunStatus>(["completed", "failed", "cancelled"]);
const STALE_HEARTBEAT_MS = 10 * 60_000;

/** Trigger.dev run statuses that mean the task will not write to this run again. */
const TRIGGER_FINISHED = new Set(["COMPLETED", "CANCELED", "FAILED", "CRASHED", "SYSTEM_FAILURE", "EXPIRED", "TIMED_OUT"]);

export function planReconciliation(input: {
  now: Date;
  staleQueuedMs: number;
  queued: Array<{ id: string; createdAt: Date; triggerRunId: string | null; status: RunStatus }>;
  locks: Array<{ chatId: string; runStatus: RunStatus | null }>;
}) {
  return {
    dispatchRunIds: input.queued
      .filter(
        (run) =>
          run.status === "queued" &&
          !run.triggerRunId &&
          input.now.getTime() - run.createdAt.getTime() > input.staleQueuedMs,
      )
      .map((run) => run.id),
    clearLockChatIds: input.locks
      .filter((lock) => lock.runStatus === null || TERMINAL.has(lock.runStatus))
      .map((lock) => lock.chatId),
  };
}

export async function reconcileRuns(
  dispatcher: RunDispatcher,
  triggerStatus: (triggerRunId: string) => Promise<string | null>,
  now = new Date(),
) {
  const prisma = getPrisma();
  const queued = await prisma.agentRun.findMany({
    where: { status: "queued", triggerRunId: null },
    select: { id: true, createdAt: true, triggerRunId: true, status: true, traceId: true },
    orderBy: { createdAt: "asc" },
    take: RECONCILE_DISPATCH_LIMIT,
  });
  const locks = await prisma.chat.findMany({
    where: { activeRunId: { not: null }, activeRun: { status: { in: ["completed", "failed", "cancelled"] } } },
    select: { id: true, activeRun: { select: { status: true } } },
    take: RECONCILE_DISPATCH_LIMIT,
  });
  const plan = planReconciliation({
    now,
    staleQueuedMs: 15_000,
    queued,
    locks: locks.map((chat) => ({ chatId: chat.id, runStatus: chat.activeRun?.status ?? null })),
  });
  for (const chatId of plan.clearLockChatIds) {
    await prisma.chat.updateMany({
      where: { id: chatId, activeRun: { status: { in: ["completed", "failed", "cancelled"] } } },
      data: { activeRunId: null },
    });
  }
  for (const runId of plan.dispatchRunIds) {
    const run = queued.find((item) => item.id === runId);
    if (!run) continue;
    try {
      const dispatched = await dispatcher.dispatch({ runId, traceId: run.traceId ?? runId });
      await prisma.agentRun.updateMany({
        where: { id: runId, triggerRunId: null },
        data: { triggerRunId: dispatched.triggerRunId },
      });
    } catch (error) {
      logger.error({ err: error, runId }, "reconcile dispatch failed");
    }
  }

  const expired = await expireStaleWaitpoints(prisma, now);

  const stale = await prisma.agentRun.findMany({
    where: {
      status: { in: ["thinking", "working", "stopping"] },
      heartbeatAt: { lt: new Date(now.getTime() - STALE_HEARTBEAT_MS) },
      triggerRunId: { not: null },
    },
    take: 50,
  });
  const persistence = createPrismaPersistence(prisma);
  let finalized = 0;
  for (const run of stale) {
    try {
      const status = run.triggerRunId ? await triggerStatus(run.triggerRunId) : null;
      if (!status || !TRIGGER_FINISHED.has(status)) continue;
      const message = run.assistantMessageId
        ? await prisma.message.findUnique({ where: { id: run.assistantMessageId } })
        : null;
      await persistence.finalize(run.id, {
        status: run.cancelRequestedAt ? "cancelled" : "failed",
        errorCode: run.cancelRequestedAt ? "CANCELLED" : "WORKER_LOST",
        errorMessage: run.cancelRequestedAt
          ? "The turn was stopped."
          : "The worker running this turn stopped unexpectedly. Saved output is kept. Send the message again to retry.",
        blocks: message ? parseBlocks(message.content) : [],
        routedModel: run.routedModel,
        promptTokens: run.promptTokens,
        completionTokens: run.completionTokens,
        stepCount: run.stepCount,
      });
      finalized += 1;
    } catch (error) {
      logger.error({ err: error, runId: run.id }, "stale run reconciliation failed");
    }
  }
  const webhooks = await deliverPendingWebhooks(prisma).catch((error: unknown) => {
    logger.error({ err: error }, "webhook delivery pass failed");
    return 0;
  });
  return { ...plan, expiredWaitpoints: expired, finalizedStaleRuns: finalized, deliveredWebhooks: webhooks };
}
