import { buildOpenRouterBody } from "@/server/agent/types";
import type { ModelProvider, ProviderEvent, ProviderTool, ModelMessage } from "@/server/agent/types";
import { ProviderError } from "@/server/agent/types";
import { createSseAccumulator, parseSseBuffer, reduceOpenRouterFrame } from "@/server/agent/sse";

export function createOpenRouterProvider(options: {
  apiKey: string;
  baseUrl: string;
  referer: string;
  fetchImpl?: typeof fetch;
}): ModelProvider {
  return {
    async *stream(input): AsyncIterable<ProviderEvent> {
      const body = buildOpenRouterBody({ messages: input.messages, tools: input.tools });
      if (body.model !== "openrouter/free" || "models" in body) {
        throw new ProviderError(500, false, "The configured model route is not openrouter/free.");
      }
      const fetchImpl = options.fetchImpl ?? fetch;
      let response: Response;
      try {
        response = await fetchImpl(`${options.baseUrl}/chat/completions`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${options.apiKey}`,
            "Content-Type": "application/json",
            "HTTP-Referer": options.referer,
            "X-Title": "Agent Chat",
          },
          body: JSON.stringify(body),
          signal: input.signal,
        });
      } catch {
        if (input.signal.aborted) throw new ProviderError(499, false, "The turn was stopped.");
        throw new ProviderError(504, true, "The free model route did not respond.");
      }
      if (response.status === 429) {
        throw new ProviderError(429, true, "The free model route is rate limited. Wait and try again.", retryAfterMs(response));
      }
      if (!response.ok || !response.body) {
        throw new ProviderError(response.status || 502, response.status >= 500, "The free model route is unavailable. There is no paid fallback.");
      }
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      const acc = createSseAccumulator();
      let buffer = "";
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        buffer += decoder.decode(chunk.value, { stream: true });
        const parsed = parseSseBuffer(buffer);
        buffer = parsed.rest;
        for (const frame of parsed.frames) {
          for (const event of reduceOpenRouterFrame(acc, frame)) yield event;
        }
        if (parsed.done) break;
      }
    },
  };
}

function retryAfterMs(response: Response): number | undefined {
  const header = response.headers.get("retry-after");
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
  const at = Date.parse(header);
  if (Number.isFinite(at)) return Math.max(0, at - Date.now());
  return undefined;
}

export type { ModelMessage, ProviderTool };
