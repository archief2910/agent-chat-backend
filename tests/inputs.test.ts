import { describe, expect, it } from "vitest";
import { cropInputSchema, mergeVideosInputSchema } from "@/server/magica/inputs";

describe("crop input", () => {
  it("accepts one complete rectangle in each form", () => {
    expect(cropInputSchema.parse({ image_url: "https://cdn.example/a.png", x_percent: 0, y_percent: 0, width_percent: 50, height_percent: 100 }).width_percent).toBe(50);
    expect(cropInputSchema.parse({ image_url: "https://cdn.example/a.png", width_px: 200, height_px: 100 }).height_px).toBe(100);
    expect(cropInputSchema.parse({ image_url: "https://cdn.example/a.png", crop: { x: 1, y: 2, width: 3, height: 4 } }).crop?.width).toBe(3);
  });

  it("rejects partial, mixed, and empty rectangles", () => {
    expect(cropInputSchema.safeParse({ image_url: "https://cdn.example/a.png", x_percent: 10 }).success).toBe(false);
    expect(cropInputSchema.safeParse({ image_url: "https://cdn.example/a.png", width_px: 10 }).success).toBe(false);
    expect(cropInputSchema.safeParse({ image_url: "https://cdn.example/a.png", x_percent: 0, y_percent: 0, width_percent: 10, height_percent: 10, width_px: 5, height_px: 5 }).success).toBe(false);
    expect(cropInputSchema.safeParse({ image_url: "https://cdn.example/a.png" }).success).toBe(false);
    expect(cropInputSchema.safeParse({ image_url: "file:///tmp/a.png", x_percent: 0, y_percent: 0, width_percent: 10, height_percent: 10 }).success).toBe(false);
  });
});

describe("merge input", () => {
  it("keeps video order and defaults the transition", () => {
    const parsed = mergeVideosInputSchema.parse({
      video_urls: ["https://cdn.example/b.mp4", "https://cdn.example/a.mp4"],
    });
    expect(parsed.video_urls).toEqual(["https://cdn.example/b.mp4", "https://cdn.example/a.mp4"]);
    expect(parsed.transition).toBe("none");
  });

  it("rejects one video and an unknown transition", () => {
    expect(mergeVideosInputSchema.safeParse({ video_urls: ["https://cdn.example/a.mp4"] }).success).toBe(false);
    expect(mergeVideosInputSchema.safeParse({ video_urls: ["https://cdn.example/a.mp4", "https://cdn.example/b.mp4"], transition: "wipe" }).success).toBe(false);
  });
});
