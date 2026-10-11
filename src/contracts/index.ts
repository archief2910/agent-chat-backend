import { z } from "zod";

export const textBlockSchema = z.object({
  type: z.literal("text"),
  text: z.string(),
});

export const thinkingBlockSchema = z.object({
  type: z.literal("thinking"),
  text: z.string(),
  durationMs: z.number().int().nonnegative().optional(),
});

export const toolUseBlockSchema = z.object({
  type: z.literal("tool_use"),
  id: z.string(),
  name: z.string(),
  input: z.unknown(),
});

export const toolResultBlockSchema = z.object({
  type: z.literal("tool_result"),
  toolUseId: z.string(),
  name: z.string(),
  isError: z.boolean(),
  output: z.unknown(),
});

export const assetBlockSchema = z.object({
  type: z.literal("asset"),
  kind: z.enum(["image", "video", "audio"]),
  url: z.url(),
  assetId: z.string().optional(),
});

export const citationBlockSchema = z.object({
  type: z.literal("citation"),
  title: z.string(),
  url: z.url(),
});

export const usageBlockSchema = z.object({
  type: z.literal("usage"),
  model: z.string(),
  promptTokens: z.number().int().nonnegative(),
  completionTokens: z.number().int().nonnegative(),
  chargedMicrocredits: z.string(),
});

export const contentBlockSchema = z.discriminatedUnion("type", [
  textBlockSchema,
  thinkingBlockSchema,
  toolUseBlockSchema,
  toolResultBlockSchema,
  assetBlockSchema,
  citationBlockSchema,
  usageBlockSchema,
]);

export const contentBlocksSchema = z.array(contentBlockSchema);
export type ContentBlock = z.infer<typeof contentBlockSchema>;

export const attachmentInputSchema = z.object({
  assetId: z.string().min(1),
  position: z.number().int().nonnegative(),
});

export const sendMessageBodySchema = z.object({
  clientMessageId: z.uuid(),
  text: z.string().trim().min(1).max(100_000),
  planMode: z.boolean().optional(),
  attachments: z.array(attachmentInputSchema).max(8).optional(),
});
export type SendMessageBody = z.infer<typeof sendMessageBodySchema>;

export const createChatBodySchema = z.object({
  title: z.string().trim().min(1).max(120).optional(),
});

export const updateChatBodySchema = z.object({
  title: z.string().trim().min(1).max(120).optional(),
  pinned: z.boolean().optional(),
});

export const listQuerySchema = z.object({
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().int().positive().max(100).optional(),
  q: z.string().trim().min(1).max(200).optional(),
});

export const assetKindSchema = z.enum(["image", "video", "audio", "other"]);

export const assetSchema = z.object({
  id: z.string(),
  kind: assetKindSchema,
  source: z.enum(["upload", "generated"]),
  mime: z.string(),
  bytes: z.string().nullable(),
  originalName: z.string().nullable(),
  url: z.string().nullable(),
  isTemporaryUrl: z.boolean(),
  createdAt: z.string(),
});

export const completedUploadSchema = z.object({
  uploadId: z.string(),
  status: z.enum(["pending", "completed", "failed", "canceled"]),
  duplicate: z.boolean(),
  assets: z.array(assetSchema),
});

export const modelStatusSchema = z.object({
  model: z.literal("openrouter/free"),
  status: z.literal("configured"),
  paidFallback: z.literal(false),
});

export const messageSchema = z.object({
  id: z.string(),
  chatId: z.string(),
  runId: z.string().nullable(),
  role: z.enum(["user", "assistant", "system", "tool"]),
  status: z.enum(["pending", "streaming", "completed", "failed", "cancelled"]),
  content: contentBlocksSchema,
  attachments: z.array(z.object({ position: z.number().int(), asset: assetSchema })),
  createdAt: z.string(),
});

export const agentChunkSchema = z.object({
  seq: z.number().int().positive(),
  kind: z.enum(["text", "thinking"]),
  delta: z.string(),
});
export type AgentChunk = z.infer<typeof agentChunkSchema>;

export const waitpointKindSchema = z.enum(["options", "plan", "credit", "media"]);

export const waitpointSummarySchema = z.object({
  id: z.string(),
  kind: waitpointKindSchema,
  status: z.enum(["pending", "answered", "expired", "cancelled"]),
  request: z.unknown(),
  expiresAt: z.string(),
});

export const runStatusSchema = z.enum(["queued", "thinking", "working", "waiting", "stopping", "completed", "failed", "cancelled"]);

export const generatedAssetEventSchema = z.object({
  toolCallId: z.string(),
  kind: z.enum(["image", "video", "audio"]),
  url: z.url(),
});

export const runMetadataSchema = z.object({
  runId: z.string(),
  status: runStatusSchema,
  step: z.number().int().nonnegative(),
  progress: z.number().int().min(0).max(100),
  activeTools: z.array(z.object({ toolCallId: z.string(), name: z.string() })),
  assets: z.array(generatedAssetEventSchema),
  waitpoint: waitpointSummarySchema.nullable(),
  updatedAt: z.string(),
});
export type RunMetadata = z.infer<typeof runMetadataSchema>;

export const waitpointRespondBodySchema = z.object({
  response: z.unknown(),
});

export const uploadFileSchema = z.object({
  name: z.string().trim().min(1).max(255),
  size: z.number().int().positive(),
  mime: z.string().trim().min(1).max(120),
});

export const createAssemblyBodySchema = z.object({
  files: z.array(uploadFileSchema).min(1).max(8),
});

export const createAssemblyResponseSchema = z.object({
  uploadId: z.string(),
  params: z.string(),
  signature: z.string(),
  expiresAt: z.string(),
});

export const completeAssemblyBodySchema = z.object({
  assemblyId: z.string().regex(/^[a-f0-9]{32}$/),
});

export const completionBodySchema = z.object({
  chatId: z.string().min(1).optional(),
  text: z.string().trim().min(1).max(100_000),
  clientMessageId: z.uuid().optional(),
  planMode: z.boolean().optional(),
});

export const retryBodySchema = z.object({
  clientMessageId: z.uuid().optional(),
});

export const createApiKeyBodySchema = z.object({
  name: z.string().trim().min(1).max(80),
});

export const createWebhookBodySchema = z.object({
  url: z.url(),
});

export const directToolRunBodySchema = z.object({
  input: z.record(z.string(), z.unknown()),
  clientRequestId: z.uuid(),
});

export const toolDescriptorSchema = z.object({
  name: z.string(),
  label: z.string(),
  description: z.string(),
  execution: z.enum(["inline", "durable"]),
  renderer: z.string(),
  billable: z.boolean(),
});

export const chatSchema = z.object({
  id: z.string(),
  title: z.string(),
  pinnedAt: z.string().nullable(),
  activeRunId: z.string().nullable(),
  lastMessageAt: z.string(),
  createdAt: z.string(),
});

export const sendMessageResponseSchema = z.object({
  chatId: z.string(),
  messageId: z.string(),
  assistantMessageId: z.string(),
  runId: z.string(),
  status: z.string(),
  replayed: z.boolean(),
  realtime: z.object({
    token: z.string().nullable(),
    triggerRunId: z.string().nullable(),
    streamId: z.literal("agent-output"),
  }),
});

export const runSnapshotSchema = z.object({
  id: z.string(),
  chatId: z.string(),
  status: runStatusSchema,
  routedModel: z.string().nullable(),
  stepCount: z.number().int(),
  progress: z.number().int().min(0).max(100),
  waitpoint: waitpointSummarySchema.nullable(),
  error: z.object({ code: z.string(), message: z.string() }).nullable(),
  assistantMessage: messageSchema.nullable(),
  tools: z.array(
    z.object({
      id: z.string(),
      toolCallId: z.string(),
      name: z.string(),
      status: z.enum(["pending", "running", "completed", "failed", "cancelled"]),
      durationMs: z.number().nullable(),
      chargedMicrocredits: z.string(),
      errorMessage: z.string().nullable(),
      schemaModelId: z.string().optional(),
      schemaDurationMs: z.number().optional(),
    }),
  ),
  usage: z.object({
    promptTokens: z.number().int(),
    completionTokens: z.number().int(),
    chargedMicrocredits: z.string(),
    credits: z.string(),
  }),
  updatedAt: z.string(),
});

export const creditBalanceSchema = z.object({
  balanceMicrocredits: z.string(),
  credits: z.string(),
  entries: z.array(
    z.object({
      id: z.string(),
      type: z.enum(["grant", "hold", "capture", "release"]),
      amountMicrocredits: z.string(),
      credits: z.string(),
      balanceAfter: z.string(),
      runId: z.string().nullable(),
      createdAt: z.string(),
    }),
  ),
  nextCursor: z.string().nullable(),
});

export const usagePeriodSchema = z.enum(["current", "previous", "older"]);

export const usageQuerySchema = z.object({
  period: usagePeriodSchema.optional(),
});

export const usageStepSchema = z.object({
  name: z.string(),
  createdAt: z.string(),
  debitedMicrocredits: z.string(),
});

export const usageExecutionSchema = z.object({
  id: z.string(),
  debitedMicrocredits: z.string(),
  createdAt: z.string(),
  steps: z.array(usageStepSchema),
});

export const usageCategorySchema = z.object({
  id: z.string(),
  name: z.string(),
  debitedMicrocredits: z.string(),
  executions: z.number().int().nonnegative(),
  latestUsageAt: z.string().nullable(),
  rows: z.array(usageExecutionSchema),
});

export const usageSummarySchema = z.object({
  balanceMicrocredits: z.string(),
  credits: z.string(),
  period: z.object({
    id: usagePeriodSchema,
    from: z.string(),
    to: z.string(),
  }),
  totals: z.object({
    debitedMicrocredits: z.string(),
    executions: z.number().int().nonnegative(),
    categories: z.number().int().nonnegative(),
  }),
  categories: z.array(usageCategorySchema),
});

export const cursorPageSchema = z.object({
  at: z.string(),
  id: z.string(),
});
