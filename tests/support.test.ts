import { describe, expect, it } from "vitest";
import { formatCredits } from "@/server/credits";
import { planReconciliation } from "@/server/reconcile";
import { encodeCursor, decodeCursor } from "@/server/pagination";
import { buildSystemPrompt, fitTranscript } from "@/server/agent/prompt";

describe("credits and cursors", () => {
  it("formats microcredits using the documented 1_000_000 scale", () => {
    expect(formatCredits(5_000n)).toBe("0.005");
    expect(formatCredits(10_000_000n)).toBe("10");
    expect(formatCredits(273_936n)).toBe("0.273936");
  });

  it("round-trips a cursor", () => {
    const at = new Date("2026-10-10T12:00:00.000Z");
    const cursor = encodeCursor(at, "msg_1");
    expect(decodeCursor(cursor)).toEqual({ at, id: "msg_1" });
  });

  it("dispatches only stale queued runs and clears terminal locks", () => {
    const now = new Date("2026-10-10T12:00:30.000Z");
    const plan = planReconciliation({
      now,
      staleQueuedMs: 15_000,
      queued: [
        { id: "old", createdAt: new Date("2026-10-10T12:00:00.000Z"), triggerRunId: null, status: "queued" },
        { id: "fresh", createdAt: new Date("2026-10-10T12:00:20.000Z"), triggerRunId: null, status: "queued" },
        { id: "sent", createdAt: new Date("2026-10-10T12:00:00.000Z"), triggerRunId: "trg", status: "queued" },
      ],
      locks: [
        { chatId: "chat_done", runStatus: "completed" },
        { chatId: "chat_live", runStatus: "thinking" },
      ],
    });
    expect(plan.dispatchRunIds).toEqual(["old"]);
    expect(plan.clearLockChatIds).toEqual(["chat_done"]);
  });

  it("keeps a thousand queued runs as a thousand separate dispatches", () => {
    const queued = Array.from({ length: 1_000 }, (_, index) => ({
      id: `run_${index}`,
      createdAt: new Date(0),
      triggerRunId: null,
      status: "queued" as const,
    }));
    const plan = planReconciliation({ now: new Date(60_000), staleQueuedMs: 15_000, queued, locks: [] });
    expect(new Set(plan.dispatchRunIds).size).toBe(1_000);
  });

  it("puts skill descriptions in the prompt and keeps bodies out", () => {
    const prompt = buildSystemPrompt([{ name: "image-cropping", description: "How to crop." }]);
    expect(prompt).toContain("image-cropping: How to crop.");
    expect(prompt).not.toContain("Do not mix the three forms");
  });

  it("drops a leading tool message that lost its assistant call", () => {
    const selected = fitTranscript("system", [
      { role: "tool", tool_call_id: "call_1" },
      { role: "user" },
    ], 10_000);
    expect(selected.map((message) => message.role)).toEqual(["user"]);
  });
});
