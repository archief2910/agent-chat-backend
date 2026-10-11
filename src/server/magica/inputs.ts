import { z } from "zod";

const httpUrl = z.url().refine((value) => {
  const protocol = new URL(value).protocol;
  return protocol === "https:" || protocol === "http:";
}, "Use an http or https URL.");

const percent = z.number().min(0).max(100);

export const cropInputSchema = z
  .object({
    image_url: httpUrl,
    crop: z
      .object({
        x: z.number().int().nonnegative(),
        y: z.number().int().nonnegative(),
        width: z.number().int().positive(),
        height: z.number().int().positive(),
      })
      .optional(),
    x_percent: percent.optional(),
    y_percent: percent.optional(),
    width_percent: percent.optional(),
    height_percent: percent.optional(),
    x_px: z.number().int().nonnegative().optional(),
    y_px: z.number().int().nonnegative().optional(),
    width_px: z.number().int().positive().optional(),
    height_px: z.number().int().positive().optional(),
  })
  .superRefine((value, ctx) => {
    const percentFields = [value.x_percent, value.y_percent, value.width_percent, value.height_percent];
    const pixelFields = [value.x_px, value.y_px, value.width_px, value.height_px];
    const modes = [value.crop !== undefined, percentFields.some((field) => field !== undefined), pixelFields.some((field) => field !== undefined)].filter(Boolean);
    if (modes.length !== 1) {
      ctx.addIssue({ code: "custom", message: "Provide one complete crop: percent, pixels, or crop.", path: ["crop"] });
      return;
    }
    if (percentFields.some((field) => field !== undefined) && percentFields.some((field) => field === undefined)) {
      ctx.addIssue({ code: "custom", message: "Percent crops need x, y, width, and height.", path: ["x_percent"] });
    }
    if ((value.width_percent ?? 0) === 0 || (value.height_percent ?? 0) === 0) {
      if (percentFields.some((field) => field !== undefined)) {
        ctx.addIssue({ code: "custom", message: "Percent width and height must be greater than 0.", path: ["width_percent"] });
      }
    }
    if ((value.width_px === undefined) !== (value.height_px === undefined)) {
      ctx.addIssue({ code: "custom", message: "Pixel crops need both width and height.", path: ["width_px"] });
    }
    if ((value.x_px === undefined) !== (value.y_px === undefined)) {
      ctx.addIssue({ code: "custom", message: "Pixel crops need both x and y when either is set.", path: ["x_px"] });
    }
  });

export const mergeVideosInputSchema = z.object({
  video_urls: z.array(httpUrl).min(2).max(100),
  transition: z.enum(["none", "fade", "dissolve"]).default("none"),
});

/**
 * Only the mode selector is fixed here. Every other field, limit, and enum is
 * checked against the live Magica schema for the chosen sub-model at execution time.
 */
export const gptImageInputSchema = z
  .object({
    prompt: z.string().trim().min(1),
    uploadedImages: z.array(httpUrl).min(1).optional(),
  })
  .catchall(z.unknown());

const runOutputFields = {
  externalRunId: z.string(),
  creditMicrocredits: z.string().regex(/^\d+$/),
  durationMs: z.number().int().nonnegative(),
  schemaModelId: z.string().min(1).optional(),
  schemaDurationMs: z.number().int().nonnegative().optional(),
};

export const imageOutputSchema = z.object({
  image_url: z.url(),
  image_urls: z.array(z.url()).min(1),
  ...runOutputFields,
});

export const videoOutputSchema = z.object({
  video_url: z.url(),
  video_urls: z.array(z.url()).min(1),
  ...runOutputFields,
});

/**
 * Last-known public catalog defaults from 2026-10-10.
 * Used only when the live estimate is missing. Execution still requires the live schema.
 */
export const FALLBACK_ESTIMATES: Record<string, bigint> = {
  crop_image: 5_000n,
  merge_videos: 50_000n,
  gpt_image_2: 273_936n,
};
