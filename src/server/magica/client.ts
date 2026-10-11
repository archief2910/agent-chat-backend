import { z } from "zod";
import { AppError } from "@/lib/errors";

const errorBodySchema = z.object({
  error: z.string().optional(),
  message: z.string().optional(),
  code: z.string().optional(),
  userMessage: z.string().nullable().optional(),
  traceId: z.string().optional(),
});

const runSchema = z.object({
  id: z.string(),
  nodeType: z.string(),
  subModelId: z.string().nullable().optional(),
  status: z.string(),
  output: z.unknown().optional(),
  error: z.string().nullable().optional(),
  userMessage: z.string().nullable().optional(),
  creditUsed: z.number().optional(),
});

const startedSchema = z.object({ runId: z.string().min(1) });

const estimateSchema = z.object({
  estimates: z.array(z.object({ microcredits: z.number() })),
});

const modelListSchema = z.array(
  z.object({
    nodeType: z.string(),
    subModels: z.array(z.object({ subModelId: z.string() })).optional(),
  }),
);

export type MagicaRun = z.infer<typeof runSchema>;
export type MagicaModel = z.infer<typeof modelListSchema>[number];

export type JsonSchema = {
  type?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  enum?: unknown[];
  minimum?: number;
  maximum?: number;
  minItems?: number;
  maxItems?: number;
  minLength?: number;
  maxLength?: number;
  format?: string;
};

const TERMINAL = new Set(["COMPLETED", "FAILED", "CANCELED"]);

export function isTerminalMagicaStatus(status: string): boolean {
  return TERMINAL.has(status);
}

const SCHEMA_TTL_MS = 10 * 60 * 1000;

export class MagicaClient {
  private readonly schemas = new Map<string, { at: number; schema: JsonSchema }>();
  private models: { at: number; list: MagicaModel[] } | null = null;

  constructor(
    private readonly options: {
      baseUrl: string;
      apiKey: string;
      fetchImpl?: typeof fetch;
      now?: () => number;
    },
  ) {}

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  async listModels(): Promise<MagicaModel[]> {
    if (this.models && this.now() - this.models.at < SCHEMA_TTL_MS) return this.models.list;
    const list = modelListSchema.parse(await this.request("GET", "/v1/models"));
    this.models = { at: this.now(), list };
    return list;
  }

  async getSchema(modelId: string): Promise<JsonSchema> {
    const cached = this.schemas.get(modelId);
    if (cached && this.now() - cached.at < SCHEMA_TTL_MS) return cached.schema;
    const body = await this.request("GET", `/v1/models/${encodeURIComponent(modelId)}/schema`);
    const schema = schemaFromResponse(body);
    this.schemas.set(modelId, { at: this.now(), schema });
    return schema;
  }

  async estimate(input: { nodeType: string; subModelId?: string; data: Record<string, unknown> }): Promise<bigint> {
    const body = estimateSchema.parse(
      await this.request("POST", "/v1/nodes/estimate-credits", {
        nodes: [
          {
            type: input.nodeType,
            ...(input.subModelId ? { subModelId: input.subModelId } : {}),
            data: input.data,
          },
        ],
      }),
    );
    const quote = body.estimates[0]?.microcredits;
    if (quote === undefined) {
      throw new AppError({
        code: "UPSTREAM_CONTRACT",
        status: 502,
        message: "The provider did not return a credit estimate.",
        retryable: true,
      });
    }
    if (!Number.isSafeInteger(quote) || quote < 0) {
      throw new AppError({
        code: "UPSTREAM_CONTRACT",
        status: 502,
        message: "The provider returned a credit estimate this app cannot use.",
        retryable: true,
      });
    }
    return BigInt(quote);
  }

  async startRun(input: {
    nodeType: string;
    subModelId?: string;
    data: Record<string, unknown>;
  }): Promise<string> {
    const body = startedSchema.parse(
      await this.request("POST", `/v1/nodes/${encodeURIComponent(input.nodeType)}/run`, {
        input: input.data,
        ...(input.subModelId ? { subModelId: input.subModelId } : {}),
      }, [202]),
    );
    return body.runId;
  }

  async getRun(runId: string): Promise<MagicaRun> {
    return runSchema.parse(await this.request("GET", `/v1/nodes/runs/${encodeURIComponent(runId)}`));
  }

  private async request(method: string, pathname: string, body?: unknown, accepted = [200]): Promise<unknown> {
    const fetchImpl = this.options.fetchImpl ?? fetch;
    let response: Response;
    try {
      response = await fetchImpl(`${this.options.baseUrl}${pathname}`, {
        method,
        headers: {
          Authorization: `Bearer ${this.options.apiKey}`,
          Accept: "application/json",
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(30_000),
      });
    } catch (error) {
      throw new AppError({
        code: "UPSTREAM_TIMEOUT",
        status: 504,
        message: "The model service did not respond in time.",
        retryable: true,
        cause: error,
      });
    }
    const text = await response.text();
    const parsed = text.length > 0 ? safeJson(text) : {};
    if (!accepted.includes(response.status)) {
      throw magicaError(response.status, parsed);
    }
    return parsed;
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return { message: "The model service returned a response that was not JSON." };
  }
}

export function magicaError(status: number, body: unknown): AppError {
  const parsed = errorBodySchema.safeParse(body);
  const safe = parsed.success ? parsed.data.userMessage || parsed.data.message : undefined;
  if (status === 401) {
    return new AppError({
      code: "UPSTREAM_UNAUTHORIZED",
      status: 502,
      message: "The model service rejected the server credentials.",
      retryable: false,
    });
  }
  if (status === 429) {
    return new AppError({
      code: "UPSTREAM_RATE_LIMITED",
      status: 429,
      message: "The model service is rate limited. Try again shortly.",
      retryable: true,
    });
  }
  if (status === 400 || status === 404 || status === 410) {
    return new AppError({
      code: status === 410 ? "MODEL_RETIRED" : "UPSTREAM_REJECTED",
      status: 400,
      message: safe && safe.length < 300 ? safe : "The model service rejected this input.",
      retryable: false,
    });
  }
  if (status === 403) {
    return new AppError({
      code: "UPSTREAM_FORBIDDEN",
      status: 502,
      message: "The model service refused the request.",
      retryable: false,
    });
  }
  return new AppError({
    code: "UPSTREAM_ERROR",
    status: 502,
    message: "The model service failed. Try again.",
    retryable: true,
  });
}

export function schemaFromResponse(body: unknown): JsonSchema {
  if (!body || typeof body !== "object") {
    throw new AppError({ code: "UPSTREAM_CONTRACT", status: 502, message: "The model schema was empty.", retryable: true });
  }
  const record = body as Record<string, unknown>;
  for (const key of ["inputSchema", "jsonSchema", "schema"]) {
    const candidate = record[key];
    if (isObjectSchema(candidate)) return candidate;
  }
  if (isObjectSchema(record)) return record;
  if (Array.isArray(record.fields)) return schemaFromFields(record.fields);
  throw new AppError({
    code: "UPSTREAM_CONTRACT",
    status: 502,
    message: "The model schema could not be read.",
    retryable: true,
  });
}

function isObjectSchema(value: unknown): value is JsonSchema {
  return Boolean(value && typeof value === "object" && "properties" in value);
}

/**
 * Converts Magica's normalized field list (`dataType`, `required`, `options`, `min`, `max`)
 * into the JSON-schema subset `conformToSchema` checks. The UI `type` (slider, image) is ignored.
 */
export function schemaFromFields(fields: unknown[]): JsonSchema {
  const properties: Record<string, JsonSchema> = {};
  const required: string[] = [];
  for (const field of fields) {
    if (!field || typeof field !== "object") continue;
    const record = field as Record<string, unknown>;
    const name = stringField(record, "zodExpectedName") ?? stringField(record, "name") ?? stringField(record, "key");
    if (!name || name === "processId") continue;
    const dataType = stringField(record, "dataType");
    const isArray = dataType?.endsWith("[]") ?? false;
    const base = isArray ? dataType?.slice(0, -2) : dataType;
    const scalar: JsonSchema = {};
    if (base === "string" || base === "number" || base === "boolean") scalar.type = base;
    const options = Array.isArray(record.options)
      ? record.options.flatMap((option) => {
          if (typeof option === "string" || typeof option === "number" || typeof option === "boolean") return [option];
          if (option && typeof option === "object" && "value" in option) return [(option as { value: unknown }).value];
          return [];
        })
      : [];
    const hasCustom = typeof record.customValue === "string";
    if (options.length > 0 && !hasCustom) scalar.enum = options;
    const min = numberField(record, "min");
    const max = numberField(record, "max");
    if (scalar.type === "number") {
      if (min !== undefined) scalar.minimum = min;
      if (max !== undefined) scalar.maximum = max;
    } else if (scalar.type === "string" && max !== undefined) {
      scalar.maxLength = max;
    }
    if (isArray) {
      const array: JsonSchema = { type: "array", items: scalar };
      const maxItems = numberField(record, "maxItems") ?? numberField(record, "maxImages");
      if (maxItems !== undefined) array.maxItems = maxItems;
      properties[name] = array;
    } else {
      properties[name] = scalar;
    }
    if (record.required === true) required.push(name);
  }
  return { type: "object", properties, required };
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numberField(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

const MEDIA_KEYS: Record<string, string[]> = {
  image_url: ["image_url", "images", "image_urls"],
  video_url: ["video_url", "videos", "video_urls"],
  audio_url: ["audio_url", "audios", "audio_urls"],
};

export function readMediaUrls(output: unknown, preferredKey: string): string[] {
  if (!output || typeof output !== "object") return [];
  const record = output as Record<string, unknown>;
  const urls: string[] = [];
  for (const key of MEDIA_KEYS[preferredKey] ?? [preferredKey]) collectUrls(record[key], urls);
  // GPT Image 2 returns the file under result, not image_url.
  if (urls.length === 0) collectUrls(record.result, urls);
  return [...new Set(urls)];
}

export function readMediaUrl(output: unknown, preferredKey: string): string | null {
  return readMediaUrls(output, preferredKey)[0] ?? null;
}

function collectUrls(value: unknown, urls: string[]) {
  if (typeof value === "string" && /^https?:\/\//.test(value)) {
    urls.push(value);
    return;
  }
  if (!Array.isArray(value)) return;
  for (const item of value) {
    if (typeof item === "string" && /^https?:\/\//.test(item)) urls.push(item);
    else if (item && typeof item === "object" && "url" in item && typeof item.url === "string" && /^https?:\/\//.test(item.url)) {
      urls.push(item.url);
    }
  }
}

export async function executeMagicaRun(input: {
  client: MagicaClient;
  nodeType: string;
  subModelId?: string;
  data: Record<string, unknown>;
  existingRunId?: string | null;
  rememberRunId: (runId: string) => Promise<void>;
  sleep: (ms: number) => Promise<void>;
  shouldCancel?: () => Promise<boolean>;
  maxPolls?: number;
}): Promise<MagicaRun> {
  let runId = input.existingRunId ?? null;
  if (!runId) {
    runId = await input.client.startRun({
      nodeType: input.nodeType,
      ...(input.subModelId ? { subModelId: input.subModelId } : {}),
      data: input.data,
    });
    try {
      await input.rememberRunId(runId);
    } catch (error) {
      throw new AppError({
        code: "PERSISTENCE_FAILED",
        status: 500,
        message: "The model run started but could not be saved. It will be reconciled from the saved run id.",
        retryable: true,
        details: { externalRunId: runId },
        cause: error,
      });
    }
  }

  const maxPolls = input.maxPolls ?? 150;
  for (let attempt = 0; attempt < maxPolls; attempt += 1) {
    if (await input.shouldCancel?.()) {
      throw new AppError({ code: "CANCELLED", status: 409, message: "The turn was stopped.", retryable: false });
    }
    let run: MagicaRun;
    try {
      run = await input.client.getRun(runId);
    } catch (error) {
      if (error instanceof AppError && error.retryable) {
        await input.sleep(Math.min(8, 2 + Math.floor(attempt / 2)) * 1000);
        continue;
      }
      throw error;
    }
    if (isTerminalMagicaStatus(run.status)) return run;
    const seconds = Math.min(8, 2 + Math.floor(attempt / 2));
    await input.sleep(seconds * 1000);
  }
  throw new AppError({
    code: "UPSTREAM_TIMEOUT",
    status: 504,
    message: "The model run did not finish before the time limit.",
    retryable: true,
    details: { externalRunId: runId },
  });
}
