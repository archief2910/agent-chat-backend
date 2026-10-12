import { logger, metadata, task, wait } from "@trigger.dev/sdk";
import { extendContext, runWithContext } from "@/lib/trace";
import { agentChunkSchema, runMetadataSchema, type RunMetadata } from "@/contracts";
import { getPrisma } from "@/lib/db";
import { getEnv } from "@/lib/env";
import { executeAgentTurn } from "@/server/agent/execute-turn";
import { createOpenRouterProvider } from "@/server/agent/openrouter";
import { MagicaClient } from "@/server/magica/client";
import { getSkillRegistry } from "@/server/skills/registry";
import { createToolRegistry } from "@/server/tools/registry";
import type { WaitForUser } from "@/server/waitpoints/registry";
import { openWaitpoint, presentWaitpoint, settleWaitpoint } from "@/server/waitpoints/service";
import { magicaRun } from "@/trigger/magica-run";
import { agentOutput, cancelStream } from "@/trigger/streams";

export const agentTurn = task({
  id: "agent-turn",
  retry: { maxAttempts: 3 },
  run: async (payload: { runId: string; traceId: string }, { ctx }) => {
    const env = getEnv();
    const prisma = getPrisma();
    const abort = new AbortController();
    cancelStream.on((data) => abort.abort(data.reason ?? "cancelled"));
    const client = new MagicaClient({ baseUrl: env.MAGICA_BASE_URL, apiKey: env.MAGICA_API_KEY });
    const skills = getSkillRegistry();
    const tools = createToolRegistry({
      magica: client,
      skills,
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    });

    const publishMetadata = (patch: Partial<RunMetadata>) => {
      const current = metadata.get("run");
      const next = runMetadataSchema.safeParse({
        runId: payload.runId,
        status: "thinking",
        step: 0,
        progress: 0,
        activeTools: [],
        assets: [],
        waitpoint: null,
        ...(current && typeof current === "object" ? current : {}),
        ...patch,
        updatedAt: new Date().toISOString(),
      });
      if (next.success) metadata.set("run", JSON.parse(JSON.stringify(next.data)) as Record<string, string>);
      else logger.error("run metadata failed its contract", { issues: next.error.issues });
    };

    const waitForUser: WaitForUser = async ({ toolCallId, kind, request }) => {
      const timeoutMinutes = env.WAITPOINT_TIMEOUT_MINUTES;
      const token = await wait.createToken({
        timeout: `${timeoutMinutes}m`,
        idempotencyKey: `${payload.runId}:${toolCallId}`,
        idempotencyKeyTTL: "24h",
        tags: [`run:${payload.runId}`],
      });
      const row = await openWaitpoint(prisma, {
        runId: payload.runId,
        toolCallId,
        kind,
        request,
        tokenId: token.id,
        expiresAt: new Date(Date.now() + timeoutMinutes * 60_000),
      });
      publishMetadata({ status: "waiting", waitpoint: presentWaitpoint(row) });
      const result = await runWithContext(extendContext({ waitpointTokenId: token.id }), async () => {
        logger.info("waiting for a user decision");
        return wait.forToken<{ response?: Record<string, unknown>; cancelled?: boolean }>(token);
      });
      if (!result.ok) {
        await settleWaitpoint(prisma, { runId: payload.runId, toolCallId, status: "expired" });
        publishMetadata({ status: "thinking", waitpoint: null });
        return { status: "expired" };
      }
      if (result.output.cancelled) {
        await settleWaitpoint(prisma, { runId: payload.runId, toolCallId, status: "cancelled" });
        publishMetadata({ status: "stopping", waitpoint: null });
        return { status: "cancelled" };
      }
      await settleWaitpoint(prisma, { runId: payload.runId, toolCallId, status: "answered" });
      publishMetadata({ status: "thinking", waitpoint: null });
      return { status: "answered", response: result.output.response ?? {} };
    };

    publishMetadata({ status: "thinking" });
    const result = await executeAgentTurn(payload, {
      signal: abort.signal,
      attempt: ctx.attempt.number,
      processId: ctx.run.id,
      provider: createOpenRouterProvider({
        apiKey: env.OPENROUTER_API_KEY,
        baseUrl: env.OPENROUTER_BASE_URL,
        referer: env.APP_BASE_URL,
      }),
      tools,
      skills,
      waitForUser,
      publish: async (chunk) => {
        await agentOutput.append(agentChunkSchema.parse(chunk));
      },
      onProgress: async (update) => {
        publishMetadata({ step: update.step, progress: update.progress, assets: update.assets });
      },
      executeDurable: async (calls) => {
        publishMetadata({ status: "working", activeTools: calls.map((call) => ({ toolCallId: call.toolCallId, name: call.name })) });
        // One batch: Trigger.dev cannot wait on parallel triggerAndWait calls.
        const batch = await magicaRun.batchTriggerAndWait(
          calls.map((call) => ({
            payload: { runId: payload.runId, toolCallId: call.toolCallId, name: call.name, input: call.input },
            options: { idempotencyKey: `${payload.runId}:${call.toolCallId}`, idempotencyKeyTTL: "24h" as const },
          })),
        );
        publishMetadata({ status: "thinking", activeTools: [] });
        return calls.map((call, index) => {
          const run = batch.runs[index];
          if (run?.ok) {
            return {
              toolCallId: call.toolCallId,
              ok: run.output.ok,
              output: run.output.output,
              ...(run.output.error ? { error: run.output.error } : {}),
              durationMs: run.output.durationMs,
              creditMicrocredits: BigInt(run.output.creditMicrocredits),
            };
          }
          logger.error("durable tool failed", { err: run?.error, toolCallId: call.toolCallId });
          return {
            toolCallId: call.toolCallId,
            ok: false as const,
            output: null,
            error: toolFailure(run?.error),
            durationMs: 0,
            creditMicrocredits: 0n,
          };
        });
      },
    });
    const final = await prisma.agentRun.findUnique({ where: { id: payload.runId }, select: { status: true } });
    if (final) {
      const done = final.status === "completed" || final.status === "failed" || final.status === "cancelled";
      publishMetadata({ status: final.status, ...(done ? { progress: 100 } : {}), activeTools: [], waitpoint: null });
    }
    return result;
  },
});

function toolFailure(error: unknown): string {
  const message =
    error instanceof Error
      ? error.message
      : error && typeof error === "object" && "message" in error && typeof error.message === "string"
        ? error.message
        : "";
  const clean = message.replace(/\s+/g, " ").trim();
  if (!clean || clean.length > 300) return "The tool failed before it could finish.";
  return clean;
}
