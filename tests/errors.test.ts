import { describe, expect, it } from "vitest";
import { AppError, normalizeError } from "@/lib/errors";
import { z } from "zod";

describe("normalizeError", () => {
  it("returns the app error code and does not replace its message", () => {
    const normalized = normalizeError(new AppError({ code: "RUN_ACTIVE", status: 409, message: "This chat already has an active run.", details: { runId: "run_1" } }));
    expect(normalized.status).toBe(409);
    expect(normalized.code).toBe("RUN_ACTIVE");
    expect(normalized.details).toEqual({ runId: "run_1" });
  });

  it("hides unexpected errors behind a safe message", () => {
    const normalized = normalizeError(new Error("password=secret"));
    expect(normalized.status).toBe(500);
    expect(normalized.message).not.toContain("secret");
  });

  it("maps zod issues to field details", () => {
    const parsed = z.object({ text: z.string().min(1) }).safeParse({ text: "" });
    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    const normalized = normalizeError(parsed.error);
    expect(normalized.code).toBe("VALIDATION_ERROR");
    expect(normalized.details).toEqual([{ path: ["text"], message: expect.any(String) }]);
  });
});
