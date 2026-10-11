import { runWithContext } from "@/lib/trace";
import { getPrisma } from "@/lib/db";
import { logger } from "@/lib/logger";
import { runAgentLoop, type DurableCall, type DurableResult } from "@/server/agent/loop";
import { createPrismaPersistence, restoreRunSkills } from "@/server/agent/persistence";
import type { WaitForUser } from "@/server/waitpoints/registry";
import type { ModelMessage, ModelProvider } from "@/server/agent/types";
import { parseBlocks } from "@/server/turns";
import type { ToolRegistry } from "@/server/tools/registry";
import type { SkillRegistry } from "@/server/skills/registry";
import { getEnv } from "@/lib/env";
import { enqueueWebhook } from "@/server/webhooks";

const TERMINAL = new Set(["completed", "failed", "cancelled"]);

export async function executeAgentTurn(
  payload: { runId: string; traceId: string },
  deps: {
    signal: AbortSignal;
    attempt: number;
    processId: string;
    provider: ModelProvider;
    tools: ToolRegistry;
    skills: SkillRegistry;
    executeDurable: (calls: DurableCall[]) => Promise<DurableResult[]>;
    publish: (chunk: { seq: number; kind: "text" | "thinking"; delta: string }) => Promise<void>;
    onProgress?: (update: { step: number; progress: number; assets: Array<{ toolCallId: string; kind: "image" | "video" | "audio"; url: string }> }) => Promise<void>;
    waitForUser: WaitForUser;
  },
) {
  const prisma = getPrisma();
  const run = await prisma.agentRun.findUnique({ where: { id: payload.runId } });
  if (!run) return { ignored: true as const };
  return runWithContext(
    {
      traceId: payload.traceId,
      runId: run.id,
      chatId: run.chatId,
      ...(run.assistantMessageId ? { messageId: run.assistantMessageId } : {}),
      processId: deps.processId,
    },
    async () => {
      if (TERMINAL.has(run.status)) return { status: run.status };
      const persistence = createPrismaPersistence(prisma);
      const assistant = run.assistantMessageId
        ? await prisma.message.findUnique({ where: { id: run.assistantMessageId } })
        : null;
      const blocks = assistant ? parseBlocks(assistant.content) : [];
      const hasTool = blocks.some((block) => block.type === "tool_result");
      const hasText = blocks.some((block) => block.type === "text" || (block.type === "thinking" && block.text.length > 0));
      if (deps.attempt > 1 && hasText && !hasTool) {
        return persistence.finalize(run.id, {
          status: "failed",
          errorCode: "INTERRUPTED",
          errorMessage: "The response was interrupted after partial output. Send the message again to retry.",
          blocks,
          routedModel: run.routedModel,
          promptTokens: run.promptTokens,
          completionTokens: run.completionTokens,
          stepCount: run.stepCount,
        });
      }
      // Newest 100 first, then restored to chronological order; the prompt builder trims further by size.
      const history = (
        await prisma.message.findMany({
          where: { chatId: run.chatId, ...(assistant ? { createdAt: { lt: assistant.createdAt } } : {}) },
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          take: 100,
          include: { attachments: { include: { asset: true }, orderBy: { position: "asc" } } },
        })
      ).reverse();
      const transcript: ModelMessage[] = [
        ...historyToTranscript(
          history.map((message) => ({
            role: message.role,
            content: message.content,
            attachments: message.attachments.map((item) => ({ kind: item.asset.kind, url: item.asset.sourceUrl, name: item.asset.originalName })),
          })),
        ),
        ...(hasTool ? historyToTranscript([{ role: "assistant", content: blocks }]) : []),
      ];
      const restoredSkills = await restoreRunSkills(prisma, run.id);
      await prisma.agentRun.update({
        where: { id: run.id },
        data: { status: "thinking", startedAt: run.startedAt ?? new Date(), heartbeatAt: new Date() },
      });
      const env = getEnv();
      logger.info({ attempt: deps.attempt }, "agent turn started");
      await enqueueWebhook(prisma, {
        userId: run.userId,
        type: "agent.started",
        eventId: `agent.started:${run.id}`,
        data: { chatId: run.chatId, runId: run.id, messageId: run.assistantMessageId, status: "thinking" },
      }).catch((error: unknown) => logger.warn({ err: error, runId: run.id }, "start webhook was not queued"));
      try {
        return await runAgentLoop({
        runId: run.id,
        chatId: run.chatId,
        userId: run.userId,
        transcript,
        initialBlocks: blocks,
        provider: deps.provider,
        tools: deps.tools,
        skills: deps.skills,
        persistence,
        executeDurable: deps.executeDurable,
        limits: {
          maxSteps: env.AGENT_MAX_STEPS,
          maxToolCalls: env.AGENT_MAX_TOOL_CALLS,
          maxDurationMs: env.AGENT_MAX_DURATION_MS,
          maxContextChars: 48_000,
        },
        signal: deps.signal,
        now: () => Date.now(),
        sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
        onDelta: deps.publish,
        ...(deps.onProgress ? { onProgress: deps.onProgress } : {}),
        waitForUser: deps.waitForUser,
        planMode: run.planMode,
        creditApprovalMicrocredits: BigInt(env.CREDIT_APPROVAL_THRESHOLD_MICROCREDITS),
        restoredSkills,
      });
      } catch (error) {
        logger.error({ err: error, runId: run.id }, "agent turn failed");
        const latest = run.assistantMessageId
          ? await prisma.message.findUnique({ where: { id: run.assistantMessageId } })
          : null;
        const savedBlocks = latest ? parseBlocks(latest.content) : [];
        await persistence.finalize(run.id, {
          status: "failed",
          errorCode: "INTERNAL",
          errorMessage: "The turn failed before it could finish. Try again.",
          blocks: savedBlocks.length > 0 ? savedBlocks : blocks,
          routedModel: run.routedModel,
          promptTokens: run.promptTokens,
          completionTokens: run.completionTokens,
          stepCount: run.stepCount,
        });
        return { status: "failed" as const };
      }
    },
  );
}

type HistoryAttachment = { kind: string; url: string | null; name: string | null };

export function historyToTranscript(
  messages: Array<{ role: string; content: unknown; attachments?: HistoryAttachment[] }>,
): ModelMessage[] {
  const transcript: ModelMessage[] = [];
  for (const message of messages) {
    const blocks = parseBlocks(message.content);
    if (message.role === "user") {
      const text = blocks.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n");
      const attached = (message.attachments ?? [])
        .filter((item) => item.url)
        .map((item, index) => `${index + 1}. ${item.kind}${item.name ? ` (${item.name})` : ""}: ${item.url}`);
      const content = attached.length > 0 ? `${text}\n\nAttached media, in order:\n${attached.join("\n")}` : text;
      if (content) transcript.push({ role: "user", content });
      continue;
    }
    if (message.role !== "assistant") continue;
    const text = blocks.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n");
    const tools = blocks.flatMap((block) => (block.type === "tool_use" ? [block] : []));
    if (text || tools.length > 0) {
      transcript.push({
        role: "assistant",
        content: text || null,
        ...(tools.length > 0
          ? {
              tool_calls: tools.map((tool) => ({
                id: tool.id,
                type: "function" as const,
                function: { name: tool.name, arguments: JSON.stringify(tool.input ?? {}) },
              })),
            }
          : {}),
      });
    }
    for (const block of blocks) {
      if (block.type === "tool_result") {
        transcript.push({ role: "tool", tool_call_id: block.toolUseId, content: JSON.stringify(block.output) });
      }
    }
  }
  return transcript;
}
