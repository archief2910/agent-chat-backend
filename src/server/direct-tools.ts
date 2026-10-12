import { Prisma } from "@/generated/prisma/client";
import { getEnv } from "@/lib/env";
import { AppError } from "@/lib/errors";
import { logger } from "@/lib/logger";
import { getPrisma, type Db } from "@/lib/db";
import { generatedMedia, mimeFromUrl } from "@/server/agent/media";
import { holdDirectCredits, settleDirectCredits } from "@/server/credits";
import { MagicaClient } from "@/server/magica/client";
import { getSkillRegistry } from "@/server/skills/registry";
import { createToolRegistry, type ToolContext } from "@/server/tools/registry";
import { notFound } from "@/server/users";
import { enqueueWebhook } from "@/server/webhooks";

const PUBLIC_TOOLS = new Set(["crop_image", "gpt_image_2", "merge_videos"]);

function registryFor(sleep: (ms: number) => Promise<void>) {
  const env = getEnv();
  return createToolRegistry({
    skills: getSkillRegistry(),
    magica: new MagicaClient({ baseUrl: env.MAGICA_BASE_URL, apiKey: env.MAGICA_API_KEY }),
    sleep,
  });
}

export function presentDirectRun(run: {
  id: string;
  name: string;
  status: string;
  output: unknown;
  externalRunId: string | null;
  durationMs: number | null;
  chargedMicrocredits: bigint;
  errorMessage: string | null;
  createdAt: Date;
}) {
  return {
    id: run.id,
    name: run.name,
    status: run.status,
    output: run.output,
    externalRunId: run.externalRunId,
    durationMs: run.durationMs,
    chargedMicrocredits: run.chargedMicrocredits.toString(),
    errorMessage: run.errorMessage,
    createdAt: run.createdAt.toISOString(),
  };
}

export async function startDirectToolRun(input: { userId: string; name: string; toolInput: unknown; clientRequestId: string }) {
  if (!PUBLIC_TOOLS.has(input.name)) {
    throw new AppError({ code: "NOT_FOUND", status: 404, message: "That tool is not available on the public API." });
  }
  const prisma = getPrisma();
  const idempotencyKey = `${input.userId}:${input.clientRequestId}`;
  const existing = await prisma.directToolRun.findUnique({ where: { idempotencyKey } });
  if (existing) {
    if (!existing.triggerRunId && existing.status === "pending") await dispatchDirect(existing.id);
    const fresh = await prisma.directToolRun.findUniqueOrThrow({ where: { id: existing.id } });
    return { ...presentDirectRun(fresh), replayed: true };
  }

  const tool = registryFor((ms) => new Promise((resolve) => setTimeout(resolve, ms))).get(input.name);
  if (!tool) throw notFound("Tool not found.");
  const parsed = tool.input.parse(input.toolInput);
  const estimate = await tool.estimateCredits(parsed);
  const run = await prisma.$transaction(async (tx) => {
    const created = await tx.directToolRun.create({
      data: { userId: input.userId, name: input.name, input: parsed as Prisma.InputJsonValue, idempotencyKey, estimatedMicrocredits: estimate },
    });
    await holdDirectCredits(tx, { userId: input.userId, directToolRunId: created.id, amount: estimate });
    return created;
  });
  await dispatchDirect(run.id);
  const fresh = await prisma.directToolRun.findUniqueOrThrow({ where: { id: run.id } });
  return { ...presentDirectRun(fresh), replayed: false };
}

async function dispatchDirect(id: string) {
  const prisma = getPrisma();
  try {
    const { tasks } = await import("@trigger.dev/sdk");
    const handle = await tasks.trigger("direct-tool-run", { directToolRunId: id }, { idempotencyKey: id, idempotencyKeyTTL: "24h" });
    await prisma.directToolRun.update({ where: { id }, data: { triggerRunId: handle.id } });
  } catch (error) {
    logger.error({ err: error, directToolRunId: id }, "direct tool dispatch failed");
    throw new AppError({
      code: "UPSTREAM_ERROR",
      status: 503,
      message: "The tool could not be started. Retry with the same clientRequestId; the credit hold is reused.",
      retryable: true,
    });
  }
}

export async function getDirectToolRun(userId: string, id: string) {
  const run = await getPrisma().directToolRun.findFirst({ where: { id, userId } });
  if (!run) throw notFound("Tool run not found.");
  return presentDirectRun(run);
}

export async function executeDirectToolRun(prisma: Db, directToolRunId: string, sleep: (ms: number) => Promise<void>) {
  const run = await prisma.directToolRun.findUnique({ where: { id: directToolRunId } });
  if (!run || run.status === "completed" || run.status === "failed" || run.status === "cancelled") return run;
  const tool = registryFor(sleep).get(run.name);
  if (!tool) {
    await prisma.directToolRun.update({ where: { id: run.id }, data: { status: "failed", errorMessage: "This tool is no longer available." } });
    return null;
  }
  await prisma.directToolRun.update({ where: { id: run.id }, data: { status: "running" } });
  const started = Date.now();
  const context: ToolContext = {
    runId: run.id,
    chatId: "",
    userId: run.userId,
    toolCallId: run.id,
    signal: new AbortController().signal,
    existingExternalRunId: run.externalRunId,
    recordSkill: async () => {},
    loadedSkill: () => null,
    rememberExternalRun: async (externalRunId) => {
      await prisma.directToolRun.update({ where: { id: run.id }, data: { externalRunId } });
    },
    waitForUser: async () => ({ status: "cancelled" }),
  };
  try {
    const result = await tool.execute(run.input, context);
    const durationMs = Date.now() - started;
    if (!result.ok) {
      await prisma.$transaction(async (tx) => {
        await settleDirectCredits(tx, { userId: run.userId, directToolRunId: run.id, charged: 0n });
        await tx.directToolRun.update({
          where: { id: run.id },
          data: { status: "failed", durationMs, errorMessage: result.error.slice(0, 500) },
        });
      });
    } else {
      const credits = BigInt(String((result.output as { creditMicrocredits?: string }).creditMicrocredits ?? "0"));
      await prisma.$transaction(async (tx) => {
        await settleDirectCredits(tx, { userId: run.userId, directToolRunId: run.id, charged: credits });
        await tx.directToolRun.update({
          where: { id: run.id },
          data: { status: "completed", durationMs, output: result.output as Prisma.InputJsonValue, chargedMicrocredits: credits },
        });
        for (const media of generatedMedia(result.output)) {
          const existing = await tx.asset.findFirst({ where: { userId: run.userId, sourceUrl: media.url, source: "generated" } });
          if (existing) continue;
          await tx.asset.create({
            data: {
              userId: run.userId,
              kind: media.kind,
              source: "generated",
              mime: mimeFromUrl(media.url, media.kind),
              sourceUrl: media.url,
            },
          });
        }
      });
    }
  } catch (error) {
    logger.error({ err: error, directToolRunId: run.id }, "direct tool run failed");
    await prisma.$transaction(async (tx) => {
      await settleDirectCredits(tx, { userId: run.userId, directToolRunId: run.id, charged: 0n }).catch(() => undefined);
      await tx.directToolRun.update({
        where: { id: run.id },
        data: { status: "failed", errorMessage: "The tool failed before it could finish." },
      });
    });
  }
  const finished = await prisma.directToolRun.findUnique({ where: { id: run.id } });
  if (finished) {
    await enqueueWebhook(prisma, {
      userId: run.userId,
      type: "tool.completed",
      eventId: `tool.completed:direct:${run.id}`,
      data: { directToolRunId: run.id, name: run.name, status: finished.status, error: finished.errorMessage },
    }).catch(() => undefined);
  }
  return finished;
}
