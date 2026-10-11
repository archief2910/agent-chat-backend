import { Prisma } from "@/generated/prisma/client";
import type { Tx } from "@/lib/db";
import { AppError } from "@/lib/errors";

/** Magica documents microcredits as credits × 1_000_000. */
export const MICROCREDITS_PER_CREDIT = 1_000_000n;

export function formatCredits(microcredits: bigint): string {
  const negative = microcredits < 0n;
  const absolute = negative ? -microcredits : microcredits;
  const whole = absolute / MICROCREDITS_PER_CREDIT;
  const fraction = (absolute % MICROCREDITS_PER_CREDIT).toString().padStart(6, "0").replace(/0+$/, "");
  const text = fraction.length > 0 ? `${whole.toString()}.${fraction}` : whole.toString();
  return negative ? `-${text}` : text;
}

export function toMicrocredits(value: number): bigint {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new AppError({
      code: "UPSTREAM_CONTRACT",
      status: 502,
      message: "The provider returned a credit amount this app cannot settle.",
      retryable: false,
    });
  }
  return BigInt(value);
}

async function lockedUser(tx: Tx, userId: string) {
  const rows = await tx.$queryRaw<Array<{ creditBalance: bigint | string }>>(
    Prisma.sql`SELECT "creditBalance" FROM "User" WHERE "id" = ${userId} FOR UPDATE`,
  );
  const row = rows[0];
  if (!row) {
    throw new AppError({ code: "NOT_FOUND", status: 404, message: "Account not found." });
  }
  return typeof row.creditBalance === "bigint" ? row.creditBalance : BigInt(row.creditBalance);
}

export async function grantInitialCredits(tx: Tx, userId: string, amount: bigint): Promise<void> {
  const key = `grant:${userId}`;
  const existing = await tx.creditLedger.findUnique({ where: { idempotencyKey: key } });
  if (existing) return;
  const balance = await lockedUser(tx, userId);
  const next = balance + amount;
  await tx.user.update({ where: { id: userId }, data: { creditBalance: next } });
  await tx.creditLedger.create({
    data: {
      userId,
      type: "grant",
      amount,
      balanceAfter: next,
      idempotencyKey: key,
    },
  });
}

export async function holdCredits(
  tx: Tx,
  input: { userId: string; runId: string; amount: bigint; idempotencyKey: string; toolInvocationId?: string },
): Promise<void> {
  const existing = await tx.creditLedger.findUnique({ where: { idempotencyKey: input.idempotencyKey } });
  if (existing || input.amount === 0n) return;
  const balance = await lockedUser(tx, input.userId);
  if (balance < input.amount) {
    throw new AppError({
      code: "INSUFFICIENT_CREDITS",
      status: 402,
      message: "You do not have enough credits for this turn.",
      retryable: false,
    });
  }
  const next = balance - input.amount;
  await tx.user.update({ where: { id: input.userId }, data: { creditBalance: next } });
  await tx.agentRun.update({
    where: { id: input.runId },
    data: { heldMicrocredits: { increment: input.amount } },
  });
  await tx.creditLedger.create({
    data: {
      userId: input.userId,
      runId: input.runId,
      toolInvocationId: input.toolInvocationId,
      type: "hold",
      amount: input.amount,
      balanceAfter: next,
      idempotencyKey: input.idempotencyKey,
    },
  });
}

export async function captureCredits(
  tx: Tx,
  input: { userId: string; runId: string; toolInvocationId?: string; amount: bigint; idempotencyKey: string },
): Promise<void> {
  const existing = await tx.creditLedger.findUnique({ where: { idempotencyKey: input.idempotencyKey } });
  if (existing) return;
  const run = await tx.agentRun.findUnique({ where: { id: input.runId } });
  if (!run) throw new AppError({ code: "NOT_FOUND", status: 404, message: "Run not found." });
  const nextCharged = run.chargedMicrocredits + input.amount;
  if (nextCharged > run.heldMicrocredits) {
    const extra = nextCharged - run.heldMicrocredits;
    await holdCredits(tx, {
      userId: input.userId,
      runId: input.runId,
      amount: extra,
      idempotencyKey: `hold-extra:${input.idempotencyKey}`,
      ...(input.toolInvocationId ? { toolInvocationId: input.toolInvocationId } : {}),
    });
  }
  const balance = await lockedUser(tx, input.userId);
  await tx.agentRun.update({
    where: { id: input.runId },
    data: { chargedMicrocredits: { increment: input.amount } },
  });
  await tx.creditLedger.create({
    data: {
      userId: input.userId,
      runId: input.runId,
      toolInvocationId: input.toolInvocationId,
      type: "capture",
      amount: input.amount,
      balanceAfter: balance,
      idempotencyKey: input.idempotencyKey,
    },
  });
}

export async function holdDirectCredits(
  tx: Tx,
  input: { userId: string; directToolRunId: string; amount: bigint },
): Promise<void> {
  const key = `hold:direct:${input.directToolRunId}`;
  const existing = await tx.creditLedger.findUnique({ where: { idempotencyKey: key } });
  if (existing || input.amount === 0n) return;
  const balance = await lockedUser(tx, input.userId);
  if (balance < input.amount) {
    throw new AppError({
      code: "INSUFFICIENT_CREDITS",
      status: 402,
      message: "You do not have enough credits for this tool.",
      retryable: false,
    });
  }
  const next = balance - input.amount;
  await tx.user.update({ where: { id: input.userId }, data: { creditBalance: next } });
  await tx.directToolRun.update({
    where: { id: input.directToolRunId },
    data: { estimatedMicrocredits: input.amount },
  });
  await tx.creditLedger.create({
    data: {
      userId: input.userId,
      directToolRunId: input.directToolRunId,
      type: "hold",
      amount: input.amount,
      balanceAfter: next,
      idempotencyKey: key,
    },
  });
}

/** Captures the actual charge once and releases any unused hold. */
export async function settleDirectCredits(
  tx: Tx,
  input: { userId: string; directToolRunId: string; charged: bigint },
): Promise<void> {
  const captureKey = `capture:direct:${input.directToolRunId}`;
  if (await tx.creditLedger.findUnique({ where: { idempotencyKey: captureKey } })) return;
  const run = await tx.directToolRun.findUnique({ where: { id: input.directToolRunId } });
  if (!run) return;
  let balance = await lockedUser(tx, input.userId);
  const extra = input.charged - run.estimatedMicrocredits;
  if (extra > 0n) {
    if (balance < extra) {
      throw new AppError({
        code: "INSUFFICIENT_CREDITS",
        status: 402,
        message: "You do not have enough credits to finish this tool.",
        retryable: false,
      });
    }
    balance -= extra;
    await tx.user.update({ where: { id: input.userId }, data: { creditBalance: balance } });
    await tx.creditLedger.create({
      data: {
        userId: input.userId,
        directToolRunId: input.directToolRunId,
        type: "hold",
        amount: extra,
        balanceAfter: balance,
        idempotencyKey: `hold-extra:direct:${input.directToolRunId}`,
      },
    });
  }
  await tx.creditLedger.create({
    data: {
      userId: input.userId,
      directToolRunId: input.directToolRunId,
      type: "capture",
      amount: input.charged,
      balanceAfter: balance,
      idempotencyKey: captureKey,
    },
  });
  const releasable = run.estimatedMicrocredits + (extra > 0n ? extra : 0n) - input.charged;
  if (releasable > 0n) {
    balance += releasable;
    await tx.user.update({ where: { id: input.userId }, data: { creditBalance: balance } });
  }
  await tx.creditLedger.create({
    data: {
      userId: input.userId,
      directToolRunId: input.directToolRunId,
      type: "release",
      amount: releasable > 0n ? releasable : 0n,
      balanceAfter: balance,
      idempotencyKey: `release:direct:${input.directToolRunId}`,
    },
  });
  await tx.directToolRun.update({
    where: { id: input.directToolRunId },
    data: { chargedMicrocredits: input.charged },
  });
}

export async function releaseRemainingHold(tx: Tx, input: { userId: string; runId: string }): Promise<void> {
  const key = `release:${input.runId}`;
  const existing = await tx.creditLedger.findUnique({ where: { idempotencyKey: key } });
  if (existing) return;
  const run = await tx.agentRun.findUnique({ where: { id: input.runId } });
  if (!run) return;
  const releasable = run.heldMicrocredits - run.chargedMicrocredits;
  const balance = await lockedUser(tx, input.userId);
  const next = balance + (releasable > 0n ? releasable : 0n);
  if (releasable > 0n) {
    await tx.user.update({ where: { id: input.userId }, data: { creditBalance: next } });
  }
  await tx.creditLedger.create({
    data: {
      userId: input.userId,
      runId: input.runId,
      type: "release",
      amount: releasable > 0n ? releasable : 0n,
      balanceAfter: next,
      idempotencyKey: key,
    },
  });
}
