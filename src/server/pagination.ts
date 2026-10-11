import { cursorPageSchema } from "@/contracts";
import { AppError } from "@/lib/errors";

export const DEFAULT_PAGE_SIZE = 30;

export function pageLimit(value: number | undefined): number {
  return value ?? DEFAULT_PAGE_SIZE;
}

export function encodeCursor(at: Date, id: string): string {
  return Buffer.from(JSON.stringify({ at: at.toISOString(), id }), "utf8").toString("base64url");
}

export function decodeCursor(cursor: string): { at: Date; id: string } {
  try {
    const json = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as unknown;
    const parsed = cursorPageSchema.parse(json);
    const at = new Date(parsed.at);
    if (Number.isNaN(at.getTime())) throw new Error("invalid date");
    return { at, id: parsed.id };
  } catch {
    throw new AppError({
      code: "VALIDATION_ERROR",
      status: 400,
      message: "The page cursor is invalid.",
    });
  }
}

export function olderThan<T extends { id: string }>(
  cursor: { at: Date; id: string } | undefined,
  field: "createdAt" | "lastMessageAt",
): { OR: Array<Record<string, unknown>> } | undefined {
  if (!cursor) return undefined;
  return {
    OR: [{ [field]: { lt: cursor.at } }, { [field]: cursor.at, id: { lt: cursor.id } }],
  };
}
