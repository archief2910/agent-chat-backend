import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { Prisma } from "@/generated/prisma/client";
import type { Db } from "@/lib/db";
import { AppError } from "@/lib/errors";
import { logger } from "@/lib/logger";
import { notFound } from "@/server/users";

export const ALLOWED_UPLOAD_MIME = /^(image\/(png|jpeg|webp|gif)|video\/(mp4|quicktime|webm)|audio\/(mpeg|mp4|wav|x-wav|ogg|webm))$/;

export type UploadConfig = {
  authKey: string;
  authSecret: string;
  templateId: string;
  notifyUrl: string;
  resultStep?: string;
  monthlyBytes: bigint;
  maxFileBytes: number;
  maxFiles: number;
};

export type DeclaredFile = { name: string; size: number; mime: string };

const SIGNATURE_TTL_MS = 60 * 60 * 1000;

export function monthKey(date: Date): string {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}

export function validateDeclaredFiles(files: DeclaredFile[], config: Pick<UploadConfig, "maxFileBytes" | "maxFiles">) {
  if (files.length > config.maxFiles) {
    throw new AppError({ code: "VALIDATION_ERROR", status: 400, message: `Attach at most ${config.maxFiles} files.` });
  }
  const issues: Array<{ path: string[]; message: string }> = [];
  files.forEach((file, index) => {
    if (!ALLOWED_UPLOAD_MIME.test(file.mime.toLowerCase())) {
      issues.push({ path: ["files", String(index), "mime"], message: `${file.name}: only images, video, and audio are supported.` });
    }
    if (file.size > config.maxFileBytes) {
      issues.push({ path: ["files", String(index), "size"], message: `${file.name}: files are limited to 500 MB.` });
    }
  });
  if (issues.length > 0) {
    throw new AppError({ code: "VALIDATION_ERROR", status: 400, message: issues[0]?.message ?? "Some files are not supported.", details: issues });
  }
}

/** HMAC over the exact params string; new Transloadit Auth Keys default to sha384. */
export function signParams(params: string, secret: string): string {
  return `sha384:${createHmac("sha384", secret).update(params).digest("hex")}`;
}

/** Notifications are signed with HMAC-SHA1 hex over the raw `transloadit` field. */
export function verifyNotification(rawStatus: string, signature: string, secret: string): boolean {
  const provided = signature.includes(":") ? signature.split(":")[1] ?? "" : signature;
  const algorithm = signature.includes(":") ? signature.split(":")[0] ?? "sha1" : "sha1";
  if (!["sha1", "sha256", "sha384"].includes(algorithm) || !/^[a-f0-9]+$/.test(provided)) return false;
  const expected = createHmac(algorithm, secret).update(rawStatus).digest("hex");
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(provided, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function createUpload(
  prisma: Db,
  input: { userId: string; files: DeclaredFile[]; config: UploadConfig; now?: Date },
) {
  validateDeclaredFiles(input.files, input.config);
  const now = input.now ?? new Date();
  const declared = input.files.reduce((sum, file) => sum + BigInt(file.size), 0n);
  const expiresAt = new Date(now.getTime() + SIGNATURE_TTL_MS);
  const upload = await prisma.$transaction(async (tx) => {
    const key = monthKey(now);
    await tx.$executeRaw(Prisma.sql`
      INSERT INTO "UploadUsage" ("id", "monthKey", "bytes") VALUES (${crypto.randomUUID()}, ${key}, 0)
      ON CONFLICT ("monthKey") DO NOTHING
    `);
    const usage = await tx.$queryRaw<Array<{ bytes: bigint | string }>>(
      Prisma.sql`SELECT "bytes" FROM "UploadUsage" WHERE "monthKey" = ${key} FOR UPDATE`,
    );
    const used = BigInt(usage[0]?.bytes ?? 0);
    const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    const pending = await tx.uploadAssembly.aggregate({
      where: { status: "pending", expiresAt: { gt: now }, createdAt: { gte: monthStart } },
      _sum: { declaredBytes: true },
    });
    const reserved = pending._sum.declaredBytes ?? 0n;
    if (used + reserved + declared > input.config.monthlyBytes) {
      throw new AppError({
        code: "UPLOAD_QUOTA_EXCEEDED",
        status: 429,
        message: "The monthly upload allowance is used up. Choose files from your media library or try again next month.",
        retryable: false,
      });
    }
    return tx.uploadAssembly.create({
      data: {
        userId: input.userId,
        declaredBytes: declared,
        fileCount: input.files.length,
        expiresAt,
      },
    });
  });

  const params = JSON.stringify({
    auth: {
      key: input.config.authKey,
      expires: expiresAt.toISOString().replace(/\.\d{3}Z$/, "Z"),
      // The signed ceiling is the app limit. An exact file size is rejected when the
      // uploaded length is even one byte over File.size.
      max_size: input.config.maxFileBytes,
    },
    template_id: input.config.templateId,
    notify_url: input.config.notifyUrl,
    fields: { uploadId: upload.id },
  });
  return {
    uploadId: upload.id,
    params,
    signature: signParams(params, input.config.authSecret),
    expiresAt: expiresAt.toISOString(),
  };
}

const fileSchema = z
  .object({
    id: z.string().optional(),
    original_id: z.string().optional(),
    name: z.string().optional(),
    original_name: z.string().optional(),
    mime: z.string().nullable().optional(),
    size: z.number().nullable().optional(),
    ssl_url: z.string().nullable().optional(),
    url: z.string().nullable().optional(),
    is_temp_url: z.boolean().optional(),
  })
  .loose();

const statusSchema = z
  .object({
    assembly_id: z.string(),
    ok: z.string().optional(),
    error: z.string().optional(),
    message: z.string().optional(),
    fields: z.record(z.string(), z.unknown()).optional(),
    uploads: z.array(fileSchema).optional(),
    results: z.record(z.string(), z.array(fileSchema)).optional(),
  })
  .loose();

export type AssemblyStatus = z.infer<typeof statusSchema>;

export function parseAssemblyStatus(raw: unknown): AssemblyStatus {
  const parsed = statusSchema.safeParse(raw);
  if (!parsed.success) {
    throw new AppError({ code: "UPSTREAM_CONTRACT", status: 502, message: "The upload service returned an unreadable status.", retryable: true });
  }
  return parsed.data;
}

function kindFor(mime: string): "image" | "video" | "audio" | "other" {
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("video/")) return "video";
  if (mime.startsWith("audio/")) return "audio";
  return "other";
}

/** Applies a terminal Assembly status once. Repeated deliveries return the stored state. */
export async function applyAssemblyStatus(
  prisma: Db,
  input: { status: AssemblyStatus; config: Pick<UploadConfig, "resultStep" | "maxFileBytes">; expectedUserId?: string; now?: Date },
) {
  const { status } = input;
  const uploadId = typeof status.fields?.uploadId === "string" ? status.fields.uploadId : null;
  if (!uploadId) throw notFound("Upload not found.");
  const upload = await prisma.uploadAssembly.findUnique({ where: { id: uploadId } });
  if (!upload || (input.expectedUserId && upload.userId !== input.expectedUserId)) throw notFound("Upload not found.");
  if (upload.assemblyId && upload.assemblyId !== status.assembly_id) throw notFound("Upload not found.");
  if (upload.status !== "pending") return { uploadId: upload.id, status: upload.status, duplicate: true };

  if (status.error) {
    await prisma.uploadAssembly.updateMany({
      where: { id: upload.id, status: "pending" },
      data: { status: "failed", assemblyId: status.assembly_id, errorCode: status.error.slice(0, 80), errorMessage: "The upload could not be processed. Try again." },
    });
    return { uploadId: upload.id, status: "failed" as const, duplicate: false };
  }
  if (status.ok === "ASSEMBLY_CANCELED") {
    await prisma.uploadAssembly.updateMany({
      where: { id: upload.id, status: "pending" },
      data: { status: "canceled", assemblyId: status.assembly_id },
    });
    return { uploadId: upload.id, status: "canceled" as const, duplicate: false };
  }
  if (status.ok !== "ASSEMBLY_COMPLETED") {
    return { uploadId: upload.id, status: "pending" as const, duplicate: false };
  }

  const uploads = status.uploads ?? [];
  const results = input.config.resultStep ? status.results?.[input.config.resultStep] ?? [] : [];
  const files = uploads.map((file) => {
    const id = file.id ?? file.original_id ?? "";
    const stored = results.find((result) => result.original_id === id) ?? null;
    const mime = (stored?.mime ?? file.mime ?? "application/octet-stream").toLowerCase();
    const url = stored?.ssl_url ?? stored?.url ?? file.ssl_url ?? file.url ?? null;
    return {
      fileId: id,
      originalName: (file.original_name ?? file.name ?? "file").slice(0, 255),
      mime,
      bytes: typeof file.size === "number" ? BigInt(Math.max(0, Math.floor(file.size))) : null,
      url: url && /^https:\/\//.test(url) ? url : null,
      isTemporaryUrl: stored ? stored.is_temp_url === true : file.is_temp_url !== false,
    };
  });
  const rejected = files.filter((file) => !file.fileId || !ALLOWED_UPLOAD_MIME.test(file.mime) || (file.bytes ?? 0n) > BigInt(input.config.maxFileBytes));
  const actual = files.reduce((sum, file) => sum + (file.bytes ?? 0n), 0n);
  const key = monthKey(input.now ?? new Date());

  await prisma.$transaction(async (tx) => {
    const claimed = await tx.uploadAssembly.updateMany({
      where: { id: upload.id, status: "pending" },
      data: {
        status: rejected.length > 0 ? "failed" : "completed",
        assemblyId: status.assembly_id,
        actualBytes: actual,
        ...(rejected.length > 0
          ? { errorCode: "INVALID_FILE", errorMessage: "One or more files were not a supported image, video, or audio file." }
          : {}),
      },
    });
    if (claimed.count === 0) return;
    await tx.$executeRaw(Prisma.sql`
      INSERT INTO "UploadUsage" ("id", "monthKey", "bytes") VALUES (${crypto.randomUUID()}, ${key}, ${actual})
      ON CONFLICT ("monthKey") DO UPDATE SET "bytes" = "UploadUsage"."bytes" + EXCLUDED."bytes"
    `);
    if (rejected.length > 0) return;
    for (const file of files) {
      await tx.asset.upsert({
        where: { assemblyId_fileId: { assemblyId: status.assembly_id, fileId: file.fileId } },
        create: {
          userId: upload.userId,
          kind: kindFor(file.mime),
          source: "upload",
          mime: file.mime,
          bytes: file.bytes,
          originalName: file.originalName,
          sourceUrl: file.url,
          isTemporaryUrl: file.isTemporaryUrl,
          assemblyId: status.assembly_id,
          fileId: file.fileId,
          uploadId: upload.id,
        },
        update: {},
      });
    }
  });
  const fresh = await prisma.uploadAssembly.findUniqueOrThrow({ where: { id: upload.id } });
  if (fresh.status === "failed") logger.warn({ uploadId: upload.id, assemblyId: status.assembly_id }, "upload rejected after processing");
  return { uploadId: upload.id, status: fresh.status, duplicate: false };
}

export async function fetchAssemblyStatus(assemblyId: string, fetchImpl: typeof fetch = fetch): Promise<AssemblyStatus> {
  let response: Response;
  try {
    response = await fetchImpl(`https://api2.transloadit.com/assemblies/${assemblyId}`, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(15_000),
    });
  } catch (error) {
    throw new AppError({ code: "UPSTREAM_TIMEOUT", status: 504, message: "The upload service did not respond. Try again.", retryable: true, cause: error });
  }
  if (!response.ok) {
    throw new AppError({ code: "UPSTREAM_ERROR", status: 502, message: "The upload status could not be read. Try again.", retryable: true });
  }
  return parseAssemblyStatus(await response.json());
}
