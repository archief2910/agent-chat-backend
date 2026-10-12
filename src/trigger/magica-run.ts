import { metadata, task, wait } from "@trigger.dev/sdk";
import { getEnv } from "@/lib/env";
import { getPrisma } from "@/lib/db";
import { AppError } from "@/lib/errors";
import { rememberExternalRun } from "@/server/agent/persistence";
import { MagicaClient } from "@/server/magica/client";
import { getSkillRegistry } from "@/server/skills/registry";
import { createToolRegistry } from "@/server/tools/registry";

export type MagicaTaskPayload = {
  runId: string;
  toolCallId: string;
  name: string;
  input: unknown;
};

export type MagicaTaskOutput = {
  ok: boolean;
  output: unknown;
  error?: string;
  durationMs: number;
  creditMicrocredits: string;
};

export const magicaRun = task({
  id: "magica-run",
  retry: { maxAttempts: 3 },
  run: async (payload: MagicaTaskPayload, { ctx }): Promise<MagicaTaskOutput> => {
    const env = getEnv();
    const prisma = getPrisma();
    const existing = await prisma.toolInvocation.findUnique({
      where: { runId_toolCallId: { runId: payload.runId, toolCallId: payload.toolCallId } },
    });
    const savedMetadata = metadata.get("externalRunId");
    const existingRunId =
      existing?.externalRunId ?? (typeof savedMetadata === "string" ? savedMetadata : null);
    const client = new MagicaClient({ baseUrl: env.MAGICA_BASE_URL, apiKey: env.MAGICA_API_KEY });
    const registry = createToolRegistry({
      magica: client,
      skills: getSkillRegistry(),
      sleep: async (ms) => {
        await wait.for({ seconds: Math.max(1, Math.ceil(ms / 1000)) });
      },
    });
    const tool = registry.get(payload.name);
    if (!tool) {
      return { ok: false, output: null, error: `Unknown tool: ${payload.name}`, durationMs: 0, creditMicrocredits: "0" };
    }
    const started = Date.now();
    try {
      const result = await tool.execute(payload.input, {
        runId: payload.runId,
        chatId: "",
        userId: "",
        toolCallId: payload.toolCallId,
        signal: AbortSignal.timeout(env.AGENT_MAX_DURATION_MS),
        existingExternalRunId: existingRunId,
        recordSkill: async () => {},
        loadedSkill: () => null,
        waitForUser: async () => ({ status: "cancelled" }),
        rememberExternalRun: async (externalRunId) => {
          metadata.set("externalRunId", externalRunId);
          metadata.set("processId", ctx.run.id);
          await rememberExternalRun(prisma, payload.runId, payload.toolCallId, externalRunId);
        },
      });
      const credits =
        result.ok && result.output && typeof result.output === "object" && "creditMicrocredits" in result.output
          ? BigInt(String((result.output as { creditMicrocredits: unknown }).creditMicrocredits ?? "0"))
          : 0n;
      return {
        ok: result.ok,
        output: result.ok ? result.output : null,
        ...(result.ok ? {} : { error: result.error }),
        durationMs: Date.now() - started,
        creditMicrocredits: credits.toString(),
      };
    } catch (error) {
      const externalRunId =
        error instanceof AppError && error.details && typeof error.details === "object" && "externalRunId" in error.details
          ? String((error.details as { externalRunId: unknown }).externalRunId)
          : null;
      if (externalRunId) {
        await rememberExternalRun(prisma, payload.runId, payload.toolCallId, externalRunId).catch(() => undefined);
        throw error;
      }
      // A rejected body never started a Magica run. Return it so the model can correct the input.
      if (error instanceof AppError && !error.retryable) {
        return {
          ok: false,
          output: null,
          error: error.message,
          durationMs: Date.now() - started,
          creditMicrocredits: "0",
        };
      }
      throw error;
    }
  },
});
