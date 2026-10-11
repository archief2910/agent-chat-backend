import { Prisma } from "@/generated/prisma/client";
import type { Waitpoint } from "@/generated/prisma/client";
import type { Db } from "@/lib/db";
import { AppError } from "@/lib/errors";
import { notFound } from "@/server/users";
import { parseWaitpointResponse, waitpointKinds, type WaitpointKind } from "@/server/waitpoints/registry";

export type CompleteToken = (tokenId: string, data: Record<string, unknown>) => Promise<void>;

function json(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

export function presentWaitpoint(row: Waitpoint) {
  return {
    id: row.id,
    kind: row.kind as WaitpointKind,
    status: row.status,
    request: row.request,
    expiresAt: row.expiresAt.toISOString(),
  };
}

export async function openWaitpoint(
  prisma: Db,
  input: { runId: string; toolCallId: string; kind: WaitpointKind; request: unknown; tokenId: string; expiresAt: Date },
) {
  const request = waitpointKinds[input.kind].request.parse(input.request);
  return prisma.$transaction(async (tx) => {
    const row = await tx.waitpoint.upsert({
      where: { runId_toolCallId: { runId: input.runId, toolCallId: input.toolCallId } },
      create: {
        runId: input.runId,
        toolCallId: input.toolCallId,
        tokenId: input.tokenId,
        kind: input.kind,
        request: json(request),
        expiresAt: input.expiresAt,
      },
      update: {},
    });
    if (row.status === "pending") {
      await tx.agentRun.updateMany({
        where: { id: input.runId, status: { in: ["thinking", "working"] } },
        data: { status: "waiting", heartbeatAt: new Date() },
      });
    }
    return row;
  });
}

export async function settleWaitpoint(
  prisma: Db,
  input: { runId: string; toolCallId: string; status: "expired" | "cancelled" | "answered" },
) {
  await prisma.$transaction(async (tx) => {
    if (input.status !== "answered") {
      await tx.waitpoint.updateMany({
        where: { runId: input.runId, toolCallId: input.toolCallId, status: "pending" },
        data: { status: input.status },
      });
    }
    await tx.agentRun.updateMany({
      where: { id: input.runId, status: "waiting" },
      data: { status: "thinking", heartbeatAt: new Date() },
    });
  });
}

export async function respondToWaitpoint(
  prisma: Db,
  input: { userId: string; waitpointId: string; response: unknown; now?: Date },
  complete: CompleteToken,
) {
  const row = await prisma.waitpoint.findFirst({
    where: { id: input.waitpointId, run: { userId: input.userId } },
  });
  if (!row) throw notFound("Request not found.");
  const response = parseWaitpointResponse(row.kind, row.request, input.response);
  const now = input.now ?? new Date();

  if (row.status === "answered") {
    if (JSON.stringify(row.response) !== JSON.stringify(response)) {
      throw new AppError({ code: "CONFLICT", status: 409, message: "This request already has a different answer." });
    }
    await complete(row.tokenId, { response });
    return { ...presentWaitpoint(row), replayed: true };
  }
  if (row.status !== "pending" || row.expiresAt <= now) {
    if (row.status === "pending") {
      await prisma.waitpoint.updateMany({ where: { id: row.id, status: "pending" }, data: { status: "expired" } });
    }
    throw new AppError({
      code: "WAITPOINT_CLOSED",
      status: 410,
      message: "This request is no longer waiting for an answer. Send a message to continue.",
    });
  }

  const updated = await prisma.waitpoint.updateMany({
    where: { id: row.id, status: "pending" },
    data: { status: "answered", response: json(response) },
  });
  if (updated.count === 0) {
    return respondToWaitpoint(prisma, input, complete);
  }
  await complete(row.tokenId, { response });
  const fresh = await prisma.waitpoint.findUniqueOrThrow({ where: { id: row.id } });
  return { ...presentWaitpoint(fresh), replayed: false };
}

export async function cancelPendingWaitpoints(prisma: Db, runId: string, complete: CompleteToken) {
  const pending = await prisma.waitpoint.findMany({ where: { runId, status: "pending" } });
  for (const row of pending) {
    const updated = await prisma.waitpoint.updateMany({
      where: { id: row.id, status: "pending" },
      data: { status: "cancelled" },
    });
    if (updated.count > 0) await complete(row.tokenId, { cancelled: true });
  }
}

export async function expireStaleWaitpoints(prisma: Db, now = new Date()) {
  const result = await prisma.waitpoint.updateMany({
    where: { status: "pending", expiresAt: { lt: now } },
    data: { status: "expired" },
  });
  return result.count;
}

export async function pendingWaitpoint(prisma: Db, runId: string) {
  const row = await prisma.waitpoint.findFirst({
    where: { runId, status: "pending" },
    orderBy: { createdAt: "desc" },
  });
  return row ? presentWaitpoint(row) : null;
}
