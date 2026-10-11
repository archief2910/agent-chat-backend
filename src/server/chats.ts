import { Prisma } from "@/generated/prisma/client";
import type { Asset, Attachment, Chat, Message } from "@/generated/prisma/client";
import { presentAsset } from "@/server/assets";
import { getPrisma } from "@/lib/db";
import { AppError } from "@/lib/errors";
import { decodeCursor, encodeCursor, olderThan, pageLimit } from "@/server/pagination";
import { notFound } from "@/server/users";
import { parseBlocks } from "@/server/turns";

export async function createChat(userId: string, title?: string) {
  const prisma = getPrisma();
  const chat = await prisma.chat.create({
    data: { userId, title: title ?? "New chat" },
  });
  return presentChat(chat);
}

export async function getChat(userId: string, chatId: string) {
  const chat = await getPrisma().chat.findFirst({ where: { id: chatId, userId } });
  if (!chat) throw notFound("Chat not found.");
  return presentChat(chat);
}

export async function updateChat(userId: string, chatId: string, patch: { title?: string; pinned?: boolean }) {
  const prisma = getPrisma();
  const chat = await prisma.chat.findFirst({ where: { id: chatId, userId } });
  if (!chat) throw notFound("Chat not found.");
  const updated = await prisma.chat.update({
    where: { id: chat.id },
    data: {
      ...(patch.title ? { title: patch.title } : {}),
      ...(patch.pinned === undefined ? {} : { pinnedAt: patch.pinned ? new Date() : null }),
    },
  });
  return presentChat(updated);
}

export async function duplicateChat(userId: string, chatId: string) {
  const prisma = getPrisma();
  return prisma.$transaction(async (tx) => {
    const source = await tx.chat.findFirst({
      where: { id: chatId, userId },
      include: {
        messages: {
          orderBy: [{ createdAt: "asc" }, { id: "asc" }],
          include: { attachments: { orderBy: { position: "asc" } } },
        },
      },
    });
    if (!source) throw notFound("Chat not found.");
    const title = `${source.title} copy`.slice(0, 120);
    const chat = await tx.chat.create({
      data: { userId, title, lastMessageAt: new Date() },
    });
    for (const message of source.messages) {
      const status = message.status === "pending" || message.status === "streaming" ? "completed" : message.status;
      const copy = await tx.message.create({
        data: {
          chatId: chat.id,
          role: message.role,
          status,
          content: message.content as Prisma.InputJsonValue,
          contentText: message.contentText,
          clientMessageId: message.clientMessageId,
          createdAt: message.createdAt,
        },
      });
      if (message.attachments.length > 0) {
        await tx.attachment.createMany({
          data: message.attachments.map((item) => ({
            messageId: copy.id,
            assetId: item.assetId,
            position: item.position,
          })),
        });
      }
    }
    return presentChat(chat);
  });
}

export async function deleteChat(userId: string, chatId: string) {
  const prisma = getPrisma();
  await prisma.$transaction(async (tx) => {
    const chat = await tx.chat.findFirst({ where: { id: chatId, userId } });
    if (!chat) throw notFound("Chat not found.");
    if (chat.activeRunId) {
      await tx.agentRun.updateMany({
        where: { id: chat.activeRunId, status: { in: ["queued", "thinking", "working", "waiting"] } },
        data: { status: "stopping", cancelRequestedAt: new Date() },
      });
      await tx.chat.update({ where: { id: chat.id }, data: { activeRunId: null } });
    }
    await tx.chat.delete({ where: { id: chat.id } });
  });
}

export async function listChats(userId: string, query: { cursor?: string; limit?: number; q?: string }) {
  const prisma = getPrisma();
  const limit = pageLimit(query.limit);
  const cursor = query.cursor ? decodeCursor(query.cursor) : undefined;
  const pinned = await prisma.chat.findMany({
    where: {
      userId,
      pinnedAt: { not: null },
      ...(query.q ? { title: { contains: query.q, mode: "insensitive" } } : {}),
    },
    orderBy: { pinnedAt: "desc" },
    take: 50,
  });
  if (!query.q) {
    const rows = await prisma.chat.findMany({
      where: { userId, pinnedAt: null, ...olderThan(cursor, "lastMessageAt") },
      orderBy: [{ lastMessageAt: "desc" }, { id: "desc" }],
      take: limit + 1,
    });
    return page(pinned, rows, limit);
  }
  const pattern = `%${escapeLike(query.q)}%`;
  const cursorSql = cursor
    ? Prisma.sql`AND (c."lastMessageAt" < ${cursor.at} OR (c."lastMessageAt" = ${cursor.at} AND c."id" < ${cursor.id}))`
    : Prisma.empty;
  const ids = await prisma.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT c."id"
    FROM "Chat" c
    WHERE c."userId" = ${userId}
      AND c."pinnedAt" IS NULL
      AND (
        c."title" ILIKE ${pattern} ESCAPE '\\'
        OR EXISTS (
          SELECT 1 FROM "Message" m
          WHERE m."chatId" = c."id" AND m."searchVector" @@ plainto_tsquery('english', ${query.q})
        )
      )
      ${cursorSql}
    ORDER BY c."lastMessageAt" DESC, c."id" DESC
    LIMIT ${limit + 1}
  `);
  const rows = ids.length
    ? await prisma.chat.findMany({ where: { id: { in: ids.map((row) => row.id) } } })
    : [];
  const ordered = ids.flatMap((row) => rows.filter((chat) => chat.id === row.id));
  return page(pinned, ordered, limit);
}

export async function listMessages(userId: string, chatId: string, query: { cursor?: string; limit?: number }) {
  const chat = await getPrisma().chat.findFirst({ where: { id: chatId, userId }, select: { id: true } });
  if (!chat) throw notFound("Chat not found.");
  const limit = pageLimit(query.limit);
  const cursor = query.cursor ? decodeCursor(query.cursor) : undefined;
  const rows = await getPrisma().message.findMany({
    where: { chatId, ...olderThan(cursor, "createdAt") },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: limit + 1,
    include: { attachments: { include: { asset: true }, orderBy: { position: "asc" } } },
  });
  const hasMore = rows.length > limit;
  const pageRows = hasMore ? rows.slice(0, limit) : rows;
  const last = pageRows.at(-1);
  return {
    messages: pageRows.map(presentMessage),
    nextCursor: hasMore && last ? encodeCursor(last.createdAt, last.id) : null,
  };
}

function page(pinned: Chat[], rows: Chat[], limit: number) {
  const hasMore = rows.length > limit;
  const pageRows = hasMore ? rows.slice(0, limit) : rows;
  const last = pageRows.at(-1);
  return {
    pinned: pinned.map(presentChat),
    chats: pageRows.map(presentChat),
    nextCursor: hasMore && last ? encodeCursor(last.lastMessageAt, last.id) : null,
  };
}

export function presentChat(chat: Chat) {
  return {
    id: chat.id,
    title: chat.title,
    pinnedAt: chat.pinnedAt?.toISOString() ?? null,
    activeRunId: chat.activeRunId,
    lastMessageAt: chat.lastMessageAt.toISOString(),
    createdAt: chat.createdAt.toISOString(),
  };
}

export function presentMessage(message: Message & { attachments?: Array<Attachment & { asset: Asset }> }) {
  return {
    id: message.id,
    chatId: message.chatId,
    runId: message.runId,
    role: message.role,
    status: message.status,
    content: parseBlocks(message.content),
    attachments: (message.attachments ?? []).map((item) => ({ position: item.position, asset: presentAsset(item.asset) })),
    createdAt: message.createdAt.toISOString(),
  };
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (character) => `\\${character}`);
}

export function badCursor(): AppError {
  return new AppError({ code: "VALIDATION_ERROR", status: 400, message: "The page cursor is invalid." });
}
