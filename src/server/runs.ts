import type { ContentBlock } from "@/contracts";
import { formatCredits } from "@/server/credits";
import { getPrisma } from "@/lib/db";
import { getEnv } from "@/lib/env";
import { logger } from "@/lib/logger";
import { presentMessage } from "@/server/chats";
import { notFound } from "@/server/users";
import { cancelPendingWaitpoints, pendingWaitpoint } from "@/server/waitpoints/service";

export async function getRunSnapshot(userId: string, runId: string) {
  const prisma = getPrisma();
  const run = await prisma.agentRun.findFirst({
    where: { id: runId, userId },
    include: {
      tools: { orderBy: { ordinal: "asc" } },
      assistantMessage: { include: { attachments: { include: { asset: true }, orderBy: { position: "asc" } } } },
    },
  });
  if (!run) throw notFound("Run not found.");
  return {
    id: run.id,
    chatId: run.chatId,
    status: run.status,
    routedModel: run.routedModel,
    stepCount: run.stepCount,
    progress: ["completed", "failed", "cancelled"].includes(run.status)
      ? 100
      : Math.min(99, Math.round((run.stepCount / getEnv().AGENT_MAX_STEPS) * 100)),
    waitpoint: await pendingWaitpoint(prisma, run.id),
    error: run.errorCode ? { code: run.errorCode, message: run.errorMessage ?? "The turn failed." } : null,
    assistantMessage: run.assistantMessage ? presentMessage(run.assistantMessage) : null,
    tools: run.tools.map((tool) => ({
      id: tool.id,
      toolCallId: tool.toolCallId,
      name: tool.name,
      status: tool.status,
      durationMs: tool.durationMs,
      chargedMicrocredits: tool.chargedMicrocredits.toString(),
      errorMessage: tool.errorMessage,
      ...schemaPreview(tool.output),
    })),
    usage: {
      promptTokens: run.promptTokens,
      completionTokens: run.completionTokens,
      chargedMicrocredits: run.chargedMicrocredits.toString(),
      credits: formatCredits(run.chargedMicrocredits),
    },
    updatedAt: run.updatedAt.toISOString(),
  };
}

export async function cancelRun(userId: string, runId: string) {
  const prisma = getPrisma();
  const run = await prisma.agentRun.findFirst({ where: { id: runId, userId } });
  if (!run) throw notFound("Run not found.");
  if (run.status === "completed" || run.status === "failed" || run.status === "cancelled") {
    return getRunSnapshot(userId, runId);
  }
  await prisma.agentRun.update({
    where: { id: run.id },
    data: { status: "stopping", cancelRequestedAt: new Date() },
  });
  try {
    const { wait } = await import("@trigger.dev/sdk");
    await cancelPendingWaitpoints(prisma, run.id, async (tokenId, data) => {
      await wait.completeToken(tokenId, data);
    });
  } catch (error) {
    logger.warn({ err: error, runId: run.id }, "pending approval was not released; it will expire on its own");
  }
  if (run.triggerRunId) {
    try {
      const { cancelStream } = await import("@/trigger/streams");
      await cancelStream.send(run.triggerRunId, { reason: "user" });
    } catch (error) {
      logger.warn({ err: error, runId: run.id }, "cancel signal was not delivered; the run will stop at its next checkpoint");
    }
  }
  return getRunSnapshot(userId, runId);
}

export async function listCredits(userId: string, query: { cursor?: string; limit?: number }) {
  const { decodeCursor, encodeCursor, pageLimit } = await import("@/server/pagination");
  const prisma = getPrisma();
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) throw notFound("Account not found.");
  const limit = pageLimit(query.limit);
  const cursor = query.cursor ? decodeCursor(query.cursor) : undefined;
  const rows = await prisma.creditLedger.findMany({
    where: {
      userId,
      ...(cursor
        ? { OR: [{ createdAt: { lt: cursor.at } }, { createdAt: cursor.at, id: { lt: cursor.id } }] }
        : {}),
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: limit + 1,
  });
  const hasMore = rows.length > limit;
  const pageRows = hasMore ? rows.slice(0, limit) : rows;
  const last = pageRows.at(-1);
  return {
    balanceMicrocredits: user.creditBalance.toString(),
    credits: formatCredits(user.creditBalance),
    entries: pageRows.map((entry) => ({
      id: entry.id,
      type: entry.type,
      amountMicrocredits: entry.amount.toString(),
      credits: formatCredits(entry.amount),
      balanceAfter: entry.balanceAfter.toString(),
      runId: entry.runId,
      createdAt: entry.createdAt.toISOString(),
    })),
    nextCursor: hasMore && last ? encodeCursor(last.createdAt, last.id) : null,
  };
}

function schemaPreview(output: unknown): { schemaModelId?: string; schemaDurationMs?: number } {
  if (!output || typeof output !== "object" || Array.isArray(output)) return {};
  const modelId = (output as { schemaModelId?: unknown }).schemaModelId;
  const durationMs = (output as { schemaDurationMs?: unknown }).schemaDurationMs;
  return {
    ...(typeof modelId === "string" && modelId.length > 0 ? { schemaModelId: modelId } : {}),
    ...(typeof durationMs === "number" && Number.isFinite(durationMs) ? { schemaDurationMs: durationMs } : {}),
  };
}

export type Snapshot = {
  status: string;
  blocks?: ContentBlock[];
};
