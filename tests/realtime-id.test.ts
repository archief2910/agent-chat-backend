import { describe, expect, it } from "vitest";
import { realtimeSubscriptionId } from "@/server/realtime-id";

describe("realtime subscription id", () => {
  it("drops the attempt suffix Trigger.dev appends to a run id", () => {
    expect(realtimeSubscriptionId("run_06giltbqsaibs76v6cn8197s01.1")).toBe("run_06giltbqsaibs76v6cn8197s01");
    expect(realtimeSubscriptionId("run_06giltbqsaibs76v6cn8197s01")).toBe("run_06giltbqsaibs76v6cn8197s01");
  });
});
