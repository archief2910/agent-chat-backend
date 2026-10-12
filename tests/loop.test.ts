import { describe, expect, it } from "vitest";
import type { ContentBlock } from "@/contracts";
import { modelRetryDelayMs, runAgentLoop, type DurableCall, type DurableResult, type RunPersistence } from "@/server/agent/loop";
import type { ModelMessage, ModelProvider, ProviderEvent } from "@/server/agent/types";
import { ProviderError } from "@/server/agent/types";
import { MagicaClient } from "@/server/magica/client";
import { createSkillRegistry } from "@/server/skills/registry";
import { createToolRegistry, type LoadedSkill } from "@/server/tools/registry";
import type { WaitForUser } from "@/server/waitpoints/registry";

function memoryPersistence() {
  const skills = new Map<string, string>();
  const tools = new Map<string, { isError: boolean; output: unknown }>();
  const reserved: Array<{ toolCallId: string; amount: bigint }> = [];
  let cancel = false;
  const persistence: RunPersistence = {
    isCancelRequested: async () => cancel,
    checkpoint: async () => {},
    reserve: async (_runId, toolCallId, amount) => {
      reserved.push({ toolCallId, amount });
    },
    toolStarted: async () => {},
    toolFinished: async (_runId, tool) => {
      tools.set(tool.toolCallId, { isError: tool.isError, output: tool.output });
    },
    completedTool: async (_runId, toolCallId) => {
      const tool = tools.get(toolCallId);
      return tool ? { ...tool, durationMs: 0, creditMicrocredits: 0n } : null;
    },
    approvedPlan: async () => false,
    skillLoaded: async (_runId, skill) => {
      if (!skills.has(skill.name)) skills.set(skill.name, skill.hash);
    },
    finalize: async () => {},
  };
  return { persistence, skills, reserved, requestCancel: () => (cancel = true) };
}

function scripted(script: ProviderEvent[][], seen: ModelMessage[][]): ModelProvider {
  return {
    async *stream(input) {
      seen.push(input.messages);
      for (const event of script.shift() ?? []) yield event;
    },
  };
}

const offlineMagica = new MagicaClient({
  baseUrl: "https://inference.example.test",
  apiKey: "gx_test",
  fetchImpl: async () => {
    throw new Error("offline");
  },
});
const tools = createToolRegistry({ skills: createSkillRegistry(), magica: offlineMagica, sleep: async () => {} });

const call = (id: string, name: string, args: unknown): ProviderEvent => ({
  type: "tool_call",
  id,
  name,
  arguments: args,
  raw: JSON.stringify(args),
  invalid: false,
});
const done = (text: string): ProviderEvent[] => [{ type: "text", delta: text }, { type: "finish", reason: "stop" }];
const crop = { image_url: "https://cdn.example/a.png", x_percent: 0, y_percent: 0, width_percent: 50, height_percent: 50 };

async function run(
  script: ProviderEvent[][],
  extras: {
    waitForUser?: WaitForUser;
    planMode?: boolean;
    creditApprovalMicrocredits?: bigint;
    restoredSkills?: LoadedSkill[];
    executeDurable?: (calls: DurableCall[]) => Promise<DurableResult[]>;
    provider?: ModelProvider;
    memory?: ReturnType<typeof memoryPersistence>;
  } = {},
) {
  const seen: ModelMessage[][] = [];
  const memory = extras.memory ?? memoryPersistence();
  const result = await runAgentLoop({
    runId: "run_1",
    chatId: "chat_1",
    userId: "user_1",
    transcript: [{ role: "user", content: "Help with this image." }],
    provider: extras.provider ?? scripted(script, seen),
    tools,
    skills: createSkillRegistry(),
    persistence: memory.persistence,
    executeDurable: extras.executeDurable ?? (async () => []),
    limits: { maxSteps: 3, maxToolCalls: 4, maxDurationMs: 60_000, maxContextChars: 20_000 },
    signal: new AbortController().signal,
    now: () => 0,
    sleep: async () => {},
    onDelta: async () => {},
    waitForUser: extras.waitForUser ?? (async () => ({ status: "answered", response: { approved: true } })),
    planMode: extras.planMode ?? false,
    creditApprovalMicrocredits: extras.creditApprovalMicrocredits ?? 0n,
    ...(extras.restoredSkills ? { restoredSkills: extras.restoredSkills } : {}),
  });
  return { result, seen, memory };
}

const toolResults = (blocks: ContentBlock[]) => blocks.filter((block) => block.type === "tool_result");

describe("agent loop", () => {
  it("loads a skill only after the model asks, and dedupes a second load", async () => {
    const { result, seen, memory } = await run([
      [call("call_1", "load_skill", { name: "image-cropping" }), { type: "finish", reason: "tool_calls" }],
      [call("call_2", "load_skill", { name: "image-cropping" }), { type: "finish", reason: "tool_calls" }],
      [...done("Done."), { type: "usage", promptTokens: 3, completionTokens: 1, routedModel: "deepseek/deepseek-chat:free" }],
    ]);
    const firstSystem = seen[0]?.[0];
    if (firstSystem && "content" in firstSystem) expect(firstSystem.content).not.toContain("Do not mix the three forms");
    expect(JSON.stringify(seen[1])).toContain("Do not mix the three forms");
    expect(memory.skills.size).toBe(1);
    expect(result.status).toBe("completed");
    expect(result.routedModel).toBe("deepseek/deepseek-chat:free");
    expect(result.blocks.some((block) => block.type === "usage" && block.chargedMicrocredits === "0")).toBe(true);
  });

  it("replays the recorded skill body on resume even if the file changed", async () => {
    const { seen, memory } = await run(
      [[call("call_1", "load_skill", { name: "image-cropping" }), { type: "finish", reason: "tool_calls" }], done("ok")],
      { restoredSkills: [{ name: "image-cropping", hash: "hash_v1", body: "Recorded guidance v1." }] },
    );
    const second = JSON.stringify(seen[1]);
    expect(second).toContain("Recorded guidance v1.");
    expect(second).not.toContain("Do not mix the three forms");
    expect(memory.skills.size).toBe(0);
  });

  it("returns a tool error for malformed and unknown calls without throwing", async () => {
    const { result } = await run([
      [
        { type: "tool_call", id: "bad", name: "crop_image", arguments: null, raw: "{", invalid: true },
        call("missing", "not_a_tool", {}),
        { type: "finish", reason: "tool_calls" },
      ],
      done("I need a clearer request."),
    ]);
    expect(result.status).toBe("completed");
    const results = toolResults(result.blocks);
    expect(results).toHaveLength(2);
    expect(results.every((block) => block.type === "tool_result" && block.isError)).toBe(true);
  });

  it("blocks billable tools in plan mode until a plan is approved", async () => {
    const durableCalls: string[] = [];
    const executeDurable = async (calls: DurableCall[]) => {
      durableCalls.push(...calls.map((item) => item.toolCallId));
      return calls.map((item) => ({ toolCallId: item.toolCallId, ok: true, output: {}, durationMs: 1, creditMicrocredits: 0n }));
    };
    const blocked = await run(
      [[call("crop_1", "crop_image", crop), { type: "finish", reason: "tool_calls" }], done("Waiting for a plan.")],
      {
        planMode: true,
        executeDurable,
        waitForUser: async (input) => {
          expect(input.kind).toBe("plan");
          expect(input.toolCallId).toBe("plan:crop_1");
          return { status: "answered", response: { approved: false } };
        },
      },
    );
    expect(durableCalls).toEqual([]);
    expect(JSON.stringify(toolResults(blocked.result.blocks))).toContain("declined the plan");

    const approved = await run(
      [[call("crop_2", "crop_image", crop), { type: "finish", reason: "tool_calls" }], done("Cropped.")],
      { planMode: true, executeDurable },
    );
    expect(approved.result.status).toBe("completed");
    expect(durableCalls).toEqual(["crop_2"]);
  });

  it("asks for credit approval above the threshold and respects a decline", async () => {
    const asked: string[] = [];
    const { result, memory } = await run(
      [[call("crop_1", "crop_image", crop), { type: "finish", reason: "tool_calls" }], done("Skipped.")],
      {
        creditApprovalMicrocredits: 1n,
        waitForUser: async (input) => {
          asked.push(`${input.kind}:${input.toolCallId}`);
          return { status: "answered", response: { approved: false } };
        },
      },
    );
    expect(asked).toEqual(["credit:crop_1:credit"]);
    expect(memory.reserved).toEqual([]);
    expect(JSON.stringify(toolResults(result.blocks))).toContain("declined the credit charge");
  });

  it("ends safely when an approval expires", async () => {
    const { result } = await run(
      [[call("crop_1", "crop_image", crop), { type: "finish", reason: "tool_calls" }]],
      { planMode: true, waitForUser: async () => ({ status: "expired" }) },
    );
    expect(result.status).toBe("cancelled");
    expect(result.errorCode).toBe("WAITPOINT_EXPIRED");
  });

  it("fails clearly when the free route stays rate limited", async () => {
    let attempts = 0;
    const { result } = await run([], {
      provider: {
        async *stream() {
          attempts += 1;
          throw new ProviderError(429, true, "The free model route is rate limited. Wait and try again.");
        },
      },
    });
    expect(result.status).toBe("failed");
    expect(result.errorCode).toBe("MODEL_RATE_LIMITED");
    expect(attempts).toBe(3);
    expect(modelRetryDelayMs(1, () => 0)).toBe(250);
    expect(modelRetryDelayMs(2, () => 0)).toBe(500);
  });

  it("stops when cancellation is requested", async () => {
    const memory = memoryPersistence();
    memory.requestCancel();
    const { result } = await run([done("nope")], { memory });
    expect(result.status).toBe("cancelled");
  });

  it("chains a generated image into a crop without a model selector", async () => {
    const seen: string[] = [];
    const { result } = await run(
      [
        [call("gen_1", "gpt_image_2", { prompt: "a red cup" }), { type: "finish", reason: "tool_calls" }],
        [call("crop_1", "crop_image", crop), { type: "finish", reason: "tool_calls" }],
        done("Cropped the generated image."),
      ],
      {
        executeDurable: async (calls) =>
          calls.map((item) => {
            seen.push(item.name);
            const url = item.name === "gpt_image_2" ? "https://cdn.example/generated.png" : "https://cdn.example/cropped.png";
            return {
              toolCallId: item.toolCallId,
              ok: true,
              output: {
                image_url: url,
                image_urls: [url],
                externalRunId: `magica_${item.name}`,
                creditMicrocredits: "5000",
                durationMs: 10,
              },
              durationMs: 10,
              creditMicrocredits: 5000n,
            };
          }),
      },
    );
    expect(seen).toEqual(["gpt_image_2", "crop_image"]);
    expect(result.status).toBe("completed");
    expect(result.blocks.filter((block) => block.type === "asset")).toEqual([
      { type: "asset", kind: "image", url: "https://cdn.example/generated.png" },
      { type: "asset", kind: "image", url: "https://cdn.example/cropped.png" },
    ]);
  });

  it("stops at the step limit", async () => {
    const loop = () => [call(`c_${Math.random()}`, "load_skill", { name: "missing-skill" }), { type: "finish", reason: "tool_calls" } as ProviderEvent];
    const { result } = await run([loop(), loop(), loop()]);
    expect(result.status).toBe("failed");
    expect(result.errorCode).toBe("MAX_STEPS");
  });
});
