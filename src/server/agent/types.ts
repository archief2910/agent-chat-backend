import { z } from "zod";
import type { ContentBlock } from "@/contracts";

export type ToolCallPayload = {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
};

export type ModelMessage =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: ToolCallPayload[] }
  | { role: "tool"; tool_call_id: string; content: string };

export type ProviderTool = {
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
};

export type ProviderEvent =
  | { type: "text"; delta: string }
  | { type: "thinking"; delta: string }
  | { type: "tool_call"; id: string; name: string; arguments: unknown; raw: string; invalid: boolean }
  | { type: "usage"; promptTokens: number; completionTokens: number; routedModel: string | null }
  | { type: "finish"; reason: string };

export class ProviderError extends Error {
  constructor(
    readonly status: number,
    readonly retryable: boolean,
    message: string,
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = "ProviderError";
  }
}

export interface ModelProvider {
  stream(input: {
    messages: ModelMessage[];
    tools: ProviderTool[];
    signal: AbortSignal;
  }): AsyncIterable<ProviderEvent>;
}

export const openRouterBodySchema = z.object({
  model: z.literal("openrouter/free"),
  messages: z.array(z.unknown()),
  stream: z.literal(true),
  tools: z.array(z.unknown()).optional(),
  parallel_tool_calls: z.literal(true),
}).strict();

export function buildOpenRouterBody(input: { messages: ModelMessage[]; tools: ProviderTool[] }) {
  return {
    model: "openrouter/free" as const,
    messages: input.messages,
    stream: true as const,
    parallel_tool_calls: true as const,
    ...(input.tools.length > 0 ? { tools: input.tools } : {}),
  };
}

export function blocksToPlainText(blocks: ContentBlock[]): string {
  return blocks
    .map((block) => {
      if (block.type === "text" || block.type === "thinking") return block.text;
      if (block.type === "tool_use") return `${block.name} ${JSON.stringify(block.input)}`;
      if (block.type === "tool_result") return JSON.stringify(block.output);
      if (block.type === "asset") return block.url;
      if (block.type === "citation") return block.url;
      return "";
    })
    .filter((part) => part.length > 0)
    .join("\n");
}
