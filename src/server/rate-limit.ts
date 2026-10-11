import { Prisma } from "@/generated/prisma/client";
import type { Tx } from "@/lib/db";
import { AppError } from "@/lib/errors";

export async function consumeRateLimit(
  tx: Tx,
  input: { userId: string; key: string; limit: number; now: Date },
): Promise<void> {
  const windowStart = new Date(Math.floor(input.now.getTime() / 60_000) * 60_000);
  const rows = await tx.$queryRaw<Array<{ count: number }>>(Prisma.sql`
    INSERT INTO "RateLimitBucket" ("id", "key", "windowStart", "count", "userId")
    VALUES (${crypto.randomUUID()}, ${input.key}, ${windowStart}, 1, ${input.userId})
    ON CONFLICT ("key", "windowStart")
    DO UPDATE SET "count" = "RateLimitBucket"."count" + 1
    RETURNING "count"
  `);
  const count = rows[0]?.count ?? 1;
  if (count > input.limit) {
    throw new AppError({
      code: "RATE_LIMITED",
      status: 429,
      message: "Too many messages. Wait a minute and try again.",
      retryable: true,
      details: { retryAfterSeconds: 60 },
    });
  }
}
