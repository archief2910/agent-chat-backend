import { describe, expect, it } from "vitest";
import { createWebhookSecret, sanitizeWebhookData, signWebhook, verifyWebhookSignature, webhookBackoffMs } from "@/server/webhooks";

describe("outbound webhooks", () => {
  it("signs and verifies the raw body", () => {
    const secret = createWebhookSecret();
    const body = JSON.stringify({ id: "agent.completed:run_1", type: "agent.completed" });
    const signature = signWebhook(secret, "agent.completed:run_1", 1_700_000_000, body);
    expect(signature.startsWith("v1,")).toBe(true);
    expect(verifyWebhookSignature(secret, "agent.completed:run_1", 1_700_000_000, body, signature, 1_700_000_000)).toBe(true);
    expect(verifyWebhookSignature(secret, "agent.completed:run_1", 1_700_000_000, `${body} `, signature, 1_700_000_000)).toBe(false);
    expect(verifyWebhookSignature(secret, "agent.completed:run_1", 1_700_000_000, body, signature, 1_700_000_000 + 6 * 60)).toBe(false);
  });

  it("waits longer on each webhook retry, with jitter", () => {
    expect(webhookBackoffMs(1, () => 0)).toBe(500);
    expect(webhookBackoffMs(2, () => 0)).toBe(1_000);
    expect(webhookBackoffMs(4, () => 0.999)).toBeLessThanOrEqual(8_000);
    expect(webhookBackoffMs(4, () => 0.999)).toBeGreaterThan(4_000);
  });

  it("drops secrets from event data", () => {
    expect(sanitizeWebhookData({ runId: "run_1", apiKey: "gx_secret", nested: { authorization: "Bearer x" } })).toEqual({
      runId: "run_1",
      nested: {},
    });
  });
});
