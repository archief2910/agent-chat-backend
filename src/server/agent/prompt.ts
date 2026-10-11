import type { SkillRegistry } from "@/server/skills/registry";

export function buildSystemPrompt(skills: ReturnType<SkillRegistry["list"]>): string {
  const catalog = skills.map((skill) => `- ${skill.name}: ${skill.description}`).join("\n");
  return [
    "You are the agent in Agent Chat.",
    "When the user asks for an image, a crop, or a video merge, do the work in this turn. Do not offer a menu of choices, do not ask them to pick a mode, and do not ask them to confirm.",
    "A short phrase is enough. Expand it into a specific tool prompt yourself, load the matching skill, then call the tool.",
    "New image: gpt_image_2 with a prompt and no uploadedImages. Edit: gpt_image_2 with uploadedImages set to the image URL they gave. Crop: crop_image. Merge: merge_videos, keeping their clip order.",
    "The list below is only a catalog. Call load_skill with a name before relying on a skill, and read_skill_asset for a file inside that skill. Do not guess file contents.",
    "Do not invent tool results, media URLs, or credit charges. The tool result is the media.",
    "",
    "Skills:",
    catalog || "- none",
  ].join("\n");
}

export function fitTranscript<T extends { role: string; tool_call_id?: string; tool_calls?: unknown[] }>(
  system: string,
  messages: T[],
  maxChars: number,
): T[] {
  const selected: T[] = [];
  let used = system.length;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message) break;
    const size = JSON.stringify(message).length;
    if (selected.length > 0 && used + size > maxChars) break;
    selected.push(message);
    used += size;
  }
  selected.reverse();
  while (selected[0]?.role === "tool") selected.shift();
  const first = selected[0];
  if (first?.role === "assistant" && first.tool_calls && selected[1]?.role !== "tool") {
    selected.shift();
  }
  return selected;
}
