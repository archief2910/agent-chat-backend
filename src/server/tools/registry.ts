import { z } from "zod";
import { AppError } from "@/lib/errors";
import { toMicrocredits } from "@/server/credits";
import { executeMagicaRun, readMediaUrls, type MagicaClient } from "@/server/magica/client";
import {
  FALLBACK_ESTIMATES,
  cropInputSchema,
  gptImageInputSchema,
  imageOutputSchema,
  mergeVideosInputSchema,
  videoOutputSchema,
} from "@/server/magica/inputs";
import { conformToSchema } from "@/server/magica/schema-validate";
import type { SkillRegistry } from "@/server/skills/registry";
import { SkillAccessError } from "@/server/skills/registry";
import type { WaitForUser } from "@/server/waitpoints/registry";

export type LoadedSkill = { name: string; hash: string; body: string };

export type ToolContext = {
  runId: string;
  chatId: string;
  userId: string;
  toolCallId: string;
  signal: AbortSignal;
  existingExternalRunId?: string | null;
  recordSkill: (skill: LoadedSkill) => Promise<void>;
  loadedSkill: (name: string) => LoadedSkill | null;
  rememberExternalRun: (externalRunId: string) => Promise<void>;
  waitForUser: WaitForUser;
};

export type ToolExecution = { ok: true; output: unknown } | { ok: false; error: string };

export type ToolExecutionMode = "inline" | "durable";

export type ToolDefinition = {
  name: string;
  label: string;
  description: string;
  execution: ToolExecutionMode;
  renderer: string;
  billable: boolean;
  input: z.ZodType;
  output: z.ZodType;
  parameters: () => Promise<Record<string, unknown>>;
  estimateCredits: (input: unknown) => Promise<bigint>;
  previewSchema?: (input: unknown) => Promise<{ schemaModelId: string; schemaDurationMs: number } | null>;
  execute: (input: unknown, context: ToolContext) => Promise<ToolExecution>;
};

export type ToolRegistry = {
  list: () => ToolDefinition[];
  get: (name: string) => ToolDefinition | null;
  definitions: () => Promise<Array<{ type: "function"; function: { name: string; description: string; parameters: Record<string, unknown> } }>>;
};

const loadSkillInput = z.object({ name: z.string().min(1).max(80) });
const loadSkillOutput = z.object({
  name: z.string(),
  description: z.string(),
  body: z.string(),
  hash: z.string(),
});
const readAssetInput = z.object({
  name: z.string().min(1).max(80),
  path: z.string().min(1).max(200),
});
const readAssetOutput = z.object({
  path: z.string(),
  mime: z.string(),
  text: z.string().nullable(),
  base64: z.string().nullable(),
});
export function createToolRegistry(options: {
  skills: SkillRegistry;
  magica: MagicaClient;
  sleep: (ms: number) => Promise<void>;
}): ToolRegistry {
  const tools: ToolDefinition[] = [
    skillTool(options.skills),
    assetTool(options.skills),
    magicaTool({
      name: "crop_image",
      label: "Crop Image",
      nodeType: "crop_image",
      description:
        "Crop an image. Provide image_url and one complete rectangle: percent fields, pixel fields, or crop {x,y,width,height}.",
      input: cropInputSchema,
      output: imageOutputSchema,
      outputKey: "image_url",
      renderer: "image-result",
      client: options.magica,
      sleep: options.sleep,
    }),
    magicaTool({
      name: "gpt_image_2",
      label: "GPT Image 2",
      nodeType: "gpt_image_2",
      description:
        "Generate an image with GPT Image 2, or edit one when uploadedImages has the source image URLs. Other fields follow the live model schema.",
      input: gptImageInputSchema,
      output: imageOutputSchema,
      outputKey: "image_url",
      renderer: "image-result",
      client: options.magica,
      sleep: options.sleep,
      subModel: gptSubModel,
      parameterSchemaIds: ["gpt-image-2-text", "gpt-image-2-edit"],
    }),
    magicaTool({
      name: "merge_videos",
      label: "Merge Videos",
      nodeType: "merge_videos",
      description: "Merge 2 to 100 videos in the given order. transition is none, fade, or dissolve.",
      input: mergeVideosInputSchema,
      output: videoOutputSchema,
      outputKey: "video_url",
      renderer: "video-result",
      client: options.magica,
      sleep: options.sleep,
    }),
  ];
  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  return {
    list: () => tools,
    get: (name) => byName.get(name) ?? null,
    async definitions() {
      return Promise.all(
        tools.map(async (tool) => ({
          type: "function" as const,
          function: { name: tool.name, description: tool.description, parameters: await tool.parameters() },
        })),
      );
    },
  };
}

function skillTool(skills: SkillRegistry): ToolDefinition {
  return {
    name: "load_skill",
    label: "Load skill",
    description: "Load the full instructions for one skill from the catalog.",
    execution: "inline",
    renderer: "skill",
    billable: false,
    input: loadSkillInput,
    output: loadSkillOutput,
    parameters: async () => parametersFor(loadSkillInput),
    estimateCredits: async () => 0n,
    async execute(input, context) {
      const parsed = loadSkillInput.parse(input);
      const skill = skills.get(parsed.name);
      if (!skill) return { ok: false, error: `Unknown skill: ${parsed.name}` };
      const restored = context.loadedSkill(skill.name);
      const loaded = restored ?? { name: skill.name, hash: skill.hash, body: skill.body };
      if (!restored) await context.recordSkill(loaded);
      return { ok: true, output: { name: loaded.name, description: skill.description, body: loaded.body, hash: loaded.hash } };
    },
  };
}

function assetTool(skills: SkillRegistry): ToolDefinition {
  return {
    name: "read_skill_asset",
    label: "Read skill file",
    description: "Read one file from a skill directory. Paths outside that directory are rejected.",
    execution: "inline",
    renderer: "skill",
    billable: false,
    input: readAssetInput,
    output: readAssetOutput,
    parameters: async () => parametersFor(readAssetInput),
    estimateCredits: async () => 0n,
    async execute(input) {
      const parsed = readAssetInput.parse(input);
      try {
        return { ok: true, output: skills.readAsset(parsed.name, parsed.path) };
      } catch (error) {
        const message = error instanceof SkillAccessError ? error.message : "The skill file could not be read.";
        return { ok: false, error: message };
      }
    },
  };
}

function magicaTool(config: {
  name: string;
  label: string;
  nodeType: string;
  description: string;
  input: z.ZodType;
  output: z.ZodType;
  outputKey: "image_url" | "video_url";
  renderer: string;
  client: MagicaClient;
  sleep: (ms: number) => Promise<void>;
  subModel?: (client: MagicaClient, input: Record<string, unknown>) => Promise<string>;
  parameterSchemaIds?: string[];
}): ToolDefinition {
  const schemaId = async (input: Record<string, unknown>) =>
    config.subModel ? config.subModel(config.client, input) : config.nodeType;
  return {
    name: config.name,
    label: config.label,
    description: config.description,
    execution: "durable",
    renderer: config.renderer,
    billable: true,
    input: config.input,
    output: config.output,
    parameters: async () => {
      try {
        const ids = config.parameterSchemaIds ?? [config.nodeType];
        const schemas = await Promise.all(ids.map((id) => config.client.getSchema(id)));
        const [first, ...rest] = schemas;
        if (!first) return parametersFor(config.input);
        const properties = Object.assign({}, ...schemas.map((schema) => schema.properties ?? {})) as Record<string, unknown>;
        delete properties.processId;
        const required = (first.required ?? []).filter((key) => rest.every((schema) => (schema.required ?? []).includes(key)));
        return { type: "object", properties, required };
      } catch {
        return parametersFor(config.input);
      }
    },
    async estimateCredits(input) {
      const data = asRecord(input);
      try {
        const subModelId = config.subModel ? await schemaId(data) : undefined;
        const quote = await config.client.estimate({
          nodeType: config.nodeType,
          ...(subModelId ? { subModelId } : {}),
          data,
        });
        if (quote > 0n) return quote;
      } catch (error) {
        if (error instanceof AppError && !error.retryable) throw error;
      }
      return FALLBACK_ESTIMATES[config.nodeType] ?? 0n;
    },
    async previewSchema(input) {
      const parsed = asRecord(config.input.parse(input));
      const subModelId = config.subModel ? await schemaId(parsed) : undefined;
      const schemaModelId = subModelId ?? config.nodeType;
      const schemaStarted = Date.now();
      await config.client.getSchema(schemaModelId);
      return { schemaModelId, schemaDurationMs: Math.max(0, Date.now() - schemaStarted) };
    },
    async execute(input, context) {
      const parsed = asRecord(config.input.parse(input));
      const subModelId = config.subModel ? await schemaId(parsed) : undefined;
      const schemaModelId = subModelId ?? config.nodeType;
      const schemaStarted = Date.now();
      const schema = await config.client.getSchema(schemaModelId);
      const schemaDurationMs = Math.max(0, Date.now() - schemaStarted);
      const data = conformToSchema(parsed, schema);
      const started = Date.now();
      const run = await executeMagicaRun({
        client: config.client,
        nodeType: config.nodeType,
        ...(subModelId ? { subModelId } : {}),
        data,
        existingRunId: context.existingExternalRunId,
        rememberRunId: context.rememberExternalRun,
        sleep: config.sleep,
        shouldCancel: async () => context.signal.aborted,
      });
      if (run.status !== "COMPLETED") {
        return { ok: false, error: run.userMessage || run.error || "The model run failed." };
      }
      const urls = readMediaUrls(run.output, config.outputKey);
      const first = urls[0];
      if (!first) return { ok: false, error: "The model run finished without a media URL." };
      return {
        ok: true,
        output: {
          [config.outputKey]: first,
          [`${config.outputKey}s`]: urls,
          externalRunId: run.id,
          creditMicrocredits: toMicrocredits(run.creditUsed ?? 0).toString(),
          durationMs: Date.now() - started,
          schemaModelId,
          schemaDurationMs,
        },
      };
    },
  };
}

async function gptSubModel(client: MagicaClient, input: Record<string, unknown>): Promise<string> {
  const uploaded = input.uploadedImages;
  const wantsEdit = Array.isArray(uploaded) && uploaded.length > 0;
  const suffix = wantsEdit ? "-edit" : "-text";
  try {
    const models = await client.listModels();
    const ids = models.find((model) => model.nodeType === "gpt_image_2")?.subModels?.map((item) => item.subModelId) ?? [];
    const chosen = ids.find((id) => id.endsWith(suffix));
    if (chosen) return chosen;
  } catch {
    // Public catalog ids observed on 2026-10-10.
  }
  return `gpt-image-2${suffix}`;
}

function parametersFor(schema: z.ZodType): Record<string, unknown> {
  const json = z.toJSONSchema(schema) as Record<string, unknown>;
  delete json.$schema;
  return json;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

export function describeTools(registry: ToolRegistry) {
  return registry.list().map((tool) => ({
    name: tool.name,
    label: tool.label,
    description: tool.description,
    execution: tool.execution,
    renderer: tool.renderer,
    billable: tool.billable,
  }));
}
