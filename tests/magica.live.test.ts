import { describe, expect, it } from "vitest";
import { MagicaClient, executeMagicaRun } from "@/server/magica/client";
import { cropInputSchema, gptImageInputSchema, mergeVideosInputSchema } from "@/server/magica/inputs";
import { conformToSchema } from "@/server/magica/schema-validate";
import { readMediaUrl } from "@/server/magica/client";

const live = Boolean(process.env.MAGICA_API_KEY && process.env.MAGICA_LIVE === "1");
const describeLive = live ? describe : describe.skip;

describeLive("magica live acceptance", () => {
  const client = new MagicaClient({
    baseUrl: process.env.MAGICA_BASE_URL ?? "https://inference.magica.com",
    apiKey: process.env.MAGICA_API_KEY ?? "",
  });

  async function runTool(nodeType: string, subModelId: string | undefined, data: Record<string, unknown>) {
    const schema = await client.getSchema(subModelId ?? nodeType);
    const input = conformToSchema(data, schema);
    const run = await executeMagicaRun({
      client,
      nodeType,
      ...(subModelId ? { subModelId } : {}),
      data: input,
      rememberRunId: async () => {},
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      maxPolls: 40,
    });
    expect(run.status).toBe("COMPLETED");
    return run;
  }

  it("crops an image", async () => {
    const data = cropInputSchema.parse({
      image_url: "https://upload.wikimedia.org/wikipedia/commons/thumb/4/47/PNG_transparency_demonstration_1.png/280px-PNG_transparency_demonstration_1.png",
      x_percent: 0,
      y_percent: 0,
      width_percent: 50,
      height_percent: 50,
    });
    const run = await runTool("crop_image", undefined, data);
    expect(readMediaUrl(run.output, "image_url")).toMatch(/^https?:\/\//);
  }, 120_000);

  it("generates an image and would accept an edit sub-model", async () => {
    const data = gptImageInputSchema.parse({ prompt: "A small red square on a white background" });
    const models = await client.listModels();
    const ids = models.find((model) => model.nodeType === "gpt_image_2")?.subModels?.map((item) => item.subModelId) ?? [];
    expect(ids.some((id) => id.endsWith("-text"))).toBe(true);
    expect(ids.some((id) => id.endsWith("-edit"))).toBe(true);
    const textId = ids.find((id) => id.endsWith("-text"));
    const run = await runTool("gpt_image_2", textId, data);
    expect(readMediaUrl(run.output, "image_url")).toMatch(/^https?:\/\//);
  }, 180_000);

  it("rejects a merge with fewer than two videos before calling Magica", () => {
    expect(mergeVideosInputSchema.safeParse({ video_urls: ["https://cdn.example/a.mp4"] }).success).toBe(false);
  });
});
