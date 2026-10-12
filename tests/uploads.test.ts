import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { monthKey, parseAssemblyStatus, signParams, validateDeclaredFiles, verifyNotification } from "@/server/uploads/transloadit";

const limits = { maxFileBytes: 500_000_000, maxFiles: 8 };

describe("transloadit", () => {
  it("signs params with a sha384 prefix over the exact string", () => {
    const params = '{"auth":{"key":"k","expires":"2026-10-10T12:00:00Z"}}';
    const expected = createHmac("sha384", "secret").update(params).digest("hex");
    expect(signParams(params, "secret")).toBe(`sha384:${expected}`);
  });

  it("verifies notifications over the raw field and rejects tampering", () => {
    const raw = '{"assembly_id":"abc","ok":"ASSEMBLY_COMPLETED"}';
    const signature = createHmac("sha1", "secret").update(raw).digest("hex");
    expect(verifyNotification(raw, signature, "secret")).toBe(true);
    expect(verifyNotification(raw.replace("abc", "abd"), signature, "secret")).toBe(false);
    expect(verifyNotification(raw, signature, "other")).toBe(false);
    expect(verifyNotification(raw, "md5:zz", "secret")).toBe(false);
  });

  it("enforces media types, the per-file cap, and the file count", () => {
    expect(() => validateDeclaredFiles([{ name: "a.png", size: 10, mime: "image/png" }], limits)).not.toThrow();
    expect(() => validateDeclaredFiles([{ name: "a.pdf", size: 10, mime: "application/pdf" }], limits)).toThrow(/only images, video, and audio/);
    expect(() => validateDeclaredFiles([{ name: "a.mp4", size: 500_000_001, mime: "video/mp4" }], limits)).toThrow(/500 MB/);
    const many = Array.from({ length: 9 }, (_, index) => ({ name: `${index}.png`, size: 1, mime: "image/png" }));
    expect(() => validateDeclaredFiles(many, limits)).toThrow(/at most 8/);
  });

  it("buckets usage by UTC month and parses partial statuses", () => {
    expect(monthKey(new Date("2026-10-31T23:59:59.000Z"))).toBe("2026-10");
    const status = parseAssemblyStatus({ assembly_id: "abc", ok: "ASSEMBLY_UPLOADING", extra: 1 });
    expect(status.ok).toBe("ASSEMBLY_UPLOADING");
    expect(() => parseAssemblyStatus({ ok: "ASSEMBLY_COMPLETED" })).toThrow();
  });
});
