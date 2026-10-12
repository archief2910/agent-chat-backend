import { describe, expect, it } from "vitest";
import { buildUsage, periodRange } from "@/server/usage";

describe("usage summary", () => {
  it("splits the calendar into current, previous, and usage old", () => {
    const now = new Date("2026-10-12T18:00:00.000Z");
    expect(periodRange("current", now).from.toISOString()).toBe("2026-10-01T00:00:00.000Z");
    expect(periodRange("current", now).to.toISOString()).toBe(now.toISOString());
    expect(periodRange("previous", now).from.toISOString()).toBe("2026-09-01T00:00:00.000Z");
    expect(periodRange("previous", now).to.toISOString()).toBe("2026-09-30T23:59:59.999Z");
    expect(periodRange("older", now).to.toISOString()).toBe("2026-08-12T23:59:59.999Z");
  });

  it("groups agent admissions apart from image and crop charges", () => {
    const summary = buildUsage({
      period: "current",
      from: new Date("2026-10-01T00:00:00.000Z"),
      to: new Date("2026-10-12T18:00:00.000Z"),
      runs: [
        {
          id: "run_chat",
          createdAt: new Date("2026-10-11T18:03:10.000Z"),
          captures: [{ amount: 50_000n, toolInvocationId: null, createdAt: new Date("2026-10-11T18:03:10.000Z") }],
        },
      ],
      tools: [
        { id: "tool_image", name: "gpt_image_2", createdAt: new Date("2026-10-11T17:51:57.000Z"), chargedMicrocredits: 3_290_000n },
        { id: "tool_crop", name: "crop_image", createdAt: new Date("2026-10-11T14:19:35.000Z"), chargedMicrocredits: 5_000n },
        { id: "tool_skill", name: "load_skill", createdAt: new Date("2026-10-11T18:03:11.000Z"), chargedMicrocredits: 0n },
      ],
    });

    expect(summary.totals).toEqual({
      debitedMicrocredits: "3345000",
      executions: 3,
      categories: 3,
    });
    expect(summary.categories.map((category) => category.name)).toEqual(["AI Agent Chat", "AI Gpt Image 2", "AI Crop Image"]);
    expect(summary.categories[0]?.rows[0]?.steps[0]?.name).toBe("AI LLM Admission Reservation");
    expect(summary.categories[1]?.debitedMicrocredits).toBe("3290000");
    expect(summary.categories[2]?.debitedMicrocredits).toBe("5000");
  });
});
