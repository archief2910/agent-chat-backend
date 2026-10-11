import { getEnv } from "@/lib/env";
import { getPrisma } from "@/lib/db";
import { grantInitialCredits } from "@/server/credits";
import { AppError } from "@/lib/errors";

export async function upsertUser(clerkUserId: string) {
  const prisma = getPrisma();
  const existing = await prisma.user.findUnique({ where: { clerkUserId } });
  if (existing) return existing;
  const amount = BigInt(getEnv().INITIAL_CREDIT_MICROCREDITS);
  try {
    return await prisma.$transaction(async (tx) => {
      const winner = await tx.user.findUnique({ where: { clerkUserId } });
      if (winner) return winner;
      const created = await tx.user.create({ data: { clerkUserId, creditBalance: 0n } });
      await grantInitialCredits(tx, created.id, amount);
      return tx.user.findUniqueOrThrow({ where: { id: created.id } });
    });
  } catch (error) {
    const again = await prisma.user.findUnique({ where: { clerkUserId } });
    if (again) return again;
    throw error;
  }
}

export function notFound(message: string): AppError {
  return new AppError({ code: "NOT_FOUND", status: 404, message });
}
