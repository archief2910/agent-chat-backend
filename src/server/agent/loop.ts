import type { ContentBlock } from "@/contracts";
import { AppError } from "@/lib/errors";
import { formatCredits } from "@/server/credits";
import type { LoadedSkill } from "@/server/tools/registry";
import type { WaitForUser } from "@/server/waitpoints/registry";
import { generatedMedia, type GeneratedMedia } from "@/server/agent/media";
import { buildSystemPrompt, fitTranscript } from "@/server/agent/prompt";
import type { ModelMessage, ModelProvider, ProviderEvent } from "@/server/agent/types";
import { ProviderError } from "@/server/agent/types";
import type { ToolRegistry } from "@/server/tools/registry";

export type LoopStatus = "completed" | "failed" | "cancelled";

export type LoopResult = {
  status: LoopStatus;
  errorCode?: string;
  errorMessage?: string;
  routedModel: string | null;
  promptTokens: number;
  completionTokens: number;
  stepCount: number;
  blocks: ContentBlock[];
};

export type DurableCall = {
  toolCallId: string;
  name: string;
  input: unknown;
  ordinal: number;
};

export type DurableResult = {
  toolCallId: string;
  ok: boolean;
  output: unknown;
  error?: string;
  durationMs: number;
  creditMicrocredits: bigint;
};

type ToolOutcome = { isError: boolean; output: unknown; durationMs: number; creditMicrocredits: bigint };

export type RunPersistence = {
  isCancelRequested: (runId: string) => Promise<boolean>;
  checkpoint: (runId: string, state: { status: "thinking" | "working"; blocks: ContentBlock[]; stepCount: number; routedModel: string | null; promptTokens: number; completionTokens: number }) => Promise<void>;
  toolStarted: (runId: string, tool: { toolCallId: string; name: string; ordinal: number; input: unknown }) => Promise<void>;
  reserve: (runId: string, toolCallId: string, amount: bigint) => Promise<void>;
  toolFinished: (runId: string, tool: { toolCallId: string; name: string; isError: boolean; output: unknown; durationMs: number; creditMicrocredits: bigint }) => Promise<void>;
  completedTool: (runId: string, toolCallId: string) => Promise<ToolOutcome | null>;
  approvedPlan: (runId: string) => Promise<boolean>;
  skillLoaded: (runId: string, skill: LoadedSkill) => Promise<void>;
  schemaReady?: (runId: string, toolCallId: string, info: { schemaModelId: string; schemaDurationMs: number }) => Promise<void>;
  finalize: (runId: string, result: LoopResult) => Promise<void>;
};

type Completion = {
  text: string;
  thinking: string;
  toolCalls: Array<{ id: string; name: string; arguments: unknown; raw: string; invalid: boolean }>;
  promptTokens: number;
  completionTokens: number;
  routedModel: string | null;
  thinkingDurationMs?: number;
  empty: boolean;
};

export async function runAgentLoop(options: {
  runId: string;
  chatId: string;
  userId: string;
  transcript: ModelMessage[];
  initialBlocks?: ContentBlock[];
  provider: ModelProvider;
  tools: ToolRegistry;
  skills: { list: () => Array<{ name: string; description: string }> };
  persistence: RunPersistence;
  executeDurable: (calls: DurableCall[]) => Promise<DurableResult[]>;
  limits: { maxSteps: number; maxToolCalls: number; maxDurationMs: number; maxContextChars: number };
  signal: AbortSignal;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  onDelta: (delta: { seq: number; kind: "text" | "thinking"; delta: string }) => Promise<void>;
  onProgress?: (update: { step: number; progress: number; assets: Array<GeneratedMedia & { toolCallId: string }> }) => Promise<void>;
  waitForUser: WaitForUser;
  planMode: boolean;
  creditApprovalMicrocredits: bigint;
  restoredSkills?: LoadedSkill[];
}): Promise<LoopResult> {
  const started = options.now();
  const loadedSkills = new Map((options.restoredSkills ?? []).map((skill) => [skill.name, skill]));
  const producedAssets: Array<GeneratedMedia & { toolCallId: string }> = [];
  const report = async (stepCount: number) => {
    const progress = Math.min(99, Math.round((stepCount / options.limits.maxSteps) * 100));
    await options.onProgress?.({ step: stepCount, progress, assets: producedAssets }).catch(() => undefined);
  };
  let blocks = [...(options.initialBlocks ?? [])];
  let planApproved = await options.persistence.approvedPlan(options.runId);
  let transcript = [...options.transcript];
  let visible = blocks.some((block) => block.type === "text" || (block.type === "thinking" && block.text.length > 0));
  let routedModel: string | null = null;
  let promptTokens = 0;
  let completionTokens = 0;
  let step = 0;
  let seq = 0;
  const system = buildSystemPrompt(options.skills.list());

  const finish = async (status: LoopStatus, errorCode?: string, errorMessage?: string): Promise<LoopResult> => {
    const withUsage = appendUsage(blocks, routedModel, promptTokens, completionTokens);
    const result: LoopResult = {
      status,
      blocks: withUsage,
      routedModel,
      promptTokens,
      completionTokens,
      stepCount: step,
      ...(errorCode ? { errorCode, errorMessage } : {}),
    };
    await options.persistence.finalize(options.runId, result);
    return result;
  };

  while (step < options.limits.maxSteps) {
    if (options.signal.aborted || (await options.persistence.isCancelRequested(options.runId))) {
      return finish("cancelled", "CANCELLED", "The turn was stopped.");
    }
    if (options.now() - started > options.limits.maxDurationMs) {
      return finish("failed", "MAX_DURATION", "This turn reached its time limit before it could finish.");
    }
    step += 1;
    await options.persistence.checkpoint(options.runId, {
      status: "thinking",
      blocks,
      stepCount: step,
      routedModel,
      promptTokens,
      completionTokens,
    });
    await report(step);

    let completion: Completion;
    try {
      completion = await streamOnce();
    } catch (error) {
      if (error instanceof ProviderError) {
        const code = error.status === 429 ? "MODEL_RATE_LIMITED" : "MODEL_UNAVAILABLE";
        return finish("failed", code, error.message);
      }
      throw error;
    }
    if (completion.routedModel) routedModel = completion.routedModel;
    promptTokens += completion.promptTokens;
    completionTokens += completion.completionTokens;
    if (completion.text.length > 0 || completion.thinking.length > 0) visible = true;
    blocks = applyModelBlocks(blocks, completion);
    await options.persistence.checkpoint(options.runId, {
      status: completion.toolCalls.length > 0 ? "working" : "thinking",
      blocks,
      stepCount: step,
      routedModel,
      promptTokens,
      completionTokens,
    });

    if (completion.toolCalls.length === 0) {
      if (completion.empty) {
        return finish("failed", "EMPTY_RESPONSE", "The free model returned an empty response. Try again in a moment.");
      }
      return finish("completed");
    }

    const accepted = completion.toolCalls.slice(0, options.limits.maxToolCalls);
    const overflow = completion.toolCalls.slice(options.limits.maxToolCalls);
    const outcomes = new Map<string, ToolOutcome>();
    const finished = new Set<string>();
    const inline: Array<{ call: Completion["toolCalls"][number]; input: unknown; ordinal: number }> = [];
    const durable: DurableCall[] = [];
    const reject = async (call: Completion["toolCalls"][number], ordinal: number, error: string) => {
      const outcome = { isError: true, output: { error }, durationMs: 0, creditMicrocredits: 0n };
      outcomes.set(call.id, outcome);
      await options.persistence.toolStarted(options.runId, { toolCallId: call.id, name: call.name, ordinal, input: call.arguments });
      await options.persistence.toolFinished(options.runId, { toolCallId: call.id, name: call.name, ...outcome });
      finished.add(call.id);
    };

    for (const [ordinal, call] of accepted.entries()) {
      const failure = validateCall(call, options.tools);
      if (failure) {
        await reject(call, ordinal, String((failure.output as { error: string }).error));
        continue;
      }
      const tool = options.tools.get(call.name);
      if (!tool) continue;
      if (tool.execution === "inline") inline.push({ call, input: call.arguments, ordinal });
      else durable.push({ toolCallId: call.id, name: call.name, input: call.arguments, ordinal });
    }

    const context = (toolCallId: string) => ({
      runId: options.runId,
      chatId: options.chatId,
      userId: options.userId,
      toolCallId,
      signal: options.signal,
      recordSkill: async (skill: LoadedSkill) => {
        loadedSkills.set(skill.name, skill);
        await options.persistence.skillLoaded(options.runId, skill);
      },
      loadedSkill: (name: string) => loadedSkills.get(name) ?? null,
      rememberExternalRun: async () => {},
      waitForUser: options.waitForUser,
    });

    const billable: Array<{ toolCallId: string; name: string; input: unknown; ordinal: number; call: Completion["toolCalls"][number] }> = [];
    for (const item of durable) {
      const call = accepted.find((candidate) => candidate.id === item.toolCallId);
      if (call) billable.push({ ...item, call });
    }
    const approvedDurable: DurableCall[] = [];
    let planDeclined = false;
    if (options.planMode && !planApproved && billable.length > 0) {
      const awaiting: typeof billable = [];
      for (const item of billable) {
        if (!(await options.persistence.completedTool(options.runId, item.toolCallId))) awaiting.push(item);
      }
      if (awaiting.length > 0) {
        const summary = [...blocks].reverse().flatMap((block) => (block.type === "text" ? [block.text] : [])).find((text) => text.trim().length > 0)
          ?? "Approve this plan before any paid tool runs.";
        const answer = await options.waitForUser({
          toolCallId: `plan:${awaiting.map((entry) => entry.toolCallId).join(":")}`.slice(0, 180),
          kind: "plan",
          request: { summary: summary.slice(0, 1_000), steps: awaiting.map((entry) => entry.name).slice(0, 20) },
        });
        if (answer.status === "expired") {
          return finish("cancelled", "WAITPOINT_EXPIRED", "No answer was received in time. Send a message to continue.");
        }
        if (answer.status === "cancelled") return finish("cancelled", "CANCELLED", "The turn was stopped.");
        if (answer.response.approved === true) planApproved = true;
        else planDeclined = true;
      }
    }
    try {
      for (const item of billable) {
        if (await options.persistence.completedTool(options.runId, item.toolCallId)) {
          approvedDurable.push(item);
          continue;
        }
        if (planDeclined) {
          await reject(item.call, item.ordinal, "The user declined the plan, so this tool did not run.");
          continue;
        }
        const tool = options.tools.get(item.name);
        const amount = tool ? await tool.estimateCredits(item.input) : 0n;
        if (options.creditApprovalMicrocredits > 0n && amount >= options.creditApprovalMicrocredits) {
          const answer = await options.waitForUser({
            toolCallId: `${item.toolCallId}:credit`,
            kind: "credit",
            request: { toolName: item.name, estimatedMicrocredits: amount.toString(), credits: formatCredits(amount) },
          });
          if (answer.status === "expired") {
            return finish("cancelled", "WAITPOINT_EXPIRED", "No answer was received in time. Send a message to continue.");
          }
          if (answer.status === "cancelled") return finish("cancelled", "CANCELLED", "The turn was stopped.");
          if (answer.response.approved !== true) {
            await reject(item.call, item.ordinal, "The user declined the credit charge for this tool.");
            continue;
          }
        }
        await options.persistence.reserve(options.runId, item.toolCallId, amount);
        approvedDurable.push(item);
      }
    } catch (error) {
      if (error instanceof AppError && error.code === "INSUFFICIENT_CREDITS") {
        return finish("failed", "INSUFFICIENT_CREDITS", error.message);
      }
      throw error;
    }

    await Promise.all(
      inline.map(async ({ call, input, ordinal }) => {
        const existing = await options.persistence.completedTool(options.runId, call.id);
        if (existing) {
          outcomes.set(call.id, existing);
          return;
        }
        const tool = options.tools.get(call.name);
        if (!tool) return;
        await options.persistence.toolStarted(options.runId, { toolCallId: call.id, name: call.name, ordinal, input });
        const startedAt = options.now();
        const result = await tool.execute(input, context(call.id));
        outcomes.set(call.id, outcomeFrom(result, tool.output, options.now() - startedAt));
      }),
    );
    const written = new Set<string>();
    const writeCalls = async (calls: Array<Completion["toolCalls"][number]>) => {
      for (const call of calls) {
        if (written.has(call.id)) continue;
        written.add(call.id);
        const outcome = outcomes.get(call.id) ?? {
          isError: true,
          output: { error: `Call at most ${options.limits.maxToolCalls} tools at once.` },
          durationMs: 0,
          creditMicrocredits: 0n,
        };
        if (!finished.has(call.id)) {
          if (!outcomes.has(call.id)) {
            await options.persistence.toolStarted(options.runId, { toolCallId: call.id, name: call.name, ordinal: accepted.length, input: call.arguments });
          }
          await options.persistence.toolFinished(options.runId, {
            toolCallId: call.id,
            name: call.name,
            isError: outcome.isError,
            output: outcome.output,
            durationMs: outcome.durationMs,
            creditMicrocredits: outcome.creditMicrocredits,
          });
          finished.add(call.id);
        }
        blocks = [
          ...blocks,
          { type: "tool_use", id: call.id, name: call.name, input: call.invalid ? call.raw : call.arguments },
          { type: "tool_result", toolUseId: call.id, name: call.name, isError: outcome.isError, output: resultOutput(outcome) },
          ...assetBlocks(outcome.output),
        ];
        for (const media of generatedMedia(outcome.output)) {
          if (!producedAssets.some((item) => item.url === media.url)) producedAssets.push({ ...media, toolCallId: call.id });
        }
      }
    };
    if (inline.length > 0) {
      await writeCalls(inline.map((item) => item.call));
      await options.persistence.checkpoint(options.runId, {
        status: "working",
        blocks,
        stepCount: step,
        routedModel,
        promptTokens,
        completionTokens,
      });
      await report(step);
    }

    const pending: DurableCall[] = [];
    for (const call of approvedDurable) {
      const existing = await options.persistence.completedTool(options.runId, call.toolCallId);
      if (existing) outcomes.set(call.toolCallId, existing);
      else pending.push(call);
    }
    for (const call of pending) {
      await options.persistence.toolStarted(options.runId, {
        toolCallId: call.toolCallId,
        name: call.name,
        ordinal: call.ordinal,
        input: call.input,
      });
    }
    if (pending.length > 0 && options.persistence.schemaReady) {
      for (const call of pending) {
        const tool = options.tools.get(call.name);
        if (!tool?.previewSchema) continue;
        const preview = await tool.previewSchema(call.input);
        if (preview) await options.persistence.schemaReady(options.runId, call.toolCallId, preview);
      }
      await report(step);
    }
    if (pending.length > 0) {
      const results = await options.executeDurable(pending);
      for (const result of results) {
        outcomes.set(result.toolCallId, {
          isError: !result.ok,
          output: result.ok ? result.output : { error: result.error ?? "The tool failed." },
          durationMs: result.durationMs,
          creditMicrocredits: result.creditMicrocredits,
        });
      }
    }

    await writeCalls([...accepted, ...overflow]);

    transcript = [
      ...transcript,
      {
        role: "assistant",
        content: completion.text || null,
        tool_calls: completion.toolCalls.map((call) => ({
          id: call.id,
          type: "function" as const,
          function: { name: call.name, arguments: call.raw || "{}" },
        })),
      },
      ...[...accepted, ...overflow].map((call) => ({
        role: "tool" as const,
        tool_call_id: call.id,
        content: JSON.stringify(outcomes.get(call.id)?.output ?? { error: "Too many tool calls." }),
      })),
    ];
    await options.persistence.checkpoint(options.runId, {
      status: "thinking",
      blocks,
      stepCount: step,
      routedModel,
      promptTokens,
      completionTokens,
    });
    await report(step);
  }

  return finish("failed", "MAX_STEPS", "This turn used its step limit before it could finish. Try a smaller request.");

  async function streamOnce(): Promise<Completion> {
    let attempt = 0;
    while (true) {
      try {
        return await readStream();
      } catch (error) {
        const retryable = error instanceof ProviderError && error.retryable && !visible;
        if (!retryable || attempt >= 2) throw error;
        attempt += 1;
        const wait = error instanceof ProviderError && error.status === 429 ? rateLimitWaitMs(error, attempt) : modelRetryDelayMs(attempt);
        await options.sleep(wait);
      }
    }
  }

  async function readStream(): Promise<Completion> {
    const messages = [
      { role: "system" as const, content: system },
      ...fitTranscript(system, transcript, options.limits.maxContextChars),
    ];
    const tools = await options.tools.definitions();
    let text = "";
    let thinking = "";
    let thinkingStartedAt: number | null = null;
    const toolCalls: Completion["toolCalls"] = [];
    let prompt = 0;
    let completionTokensLocal = 0;
    let model: string | null = null;
    for await (const event of options.provider.stream({ messages, tools, signal: options.signal })) {
      apply(event);
    }
    const thinkingDurationMs = thinkingStartedAt === null ? undefined : Math.max(0, options.now() - thinkingStartedAt);
    return {
      text,
      thinking,
      toolCalls,
      promptTokens: prompt,
      completionTokens: completionTokensLocal,
      routedModel: model,
      ...(thinkingDurationMs === undefined ? {} : { thinkingDurationMs }),
      empty: text.length === 0 && thinking.length === 0 && toolCalls.length === 0,
    };

    function apply(event: ProviderEvent) {
      if (event.type === "text") {
        text += event.delta;
        seq += 1;
        void options.onDelta({ seq, kind: "text", delta: event.delta });
      } else if (event.type === "thinking") {
        if (thinkingStartedAt === null) thinkingStartedAt = options.now();
        thinking += event.delta;
        seq += 1;
        void options.onDelta({ seq, kind: "thinking", delta: event.delta });
      } else if (event.type === "tool_call") {
        toolCalls.push(event);
      } else if (event.type === "usage") {
        prompt = event.promptTokens;
        completionTokensLocal = event.completionTokens;
        if (event.routedModel) model = event.routedModel;
      }
    }
  }
}

function validateCall(call: { name: string; arguments: unknown; invalid: boolean }, tools: ToolRegistry): ToolOutcome | null {
  if (call.invalid) {
    return { isError: true, output: { error: "The tool arguments were not valid JSON." }, durationMs: 0, creditMicrocredits: 0n };
  }
  const tool = tools.get(call.name);
  if (!tool) {
    return { isError: true, output: { error: `Unknown tool: ${call.name}` }, durationMs: 0, creditMicrocredits: 0n };
  }
  const parsed = tool.input.safeParse(call.arguments);
  if (!parsed.success) {
    return {
      isError: true,
      output: { error: parsed.error.issues.map((issue) => issue.message).join(" ") },
      durationMs: 0,
      creditMicrocredits: 0n,
    };
  }
  return null;
}

function rateLimitWaitMs(error: ProviderError, attempt: number): number {
  if (error.retryAfterMs !== undefined) return Math.min(Math.max(error.retryAfterMs, 1_000), 20_000);
  return Math.min(20_000, 5_000 * attempt);
}

/** Backoff for an OpenRouter 429. The wait grows, with jitter, and the turn still fails after three tries. */
export function modelRetryDelayMs(attempt: number, random: () => number = Math.random): number {
  const base = 500 * 2 ** Math.max(0, attempt - 1);
  return Math.max(1, Math.round(base * (0.5 + random() * 0.5)));
}

function outcomeFrom(result: { ok: boolean; output?: unknown; error?: string }, outputSchema: { safeParse: (value: unknown) => { success: boolean; data?: unknown } }, durationMs: number): ToolOutcome {
  if (!result.ok) {
    return { isError: true, output: { error: result.error ?? "The tool failed." }, durationMs, creditMicrocredits: 0n };
  }
  const parsed = outputSchema.safeParse(result.output);
  if (!parsed.success) {
    return { isError: true, output: { error: "The tool returned an unexpected result." }, durationMs, creditMicrocredits: 0n };
  }
  const credits = parsed.data && typeof parsed.data === "object" && "creditMicrocredits" in parsed.data ? BigInt(String((parsed.data as { creditMicrocredits: unknown }).creditMicrocredits || "0")) : 0n;
  return { isError: false, output: parsed.data, durationMs, creditMicrocredits: credits };
}

function applyModelBlocks(blocks: ContentBlock[], completion: Completion): ContentBlock[] {
  const next = [...blocks];
  if (completion.thinkingDurationMs) next.push({ type: "thinking", text: "", durationMs: completion.thinkingDurationMs });
  if (completion.text) next.push({ type: "text", text: completion.text });
  return next;
}

function resultOutput(outcome: ToolOutcome): unknown {
  const output = outcome.output;
  if (output && typeof output === "object" && !Array.isArray(output)) {
    if (typeof (output as { durationMs?: unknown }).durationMs === "number") return output;
    return { ...output, durationMs: outcome.durationMs };
  }
  return { value: output ?? null, durationMs: outcome.durationMs };
}

function appendUsage(blocks: ContentBlock[], model: string | null, promptTokens: number, completionTokens: number): ContentBlock[] {
  return [
    ...blocks.filter((block) => block.type !== "usage"),
    {
      type: "usage",
      model: model ?? "openrouter/free",
      promptTokens,
      completionTokens,
      chargedMicrocredits: "0",
    },
  ];
}

function assetBlocks(output: unknown): ContentBlock[] {
  return generatedMedia(output).map((item) => ({ type: "asset" as const, kind: item.kind, url: item.url }));
}
