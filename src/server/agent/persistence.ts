import { Prisma, type MessageStatus, type RunStatus } from "@/generated/prisma/client";
import { contentBlocksSchema, type ContentBlock } from "@/contracts";
import type { Db } from "@/lib/db";
import { logger } from "@/lib/logger";
import { blocksToPlainText } from "@/server/agent/types";
import type { LoopResult, RunPersistence } from "@/server/agent/loop";
import { captureCredits, releaseRemainingHold, holdCredits } from "@/server/credits";
import { generatedMedia, mimeFromUrl } from "@/server/agent/media";
import { enqueueWebhook } from "@/server/webhooks";
import type { LoadedSkill } from "@/server/tools/registry";

export async function restoreRunSkills(prisma: Db, runId: string): Promise<LoadedSkill[]> {
  const rows = await prisma.runSkill.findMany({
    where: { runId },
    include: { snapshot: true },
    orderBy: { createdAt: "asc" },
  });
  return rows.map((row) => ({ name: row.name, hash: row.hash, body: row.snapshot.body }));
}

const TERMINAL = new Set<RunStatus>(["completed", "failed", "cancelled"]);

function asJson(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

function messageStatus(status: LoopResult["status"]): MessageStatus {
  if (status === "completed") return "completed";
  if (status === "cancelled") return "cancelled";
  return "failed";
}

export function createPrismaPersistence(prisma: Db): RunPersistence {
  return {
    async isCancelRequested(runId) {
      const run = await prisma.agentRun.findUnique({
        where: { id: runId },
        select: { cancelRequestedAt: true, status: true },
      });
      if (!run) return true;
      return run.cancelRequestedAt !== null || run.status === "stopping" || run.status === "cancelled";
    },
    async checkpoint(runId, state) {
      await prisma.$transaction(async (tx) => {
        const run = await tx.agentRun.findUnique({ where: { id: runId } });
        if (!run || TERMINAL.has(run.status)) return;
        await tx.agentRun.update({
          where: { id: runId },
          data: {
            ...(run.cancelRequestedAt ? {} : { status: state.status }),
            stepCount: state.stepCount,
            routedModel: state.routedModel,
            promptTokens: state.promptTokens,
            completionTokens: state.completionTokens,
            heartbeatAt: new Date(),
          },
        });
        if (!run.assistantMessageId) return;
        await tx.message.update({
          where: { id: run.assistantMessageId },
          data: {
            status: "streaming",
            content: asJson(state.blocks),
            contentText: blocksToPlainText(state.blocks),
          },
        });
      });
    },
    async reserve(runId, toolCallId, amount) {
      if (amount <= 0n) return;
      await prisma.$transaction(async (tx) => {
        const run = await tx.agentRun.findUnique({ where: { id: runId } });
        if (!run) return;
        await holdCredits(tx, {
          userId: run.userId,
          runId,
          amount,
          idempotencyKey: `hold:${runId}:${toolCallId}`,
        });
      });
    },
    async toolStarted(runId, tool) {
      const existing = await prisma.toolInvocation.findUnique({
        where: { runId_toolCallId: { runId, toolCallId: tool.toolCallId } },
      });
      if (existing && (existing.status === "completed" || existing.status === "failed")) return;
      const hold = await prisma.creditLedger.findUnique({
        where: { idempotencyKey: `hold:${runId}:${tool.toolCallId}` },
      });
      await prisma.toolInvocation.upsert({
        where: { runId_toolCallId: { runId, toolCallId: tool.toolCallId } },
        create: {
          runId,
          toolCallId: tool.toolCallId,
          ordinal: tool.ordinal,
          name: tool.name,
          status: "running",
          input: asJson(tool.input),
          estimatedMicrocredits: hold?.amount ?? 0n,
        },
        update: {
          status: "running",
          input: asJson(tool.input),
          estimatedMicrocredits: hold?.amount ?? 0n,
        },
      });
    },
    async toolFinished(runId, tool) {
      await prisma.$transaction(async (tx) => {
        const run = await tx.agentRun.findUnique({ where: { id: runId } });
        if (!run) return;
        const invocation = await tx.toolInvocation.upsert({
          where: { runId_toolCallId: { runId, toolCallId: tool.toolCallId } },
          create: {
            runId,
            toolCallId: tool.toolCallId,
            ordinal: 0,
            name: tool.name,
            status: tool.isError ? "failed" : "completed",
            input: {},
            output: asJson(tool.output),
            durationMs: tool.durationMs,
            errorMessage: tool.isError ? errorText(tool.output) : null,
            chargedMicrocredits: tool.isError ? 0n : tool.creditMicrocredits,
            externalRunId: externalRunId(tool.output),
          },
          update: {
            status: tool.isError ? "failed" : "completed",
            output: asJson(tool.output),
            durationMs: tool.durationMs,
            errorMessage: tool.isError ? errorText(tool.output) : null,
            chargedMicrocredits: tool.isError ? 0n : tool.creditMicrocredits,
            externalRunId: externalRunId(tool.output),
          },
        });
        if (!tool.isError) {
          for (const media of generatedMedia(tool.output)) {
            await tx.asset.upsert({
              where: { toolInvocationId_sourceUrl: { toolInvocationId: invocation.id, sourceUrl: media.url } },
              create: {
                userId: run.userId,
                kind: media.kind,
                source: "generated",
                mime: mimeFromUrl(media.url, media.kind),
                sourceUrl: media.url,
                toolInvocationId: invocation.id,
              },
              update: {},
            });
          }
        }
        if (!tool.isError && tool.creditMicrocredits > 0n) {
          await captureCredits(tx, {
            userId: run.userId,
            runId,
            toolInvocationId: invocation.id,
            amount: tool.creditMicrocredits,
            idempotencyKey: `capture:${runId}:${tool.toolCallId}`,
          });
        }
      });
      const owner = await prisma.agentRun.findUnique({
        where: { id: runId },
        select: { userId: true, chatId: true, assistantMessageId: true },
      });
      if (owner) {
        await enqueueWebhook(prisma, {
          userId: owner.userId,
          type: "tool.completed",
          eventId: `tool.completed:${runId}:${tool.toolCallId}`,
          data: {
            chatId: owner.chatId,
            runId,
            messageId: owner.assistantMessageId,
            toolCallId: tool.toolCallId,
            name: tool.name,
            status: tool.isError ? "failed" : "completed",
            durationMs: tool.durationMs,
            chargedMicrocredits: tool.creditMicrocredits.toString(),
            error: tool.isError ? errorText(tool.output) : null,
          },
        }).catch((error: unknown) => logger.warn({ err: error, runId }, "tool webhook was not queued"));
      }
    },
    async approvedPlan(runId) {
      const row = await prisma.waitpoint.findFirst({
        where: { runId, kind: "plan", status: "answered" },
        orderBy: { createdAt: "desc" },
      });
      const response = row?.response;
      return Boolean(response && typeof response === "object" && !Array.isArray(response) && (response as { approved?: unknown }).approved === true);
    },
    async completedTool(runId, toolCallId) {
      const row = await prisma.toolInvocation.findUnique({
        where: { runId_toolCallId: { runId, toolCallId } },
      });
      if (!row || (row.status !== "completed" && row.status !== "failed")) return null;
      return {
        isError: row.status === "failed",
        output: row.output,
        durationMs: row.durationMs ?? 0,
        creditMicrocredits: row.chargedMicrocredits,
      };
    },
    async schemaReady(runId, toolCallId, info) {
      await prisma.toolInvocation.update({
        where: { runId_toolCallId: { runId, toolCallId } },
        data: { output: asJson(info) },
      });
    },
    async skillLoaded(runId, skill) {
      await prisma.skillSnapshot.upsert({
        where: { hash: skill.hash },
        create: { hash: skill.hash, name: skill.name, body: skill.body },
        update: {},
      });
      await prisma.runSkill.upsert({
        where: { runId_name: { runId, name: skill.name } },
        create: { runId, name: skill.name, hash: skill.hash },
        update: {},
      });
    },
    async finalize(runId, result) {
      const settled = await prisma.$transaction(async (tx) => {
        const run = await tx.agentRun.findUnique({ where: { id: runId } });
        if (!run || TERMINAL.has(run.status)) return;
        const blocks = contentBlocksSchema.parse(result.blocks);
        await tx.agentRun.update({
          where: { id: runId },
          data: {
            status: result.status,
            errorCode: result.errorCode ?? null,
            errorMessage: result.errorMessage ?? null,
            routedModel: result.routedModel,
            promptTokens: result.promptTokens,
            completionTokens: result.completionTokens,
            stepCount: result.stepCount,
            finishedAt: new Date(),
            heartbeatAt: new Date(),
          },
        });
        if (run.assistantMessageId) {
          await tx.message.update({
            where: { id: run.assistantMessageId },
            data: {
              status: messageStatus(result.status),
              content: asJson(blocks),
              contentText: blocksToPlainText(blocks),
            },
          });
        }
        if (result.errorCode === "WAITPOINT_EXPIRED") {
          await tx.message.create({
            data: {
              chatId: run.chatId,
              runId,
              role: "system",
              status: "completed",
              content: asJson([{ type: "text", text: result.errorMessage ?? "No answer was received in time." }]),
              contentText: result.errorMessage ?? "",
            },
          });
        }
        await tx.agentSession.upsert({
          where: { chatId: run.chatId },
          create: { chatId: run.chatId, lastRoutedModel: result.routedModel },
          update: { lastRoutedModel: result.routedModel },
        });
        await captureCredits(tx, {
          userId: run.userId,
          runId,
          amount: 0n,
          idempotencyKey: `usage:${runId}`,
        });
        await releaseRemainingHold(tx, { userId: run.userId, runId });
        await tx.chat.updateMany({
          where: { id: run.chatId, activeRunId: runId },
          data: { activeRunId: null },
        });
        return { userId: run.userId, chatId: run.chatId, messageId: run.assistantMessageId };
      });
      if (settled) {
        const type = result.status === "completed" ? "agent.completed" : "agent.failed";
        await enqueueWebhook(prisma, {
          userId: settled.userId,
          type,
          eventId: `${type}:${runId}`,
          data: {
            chatId: settled.chatId,
            runId,
            messageId: settled.messageId,
            status: result.status,
            errorCode: result.errorCode ?? null,
            errorMessage: result.errorMessage ?? null,
            routedModel: result.routedModel,
          },
        }).catch((error: unknown) => logger.warn({ err: error, runId }, "run webhook was not queued"));
      }
    },
  };
}

function errorText(output: unknown): string {
  if (output && typeof output === "object" && "error" in output && typeof output.error === "string") {
    return output.error.slice(0, 500);
  }
  return "The tool failed.";
}

function externalRunId(output: unknown): string | null {
  if (output && typeof output === "object" && "externalRunId" in output && typeof output.externalRunId === "string") {
    return output.externalRunId;
  }
  return null;
}

export async function rememberExternalRun(prisma: Db, runId: string, toolCallId: string, externalRunId: string) {
  await prisma.toolInvocation.updateMany({
    where: { runId, toolCallId },
    data: { externalRunId, status: "running" },
  });
}
