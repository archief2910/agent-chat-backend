import { describe, expect, it } from "vitest";
import { createSseAccumulator, parseSseBuffer, reduceOpenRouterFrame } from "@/server/agent/sse";
import { buildOpenRouterBody } from "@/server/agent/types";

const stream = [
  `data: ${JSON.stringify({ model: "deepseek/deepseek-chat:free", choices: [{ index: 0, delta: { content: "Hello" } }] })}`,
  "",
  `data: ${JSON.stringify({ model: "deepseek/deepseek-chat:free", choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "crop_image", arguments: "" } }] } }] })}`,
  "",
  `data: ${JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: "{\"image_url\":\"https://cdn.example/a.png\"}" } }] }, finish_reason: "tool_calls" }] })}`,
  "",
  `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "", role: "assistant" }, finish_reason: "tool_calls" }], usage: { prompt_tokens: 12, completion_tokens: 4 } })}`,
  "",
  "data: [DONE]",
  "",
].join("\n");

describe("openrouter stream", () => {
  it("builds a body that cannot select a paid fallback", () => {
    const body = buildOpenRouterBody({ messages: [{ role: "user", content: "hi" }], tools: [] });
    expect(body.model).toBe("openrouter/free");
    expect(body).not.toHaveProperty("models");
  });

  it("emits text once, assembles tool calls, and treats the usage frame as accounting", () => {
    const parsed = parseSseBuffer(stream);
    const acc = createSseAccumulator();
    const events = parsed.frames.flatMap((frame) => reduceOpenRouterFrame(acc, frame));
    expect(events.filter((event) => event.type === "text").map((event) => event.type === "text" && event.delta)).toEqual(["Hello"]);
    const tool = events.find((event) => event.type === "tool_call");
    expect(tool).toMatchObject({ id: "call_1", name: "crop_image", invalid: false, arguments: { image_url: "https://cdn.example/a.png" } });
    expect(events.filter((event) => event.type === "finish")).toHaveLength(1);
    expect(events).toContainEqual({ type: "usage", promptTokens: 12, completionTokens: 4, routedModel: "deepseek/deepseek-chat:free" });
  });

  it("marks malformed tool arguments invalid", () => {
    const acc = createSseAccumulator();
    const events = reduceOpenRouterFrame(acc, {
      choices: [{ delta: { tool_calls: [{ index: 0, id: "call_2", function: { name: "crop_image", arguments: "{" } }] }, finish_reason: "tool_calls" }],
    });
    expect(events.find((event) => event.type === "tool_call")).toMatchObject({ invalid: true });
  });
});
