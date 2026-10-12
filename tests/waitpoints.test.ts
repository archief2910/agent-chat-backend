import { describe, expect, it } from "vitest";
import { generatedMedia, mimeFromUrl } from "@/server/agent/media";
import { schemaFromFields } from "@/server/magica/client";
import { conformToSchema } from "@/server/magica/schema-validate";
import { parseWaitpointResponse } from "@/server/waitpoints/registry";

const options = { question: "Which crop?", options: [{ id: "left", label: "Left" }, { id: "right", label: "Right" }], allowMultiple: false };

describe("waitpoint answers", () => {
  it("accepts a listed option and rejects others", () => {
    expect(parseWaitpointResponse("options", options, { selected: ["left"] })).toEqual({ selected: ["left"] });
    expect(() => parseWaitpointResponse("options", options, { selected: ["up"] })).toThrow(/listed options/);
    expect(() => parseWaitpointResponse("options", options, { selected: ["left", "right"] })).toThrow(/one option/);
  });

  it("requires a boolean approval for plan, credit, and media", () => {
    const plan = { summary: "Crop", steps: ["Crop"] };
    expect(parseWaitpointResponse("plan", plan, { approved: true })).toEqual({ approved: true });
    expect(() => parseWaitpointResponse("plan", plan, { approved: "yes" })).toThrow(/not valid/);
    expect(() => parseWaitpointResponse("unknown", plan, { approved: true })).toThrow(/not supported/);
  });
});

describe("live magica schema", () => {
  const schema = {
    type: "object",
    required: ["prompt", "uploadedImages"],
    properties: {
      prompt: { type: "string", maxLength: 10 },
      uploadedImages: { type: "array", minItems: 1, items: { type: "string", format: "uri" } },
      quality: { type: "string", enum: ["High", "Low"] },
      n: { type: "integer", minimum: 1, maximum: 4 },
    },
  };

  it("keeps known fields and drops unknown ones", () => {
    expect(conformToSchema({ prompt: "hi", uploadedImages: ["https://a.test/x.png"], extra: 1 }, schema)).toEqual({
      prompt: "hi",
      uploadedImages: ["https://a.test/x.png"],
    });
  });

  it("reports missing, out-of-range, and enum violations", () => {
    expect(() => conformToSchema({ prompt: "hi" }, schema)).toThrow(/uploadedImages/);
    expect(() => conformToSchema({ prompt: "hi", uploadedImages: ["https://a.test/x.png"], n: 9 }, schema)).toThrow(/n/);
    expect(conformToSchema({ prompt: "hi", uploadedImages: ["https://a.test/x.png"], quality: "Ultra" }, schema)).toEqual({
      prompt: "hi",
      uploadedImages: ["https://a.test/x.png"],
    });
    expect(conformToSchema({ prompt: "hi", uploadedImages: ["https://a.test/x.png"], quality: "high" }, schema)).toMatchObject({ quality: "High" });
    expect(() => conformToSchema({ prompt: "far too long a prompt", uploadedImages: ["ftp://x"] }, schema)).toThrow(/prompt, uploadedImages/);
  });
});

describe("magica field lists", () => {
  it("maps dataType, options, ranges, and list limits from the catalog shape", () => {
    // Field shapes copied from the public Magica catalog on 2026-10-10.
    const schema = schemaFromFields([
      { type: "textarea", dataType: "string", zodExpectedName: "prompt", required: true, max: 4000 },
      { type: "select", dataType: "string", zodExpectedName: "quality", options: [{ value: "High" }, { value: "Low" }] },
      { type: "composite-select", dataType: "string", zodExpectedName: "size", options: [{ value: "Custom" }, { value: "Auto" }], customValue: "Custom" },
      { type: "video", dataType: "string[]", zodExpectedName: "video_urls", required: true, maxItems: 100 },
      { type: "slider", dataType: "number", zodExpectedName: "x_percent", min: 0, max: 100 },
    ]);
    expect(schema.required).toEqual(["prompt", "video_urls"]);
    expect(schema.properties?.video_urls).toEqual({ type: "array", items: { type: "string" }, maxItems: 100 });
    expect(schema.properties?.quality?.enum).toEqual(["High", "Low"]);
    const live = schemaFromFields([
      { dataType: "string", name: "prompt", required: true },
      { dataType: "string", name: "quality", options: ["High", "Medium", "Low"] },
      { dataType: "string", name: "output_format", options: ["PNG", "JPEG", "WebP"] },
      { dataType: "number", name: "n", options: [1, 2, 3, 4] },
    ]);
    expect(live.properties?.quality?.enum).toEqual(["High", "Medium", "Low"]);
    expect(live.properties?.n?.enum).toEqual([1, 2, 3, 4]);
    expect(conformToSchema({ prompt: "A cute dog", quality: "standard", output_format: "png", size: "1024x1024" }, live)).toEqual({
      prompt: "A cute dog",
      output_format: "PNG",
    });
    expect(schema.properties?.size?.enum).toBeUndefined();
    expect(() => conformToSchema({ prompt: "x", video_urls: ["https://a.test/1.mp4", "https://a.test/2.mp4"], x_percent: 120 }, schema)).toThrow(/x_percent/);
    expect(conformToSchema({ prompt: "x", video_urls: ["https://a.test/1.mp4"], size: "1024x1024" }, schema)).toMatchObject({ size: "1024x1024" });
  });
});

describe("generated media", () => {
  it("collects every image, video, and audio URL once", () => {
    expect(
      generatedMedia({
        image_url: "https://cdn.test/a.png",
        image_urls: ["https://cdn.test/a.png", "https://cdn.test/b.png"],
        audio_url: "https://cdn.test/c.mp3",
      }),
    ).toEqual([
      { kind: "image", url: "https://cdn.test/a.png" },
      { kind: "image", url: "https://cdn.test/b.png" },
      { kind: "audio", url: "https://cdn.test/c.mp3" },
    ]);
    expect(mimeFromUrl("https://cdn.test/c.mp3?x=1", "audio")).toBe("audio/mpeg");
    expect(mimeFromUrl("https://cdn.test/file", "video")).toBe("video/*");
  });
});
