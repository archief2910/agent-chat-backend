import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { Prisma } from "@/generated/prisma/client";
import type { Db } from "@/lib/db";
import { getEnv } from "@/lib/env";
import { AppError } from "@/lib/errors";
import { logger } from "@/lib/logger";

export const WEBHOOK_EVENTS = ["agent.started", "agent.completed", "agent.failed", "tool.completed"] as const;
export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number];

const SECRET_PREFIX = "whsec_";
const REPLAY_WINDOW_SECONDS = 5 * 60;
const MAX_ATTEMPTS = 5;
const STUCK_SENDING_MS = 2 * 60_000;

/** Exponential backoff with jitter. Attempt 1 waits about 1s, then 2s, 4s, and 8s, capped at 5 minutes. */
export function webhookBackoffMs(attempt: number, random: () => number = Math.random): number {
  const base = Math.min(5 * 60_000, 1_000 * 2 ** Math.max(0, attempt - 1));
  return Math.max(1, Math.round(base * (0.5 + random() * 0.5)));
}

export function createWebhookSecret(): string {
  return `${SECRET_PREFIX}${randomBytes(24).toString("base64")}`;
}

export function signWebhook(secret: string, id: string, timestamp: number, body: string): string {
  const key = Buffer.from(secret.startsWith(SECRET_PREFIX) ? secret.slice(SECRET_PREFIX.length) : secret, "base64");
  const digest = createHmac("sha256", key).update(`${id}.${timestamp}.${body}`).digest("base64");
  return `v1,${digest}`;
}

export function verifyWebhookSignature(
  secret: string,
  id: string,
  timestamp: number,
  body: string,
  header: string,
  now = Math.floor(Date.now() / 1000),
): boolean {
  if (Math.abs(now - timestamp) > REPLAY_WINDOW_SECONDS) return false;
  const expected = signWebhook(secret, id, timestamp, body);
  const provided = header.split(" ").find((part) => part.startsWith("v1,")) ?? "";
  const a = Buffer.from(expected);
  const b = Buffer.from(provided);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function sanitizeWebhookData(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitizeWebhookData);
  if (!value || typeof value !== "object") return value;
  const output: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (/authorization|api[_-]?key|secret|token|password/i.test(key)) continue;
    output[key] = sanitizeWebhookData(child);
  }
  return output;
}

export async function enqueueWebhook(
  prisma: Db,
  input: { userId: string; type: WebhookEvent; eventId: string; data: Record<string, unknown> },
): Promise<void> {
  const endpoints = await prisma.webhookEndpoint.findMany({
    where: { userId: input.userId, disabledAt: null },
    select: { id: true },
  });
  const payload = {
    id: input.eventId,
    type: input.type,
    createdAt: new Date().toISOString(),
    data: sanitizeWebhookData(input.data),
  };
  for (const endpoint of endpoints) {
    await prisma.webhookDelivery.upsert({
      where: { endpointId_eventId: { endpointId: endpoint.id, eventId: input.eventId } },
      create: { endpointId: endpoint.id, eventId: input.eventId, type: input.type, payload: payload as Prisma.InputJsonValue },
      update: {},
    });
  }
  if (endpoints.length === 0) return;
  try {
    const { tasks } = await import("@trigger.dev/sdk");
    await tasks.trigger("deliver-webhooks", { userId: input.userId }, { idempotencyKey: input.eventId, idempotencyKeyTTL: "1h" });
  } catch (error) {
    logger.warn({ err: error, eventId: input.eventId }, "webhook delivery was queued for the reconciler");
  }
}

export async function deliverPendingWebhooks(
  prisma: Db,
  fetchImpl: typeof fetch = fetch,
  limit = 20,
  now = new Date(),
  random: () => number = Math.random,
): Promise<number> {
  await prisma.webhookDelivery.updateMany({
    where: { status: "sending", updatedAt: { lt: new Date(now.getTime() - STUCK_SENDING_MS) } },
    data: { status: "pending" },
  });
  const pending = await prisma.webhookDelivery.findMany({
    where: {
      status: "pending",
      attempts: { lt: MAX_ATTEMPTS },
      OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }],
    },
    include: { endpoint: true },
    orderBy: { createdAt: "asc" },
    take: limit,
  });
  let delivered = 0;
  for (const delivery of pending) {
    const claimed = await prisma.webhookDelivery.updateMany({
      where: { id: delivery.id, status: "pending" },
      data: { status: "sending", attempts: { increment: 1 } },
    });
    if (claimed.count === 0 || delivery.endpoint.disabledAt) continue;
    const body = JSON.stringify(delivery.payload);
    const timestamp = Math.floor(now.getTime() / 1000);
    const signature = signWebhook(delivery.endpoint.secret, delivery.eventId, timestamp, body);
    try {
      const response = await fetchImpl(delivery.endpoint.url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "webhook-id": delivery.eventId,
          "webhook-timestamp": String(timestamp),
          "webhook-signature": signature,
        },
        body,
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) throw new Error(`Webhook endpoint returned ${response.status}`);
      await prisma.webhookDelivery.update({
        where: { id: delivery.id },
        data: { status: "delivered", lastError: null, nextAttemptAt: null },
      });
      delivered += 1;
    } catch (error) {
      const attempts = delivery.attempts + 1;
      const giveUp = attempts >= MAX_ATTEMPTS;
      await prisma.webhookDelivery.update({
        where: { id: delivery.id },
        data: {
          status: giveUp ? "failed" : "pending",
          lastError: "The endpoint did not accept the event.",
          nextAttemptAt: giveUp ? null : new Date(now.getTime() + webhookBackoffMs(attempts, random)),
        },
      });
      logger.warn({ err: error, deliveryId: delivery.id }, "webhook delivery failed");
    }
  }
  return delivered;
}

export function assertWebhookUrl(url: string): void {
  const parsed = new URL(url);
  if (getEnv().NODE_ENV === "production" && parsed.protocol !== "https:") {
    throw new AppError({ code: "VALIDATION_ERROR", status: 400, message: "Webhook URLs must use https." });
  }
}
