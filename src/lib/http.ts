import { z } from "zod";
import { AppError, errorResponse } from "@/lib/errors";
import { logger } from "@/lib/logger";
import { runWithContext } from "@/lib/trace";

export type RouteContext = {
  request: Request;
  params: Record<string, string>;
  traceId: string;
};

type Handler = (context: RouteContext) => Promise<Response>;

const MAX_JSON_BYTES = 64_000;

export function route(handler: Handler) {
  return async (request: Request, context: { params?: Promise<Record<string, string>> }) => {
    const traceId = request.headers.get("x-request-id") ?? crypto.randomUUID();
    const started = Date.now();
    return runWithContext({ traceId }, async () => {
      try {
        const params = context.params ? await context.params : {};
        const response = await handler({ request, params, traceId });
        response.headers.set("x-request-id", traceId);
        logger.info(
          { method: request.method, path: new URL(request.url).pathname, status: response.status, durationMs: Date.now() - started },
          "request",
        );
        return response;
      } catch (error) {
        const response = errorResponse(error, traceId);
        logger.info(
          { method: request.method, path: new URL(request.url).pathname, status: response.status, durationMs: Date.now() - started },
          "request",
        );
        return response;
      }
    });
  };
}

export async function readJson<T>(request: Request, schema: z.ZodType<T>): Promise<T> {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > MAX_JSON_BYTES) {
    throw new AppError({
      code: "PAYLOAD_TOO_LARGE",
      status: 413,
      message: "The request body is too large.",
    });
  }
  const text = await request.text();
  if (text.length > MAX_JSON_BYTES) {
    throw new AppError({
      code: "PAYLOAD_TOO_LARGE",
      status: 413,
      message: "The request body is too large.",
    });
  }
  if (text.trim().length === 0) {
    return schema.parse({});
  }
  try {
    return schema.parse(JSON.parse(text) as unknown);
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new AppError({
        code: "VALIDATION_ERROR",
        status: 400,
        message: "The request body must be JSON.",
      });
    }
    throw error;
  }
}

export function json(body: unknown, status = 200): Response {
  return Response.json(body, {
    status,
    headers: { "cache-control": "no-store" },
  });
}
