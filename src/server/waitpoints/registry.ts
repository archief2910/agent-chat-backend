import { z } from "zod";
import { AppError } from "@/lib/errors";

const httpUrl = z.url().refine((value) => /^https?:$/.test(new URL(value).protocol), "Use an http or https URL.");

const optionsRequest = z.object({
  question: z.string().trim().min(1).max(500),
  options: z
    .array(z.object({ id: z.string().trim().min(1).max(60), label: z.string().trim().min(1).max(200) }))
    .min(2)
    .max(8),
  allowMultiple: z.boolean().default(false),
});

const planRequest = z.object({
  summary: z.string().trim().min(1).max(1_000),
  steps: z.array(z.string().trim().min(1).max(500)).min(1).max(20),
});

const creditRequest = z.object({
  toolName: z.string(),
  estimatedMicrocredits: z.string().regex(/^\d+$/),
  credits: z.string(),
});

const mediaRequest = z.object({
  question: z.string().trim().min(1).max(500),
  media: z.array(z.object({ url: httpUrl, kind: z.enum(["image", "video", "audio"]) })).min(1).max(8),
});

const approval = z.object({
  approved: z.boolean(),
  feedback: z.string().trim().max(1_000).optional(),
});

export const waitpointKinds = {
  options: {
    request: optionsRequest,
    response: z.object({ selected: z.array(z.string()).min(1).max(8) }),
    validate(request: z.infer<typeof optionsRequest>, response: { selected: string[] }) {
      const ids = new Set(request.options.map((option) => option.id));
      if (response.selected.some((id) => !ids.has(id))) return "Choose one of the listed options.";
      if (!request.allowMultiple && response.selected.length > 1) return "Choose one option.";
      return null;
    },
  },
  plan: { request: planRequest, response: approval, validate: () => null },
  credit: { request: creditRequest, response: approval, validate: () => null },
  media: { request: mediaRequest, response: approval, validate: () => null },
} as const;

export type WaitpointKind = keyof typeof waitpointKinds;

export function parseWaitpointResponse(kind: string, request: unknown, response: unknown) {
  if (!(kind in waitpointKinds)) {
    throw new AppError({ code: "VALIDATION_ERROR", status: 400, message: "This request type is not supported." });
  }
  const definition = waitpointKinds[kind as WaitpointKind];
  const parsedResponse = definition.response.safeParse(response);
  if (!parsedResponse.success) {
    throw new AppError({
      code: "VALIDATION_ERROR",
      status: 400,
      message: "The answer is not valid for this request.",
      details: parsedResponse.error.issues.map((issue) => ({ path: issue.path.map(String), message: issue.message })),
    });
  }
  const parsedRequest = definition.request.parse(request);
  const problem = (definition.validate as (req: unknown, res: unknown) => string | null)(parsedRequest, parsedResponse.data);
  if (problem) throw new AppError({ code: "VALIDATION_ERROR", status: 400, message: problem });
  return parsedResponse.data as Record<string, unknown>;
}

export type WaitOutcome =
  | { status: "answered"; response: Record<string, unknown> }
  | { status: "expired" }
  | { status: "cancelled" };

export type WaitForUser = (input: {
  toolCallId: string;
  kind: WaitpointKind;
  request: unknown;
}) => Promise<WaitOutcome>;
