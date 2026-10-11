export type GeneratedMedia = { kind: "image" | "video" | "audio"; url: string };

const EXTENSION_MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
  mp4: "video/mp4",
  webm: "video/webm",
  mov: "video/quicktime",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  m4a: "audio/mp4",
  ogg: "audio/ogg",
};

export function generatedMedia(output: unknown): GeneratedMedia[] {
  if (!output || typeof output !== "object") return [];
  const record = output as Record<string, unknown>;
  const media: GeneratedMedia[] = [];
  for (const kind of ["image", "video", "audio"] as const) {
    const many = record[`${kind}_urls`];
    const one = record[`${kind}_url`];
    const urls = Array.isArray(many) ? many : typeof one === "string" ? [one] : [];
    for (const url of urls) {
      if (typeof url === "string" && /^https?:\/\//.test(url) && !media.some((item) => item.url === url)) {
        media.push({ kind, url });
      }
    }
  }
  return media;
}

/** Best effort from the URL path; the provider does not report a MIME type. */
export function mimeFromUrl(url: string, kind: GeneratedMedia["kind"]): string {
  const extension = new URL(url).pathname.split(".").pop()?.toLowerCase() ?? "";
  return EXTENSION_MIME[extension] ?? `${kind}/*`;
}
