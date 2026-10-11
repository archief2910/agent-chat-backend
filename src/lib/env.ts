import { z } from "zod";

const optionalText = z
  .string()
  .optional()
  .transform((value) => (value && value.length > 0 ? value : undefined));

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  DATABASE_URL: z.string().min(1),
  DIRECT_DATABASE_URL: optionalText,
  CLERK_SECRET_KEY: z.string().min(1),
  CLERK_PUBLISHABLE_KEY: z.string().min(1),
  CLERK_JWT_KEY: optionalText,
  FRONTEND_ORIGIN: z.url(),
  TRIGGER_SECRET_KEY: z.string().min(1),
  TRIGGER_PROJECT_REF: z.string().min(1),
  OPENROUTER_API_KEY: z.string().min(1),
  OPENROUTER_MODEL: z.literal("openrouter/free"),
  OPENROUTER_BASE_URL: z.url().default("https://openrouter.ai/api/v1"),
  MAGICA_API_KEY: z.string().min(1),
  MAGICA_BASE_URL: z.url().default("https://inference.magica.com"),
  APP_BASE_URL: z.url(),
  CREDIT_ADMISSION_MICROCREDITS: z.coerce.number().int().positive().default(5_000),
  INITIAL_CREDIT_MICROCREDITS: z.coerce.number().int().nonnegative().default(10_000_000),
  MAX_MESSAGE_CHARS: z.coerce.number().int().positive().max(100_000).default(32_000),
  SEND_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().positive().default(20),
  AGENT_MAX_STEPS: z.coerce.number().int().positive().max(32).default(8),
  AGENT_MAX_TOOL_CALLS: z.coerce.number().int().positive().max(16).default(4),
  AGENT_MAX_DURATION_MS: z.coerce.number().int().positive().default(900_000),
  // Trigger.dev deletes a stream left empty for about an hour, so approvals expire before that.
  WAITPOINT_TIMEOUT_MINUTES: z.coerce.number().int().positive().max(55).default(30),
  CREDIT_APPROVAL_THRESHOLD_MICROCREDITS: z.coerce.number().int().nonnegative().default(1_000_000),
  TRANSLOADIT_AUTH_KEY: optionalText,
  TRANSLOADIT_AUTH_SECRET: optionalText,
  TRANSLOADIT_TEMPLATE_ID: optionalText,
  TRANSLOADIT_NOTIFY_URL: optionalText.pipe(z.url().optional()),
  TRANSLOADIT_RESULT_STEP: optionalText,
  // Community plan: 5 GB a month and 0.5 GB per file. Decimal units keep us under either reading.
  UPLOAD_MONTHLY_BYTES: z.coerce.number().int().positive().default(5_000_000_000),
  UPLOAD_MAX_FILE_BYTES: z.coerce.number().int().positive().default(500_000_000),
  UPLOAD_MAX_FILES: z.coerce.number().int().positive().max(8).default(8),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),
});

export type Env = z.infer<typeof envSchema>;

let cached: Env | undefined;

export function getEnv(): Env {
  if (cached) return cached;
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    const fields = parsed.error.issues.map((issue) => issue.path.join(".") || "env");
    throw new Error(`Invalid environment: ${fields.join(", ")}`);
  }
  cached = parsed.data;
  return parsed.data;
}

export function resetEnvCache(): void {
  cached = undefined;
}
