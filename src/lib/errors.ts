import { logger } from "@/lib/logger";

export type ErrorBody = {
  error: {
    code: string;
    message: string;
    retryable: boolean;
    traceId: string;
    details?: unknown;
  };
};

export class AppError extends Error {
  readonly code: string;
  readonly status: number;
  readonly retryable: boolean;
  readonly details?: unknown;

  constructor(init: {
    code: string;
    status: number;
    message: string;
    retryable?: boolean;
    details?: unknown;
    cause?: unknown;
  }) {
    super(init.message, init.cause === undefined ? undefined : { cause: init.cause });
    this.name = "AppError";
    this.code = init.code;
    this.status = init.status;
    this.retryable = init.retryable ?? false;
    if (init.details !== undefined) this.details = init.details;
  }
}

type Normalized =
  | {
      code: string;
      status: number;
      message: string;
      retryable: boolean;
      details?: unknown;
      log: unknown;
    };

type ZodIssue = { path: PropertyKey[]; message: string };

function isZodError(error: unknown): error is { name: string; issues: ZodIssue[] } {
  if (!error || typeof error !== "object") return false;
  const candidate = error as { name?: unknown; issues?: unknown };
  return candidate.name === "ZodError" && Array.isArray(candidate.issues);
}

function isPrismaKnown(error: unknown): error is { code: string; meta?: unknown } {
  if (!error || typeof error !== "object") return false;
  const candidate = error as { code?: unknown; clientVersion?: unknown };
  return typeof candidate.code === "string" && typeof candidate.clientVersion === "string";
}

export function normalizeError(error: unknown): Normalized {
  if (error instanceof AppError) {
    return {
      code: error.code,
      status: error.status,
      message: error.message,
      retryable: error.retryable,
      ...(error.details === undefined ? {} : { details: error.details }),
      log: error,
    };
  }

  if (isZodError(error)) {
    return {
      code: "VALIDATION_ERROR",
      status: 400,
      message: "Some fields need to be corrected.",
      retryable: false,
      details: error.issues.map((issue) => ({
        path: issue.path.map(String),
        message: issue.message,
      })),
      log: error,
    };
  }

  if (isPrismaKnown(error)) {
    if (error.code === "P2002") {
      return {
        code: "CONFLICT",
        status: 409,
        message: "This request conflicts with an existing record.",
        retryable: false,
        log: error,
      };
    }
    if (error.code === "P2025") {
      return {
        code: "NOT_FOUND",
        status: 404,
        message: "The requested record was not found.",
        retryable: false,
        log: error,
      };
    }
  }

  return {
    code: "INTERNAL",
    status: 500,
    message: "Something went wrong. Try again, and include the request id if it continues.",
    retryable: true,
    log: error,
  };
}

export function errorResponse(error: unknown, traceId: string): Response {
  const normalized = normalizeError(error);
  const level = normalized.status >= 500 ? "error" : "warn";
  logger[level]({ err: normalized.log, code: normalized.code, status: normalized.status }, normalized.message);
  const body: ErrorBody = {
    error: {
      code: normalized.code,
      message: normalized.message,
      retryable: normalized.retryable,
      traceId,
      ...(normalized.details === undefined ? {} : { details: normalized.details }),
    },
  };
  return Response.json(body, {
    status: normalized.status,
    headers: {
      "x-request-id": traceId,
      "cache-control": "no-store",
    },
  });
}
