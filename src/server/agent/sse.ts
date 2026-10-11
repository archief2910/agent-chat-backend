import type { ProviderEvent } from "@/server/agent/types";
import { ProviderError } from "@/server/agent/types";

type ToolAcc = { id: string; name: string; arguments: string };
type Acc = { tools: Map<number, ToolAcc>; finishEmitted: boolean; routedModel: string | null };

export function createSseAccumulator(): Acc {
  return { tools: new Map(), finishEmitted: false, routedModel: null };
}

export function parseSseBuffer(buffer: string): { frames: unknown[]; rest: string; done: boolean } {
  const normalized = buffer.replace(/\r\n/g, "\n");
  const parts = normalized.split("\n\n");
  const rest = parts.pop() ?? "";
  const frames: unknown[] = [];
  let done = false;
  for (const part of parts) {
    const data = part
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n");
    if (!data) continue;
    if (data === "[DONE]") {
      done = true;
      continue;
    }
    try {
      frames.push(JSON.parse(data) as unknown);
    } catch {
      throw new ProviderError(502, true, "The free model returned a malformed stream.");
    }
  }
  return { frames, rest, done };
}

export function reduceOpenRouterFrame(acc: Acc, frame: unknown): ProviderEvent[] {
  if (!frame || typeof frame !== "object") return [];
  const record = frame as Record<string, unknown>;
  if (record.error) {
    const message = typeof record.error === "object" && record.error && "message" in record.error ? String((record.error as { message: unknown }).message) : "The free model failed.";
    throw new ProviderError(502, true, message.slice(0, 300));
  }
  const events: ProviderEvent[] = [];
  if (typeof record.model === "string" && record.model.length > 0) acc.routedModel = record.model;
  const choice = Array.isArray(record.choices) ? record.choices[0] : undefined;
  const choiceRecord = choice && typeof choice === "object" ? (choice as Record<string, unknown>) : undefined;
  const delta = choiceRecord?.delta && typeof choiceRecord.delta === "object" ? (choiceRecord.delta as Record<string, unknown>) : undefined;
  const content = typeof delta?.content === "string" ? delta.content : "";
  if (content.length > 0) events.push({ type: "text", delta: content });
  const reasoning = typeof delta?.reasoning === "string" ? delta.reasoning : typeof delta?.reasoning_content === "string" ? delta.reasoning_content : "";
  if (reasoning.length > 0) events.push({ type: "thinking", delta: reasoning });
  if (Array.isArray(delta?.tool_calls)) {
    for (const call of delta.tool_calls) {
      if (!call || typeof call !== "object") continue;
      const item = call as { index?: unknown; id?: unknown; function?: { name?: unknown; arguments?: unknown } };
      const index = typeof item.index === "number" ? item.index : acc.tools.size;
      const current = acc.tools.get(index) ?? { id: "", name: "", arguments: "" };
      if (typeof item.id === "string") current.id = item.id;
      if (typeof item.function?.name === "string") current.name += item.function.name;
      if (typeof item.function?.arguments === "string") current.arguments += item.function.arguments;
      acc.tools.set(index, current);
    }
  }
  const usage = record.usage && typeof record.usage === "object" ? (record.usage as Record<string, unknown>) : undefined;
  if (usage && typeof usage.prompt_tokens === "number" && typeof usage.completion_tokens === "number") {
    events.push({
      type: "usage",
      promptTokens: usage.prompt_tokens,
      completionTokens: usage.completion_tokens,
      routedModel: acc.routedModel,
    });
  }
  const finish = choiceRecord?.finish_reason;
  if (typeof finish === "string" && finish.length > 0 && !acc.finishEmitted) {
    acc.finishEmitted = true;
    for (const tool of [...acc.tools.entries()].sort((a, b) => a[0] - b[0]).map((entry) => entry[1])) {
      let parsed: unknown = null;
      let invalid = false;
      try {
        parsed = tool.arguments.length > 0 ? (JSON.parse(tool.arguments) as unknown) : {};
      } catch {
        invalid = true;
      }
      events.push({
        type: "tool_call",
        id: tool.id || `tool_${tool.name}`,
        name: tool.name,
        arguments: parsed,
        raw: tool.arguments,
        invalid,
      });
    }
    events.push({ type: "finish", reason: finish });
  }
  return events;
}
