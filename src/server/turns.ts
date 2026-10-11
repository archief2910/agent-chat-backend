import { Prisma } from "@/generated/prisma/client";
import { contentBlocksSchema, type ContentBlock } from "@/contracts";
import type { SendMessageBody } from "@/contracts";
import { getEnv } from "@/lib/env";
import { AppError } from "@/lib/errors";
import { logger } from "@/lib/logger";
import { getPrisma } from "@/lib/db";
import { holdCredits } from "@/server/credits";
import { consumeRateLimit } from "@/server/rate-limit";
import { realtimeSubscriptionId } from "@/server/realtime-id";
import { notFound } from "@/server/users";

const TERMINAL = new Set(["completed", "failed", "cancelled"]);

export type RunDispatcher = {
  dispatch: (input: { runId: string; traceId: string }) => Promise<{ triggerRunId: string }>;
};

export type RealtimeTokenMinter = (triggerRunId: string) => Promise<string>;

export async function sendMessage(input: {
  userId: string;
  chatId: string;
  body: SendMessageBody;
  traceId: string;
  dispatcher: RunDispatcher;
  mintToken?: RealtimeTokenMinter;
  now?: Date;
}) {
  const env = getEnv();
  if (input.body.text.length > env.MAX_MESSAGE_CHARS) {
    throw new AppError({
      code: "VALIDATION_ERROR",
      status: 400,
      message: `Messages are limited to ${env.MAX_MESSAGE_CHARS} characters.`,
    });
  }
  const prisma = getPrisma();
  const saved = await prisma.$transaction(async (tx) => {
    const locked = await tx.$queryRaw<Array<{ id: string; userId: string; activeRunId: string | null; title: string }>>(
      Prisma.sql`SELECT "id", "userId", "activeRunId", "title" FROM "Chat" WHERE "id" = ${input.chatId} FOR UPDATE`,
    );
    const chat = locked[0];
    if (!chat || chat.userId !== input.userId) throw notFound("Chat not found.");

    const existing = await tx.message.findUnique({
      where: { chatId_clientMessageId: { chatId: chat.id, clientMessageId: input.body.clientMessageId } },
    });
    if (existing) {
      const run = await tx.agentRun.findFirst({ where: { userMessageId: existing.id } });
      if (!run?.assistantMessageId) {
        throw new AppError({ code: "CONFLICT", status: 409, message: "This message already exists without a run." });
      }
      return {
        replayed: true,
        messageId: existing.id,
        assistantMessageId: run.assistantMessageId,
        runId: run.id,
        status: run.status,
        triggerRunId: run.triggerRunId,
      };
    }

    if (chat.activeRunId) {
      const active = await tx.agentRun.findUnique({ where: { id: chat.activeRunId } });
      if (active && !TERMINAL.has(active.status)) {
        throw new AppError({
          code: "RUN_ACTIVE",
          status: 409,
          message: "This chat already has an active run.",
          details: { runId: active.id },
        });
      }
      await tx.chat.update({ where: { id: chat.id }, data: { activeRunId: null } });
    }

    await consumeRateLimit(tx, {
      userId: input.userId,
      key: `${input.userId}:send`,
      limit: env.SEND_RATE_LIMIT_PER_MINUTE,
      now: input.now ?? new Date(),
    });

    if (input.body.attachments && input.body.attachments.length > 0) {
      const ids = [...new Set(input.body.attachments.map((item) => item.assetId))];
      const assets = await tx.asset.findMany({ where: { id: { in: ids }, userId: input.userId }, select: { id: true } });
      if (assets.length !== ids.length) {
        throw new AppError({ code: "VALIDATION_ERROR", status: 400, message: "One or more attachments were not found." });
      }
      const positions = new Set(input.body.attachments.map((item) => item.position));
      if (positions.size !== input.body.attachments.length) {
        throw new AppError({ code: "VALIDATION_ERROR", status: 400, message: "Attachment positions must be unique." });
      }
    }

    const blocks: ContentBlock[] = [{ type: "text", text: input.body.text }];
    const userMessage = await tx.message.create({
      data: {
        chatId: chat.id,
        role: "user",
        status: "completed",
        content: blocks as Prisma.InputJsonValue,
        contentText: input.body.text,
        clientMessageId: input.body.clientMessageId,
      },
    });
    if (input.body.attachments) {
      await tx.attachment.createMany({
        data: input.body.attachments.map((item) => ({
          messageId: userMessage.id,
          assetId: item.assetId,
          position: item.position,
        })),
      });
    }
    const assistant = await tx.message.create({
      data: {
        chatId: chat.id,
        role: "assistant",
        status: "pending",
        content: [],
        contentText: "",
      },
    });
    const run = await tx.agentRun.create({
      data: {
        chatId: chat.id,
        userId: input.userId,
        userMessageId: userMessage.id,
        assistantMessageId: assistant.id,
        status: "queued",
        planMode: input.body.planMode ?? false,
        traceId: input.traceId,
      },
    });
    await holdCredits(tx, {
      userId: input.userId,
      runId: run.id,
      amount: BigInt(env.CREDIT_ADMISSION_MICROCREDITS),
      idempotencyKey: `hold:admission:${run.id}`,
    });
    await tx.message.update({ where: { id: userMessage.id }, data: { runId: run.id } });
    await tx.message.update({ where: { id: assistant.id }, data: { runId: run.id } });
    await tx.chat.update({
      where: { id: chat.id },
      data: {
        activeRunId: run.id,
        lastMessageAt: userMessage.createdAt,
        ...(chat.title === "New chat" ? { title: input.body.text.slice(0, 80) } : {}),
      },
    });
    return {
      replayed: false,
      messageId: userMessage.id,
      assistantMessageId: assistant.id,
      runId: run.id,
      status: run.status,
      triggerRunId: null as string | null,
    };
  });

  if (!saved.triggerRunId) {
    try {
      const dispatched = await input.dispatcher.dispatch({ runId: saved.runId, traceId: input.traceId });
      await prisma.agentRun.update({ where: { id: saved.runId }, data: { triggerRunId: dispatched.triggerRunId } });
      saved.triggerRunId = dispatched.triggerRunId;
    } catch (error) {
      logger.error({ err: error, runId: saved.runId }, "dispatch failed; the reconciler will retry");
    }
  }

  let token: string | null = null;
  if (saved.triggerRunId && input.mintToken) {
    try {
      token = await input.mintToken(saved.triggerRunId);
    } catch (error) {
      logger.warn({ err: error, runId: saved.runId }, "realtime token was not issued");
    }
  }

  return {
    chatId: input.chatId,
    messageId: saved.messageId,
    assistantMessageId: saved.assistantMessageId,
    runId: saved.runId,
    status: saved.status,
    replayed: saved.replayed,
    realtime: {
      token,
      triggerRunId: saved.triggerRunId ? realtimeSubscriptionId(saved.triggerRunId) : null,
      streamId: "agent-output" as const,
    },
  };
}

export async function retryRun(input: {
  userId: string;
  runId: string;
  traceId: string;
  clientMessageId: string;
  dispatcher: RunDispatcher;
  mintToken?: RealtimeTokenMinter;
}) {
  const run = await getPrisma().agentRun.findFirst({
    where: { id: input.runId, userId: input.userId },
    include: { userMessage: { include: { attachments: { orderBy: { position: "asc" } } } } },
  });
  if (!run?.userMessage) throw notFound("Run not found.");
  if (run.status !== "failed" && run.status !== "cancelled") {
    throw new AppError({
      code: "CONFLICT",
      status: 409,
      message: "Only a failed or cancelled turn can be retried.",
    });
  }
  const text = parseBlocks(run.userMessage.content)
    .flatMap((block) => (block.type === "text" ? [block.text] : []))
    .join("\n")
    .trim();
  if (!text) {
    throw new AppError({ code: "VALIDATION_ERROR", status: 400, message: "This turn has no message to retry." });
  }
  return sendMessage({
    userId: input.userId,
    chatId: run.chatId,
    traceId: input.traceId,
    dispatcher: input.dispatcher,
    ...(input.mintToken ? { mintToken: input.mintToken } : {}),
    body: {
      text,
      clientMessageId: input.clientMessageId,
      planMode: run.planMode,
      attachments: run.userMessage.attachments.map((item) => ({ assetId: item.assetId, position: item.position })),
    },
  });
}

export function parseBlocks(value: unknown): ContentBlock[] {
  const parsed = contentBlocksSchema.safeParse(value);
  return parsed.success ? parsed.data : [];
}
