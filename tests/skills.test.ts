import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { Db } from "@/lib/db";
import { restoreRunSkills } from "@/server/agent/persistence";
import { createSkillRegistry, SkillAccessError, SkillManifestError, assertUniqueSkills, loadSkills, parseSkillFile, resolveSkillFile } from "@/server/skills/registry";
import { createToolRegistry, type ToolContext } from "@/server/tools/registry";
import type { MagicaClient } from "@/server/magica/client";

const root = path.resolve("agent-skills");

describe("skills", () => {
  it("loads the shipped skills with names and descriptions only in the catalog", () => {
    const skills = loadSkills(root);
    expect(skills.map((skill) => skill.name).sort()).toEqual(["image-cropping", "image-generation", "video-merging"]);
    const cropping = skills.find((skill) => skill.name === "image-cropping");
    expect(cropping?.description).toContain("complete crop rectangle");
    expect(cropping?.body).toContain("Do not mix the three forms");
  });

  it("rejects malformed frontmatter, duplicate names, and unknown files", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "skills-"));
    fs.mkdirSync(path.join(dir, "alpha"));
    fs.writeFileSync(path.join(dir, "alpha", "SKILL.md"), "hello");
    expect(() => loadSkills(dir)).toThrow(SkillManifestError);

    expect(() => parseSkillFile("---\nname: other\ndescription: A skill\n---\nBody\n", "alpha")).toThrow(/must match/);
    expect(() => assertUniqueSkills(["image-cropping", "image-cropping"])).toThrow(/Duplicate skill name/);
  });

  it("rejects traversal, absolute paths, encoded traversal, and unsupported types", () => {
    const skillDir = path.join(root, "image-cropping");
    expect(() => resolveSkillFile(skillDir, "../image-generation/SKILL.md")).toThrow(/escapes/);
    expect(() => resolveSkillFile(skillDir, path.resolve(root, "image-generation/SKILL.md"))).toThrow(/Unsupported path/);
    expect(() => resolveSkillFile(skillDir, "..%2Fimage-generation%2FSKILL.md")).toThrow(/escapes/);
    fs.writeFileSync(path.join(skillDir, "notes.exe"), "nope");
    expect(() => resolveSkillFile(skillDir, "notes.exe")).toThrow(/Unsupported file type/);
    fs.unlinkSync(path.join(skillDir, "notes.exe"));
    expect(resolveSkillFile(skillDir, "examples/rectangles.md")).toContain("rectangles.md");
  });

  it("exposes only names and descriptions, and rejects an unknown skill", async () => {
    const registry = createSkillRegistry(root);
    expect(registry.list().every((skill) => Object.keys(skill).sort().join() === "description,name")).toBe(true);
    expect(registry.get("not-a-skill")).toBeNull();
    const tool = createToolRegistry({ skills: registry, magica: {} as MagicaClient, sleep: async () => {} }).get("load_skill");
    const result = await tool?.execute({ name: "not-a-skill" }, skillContext(null, async () => {}));
    expect(result).toEqual({ ok: false, error: "Unknown skill: not-a-skill" });
    expect(() => registry.readAsset("not-a-skill", "SKILL.md")).toThrow(SkillAccessError);
  });

  it("records a skill once and reuses the restored copy", async () => {
    const registry = createSkillRegistry(root);
    const skill = registry.get("image-cropping");
    if (!skill) throw new Error("missing skill");
    const tool = createToolRegistry({ skills: registry, magica: {} as MagicaClient, sleep: async () => {} }).get("load_skill");
    let records = 0;
    await tool?.execute({ name: skill.name }, skillContext(null, async () => { records += 1; }));
    const restored = { name: skill.name, hash: skill.hash, body: skill.body };
    await tool?.execute({ name: skill.name }, skillContext(restored, async () => { records += 1; }));
    expect(records).toBe(1);
    const resumed = await restoreRunSkills({
      runSkill: {
        findMany: async () => [{ name: skill.name, hash: skill.hash, snapshot: { body: skill.body } }],
      },
    } as unknown as Db, "run_1");
    expect(resumed).toEqual([restored]);
  });
});

function skillContext(loaded: { name: string; hash: string; body: string } | null, recordSkill: ToolContext["recordSkill"]): ToolContext {
  return {
    runId: "run_1",
    chatId: "chat_1",
    userId: "user_1",
    toolCallId: "call_1",
    signal: new AbortController().signal,
    recordSkill,
    loadedSkill: () => loaded,
    rememberExternalRun: async () => {},
    waitForUser: async () => ({ status: "cancelled" }),
  };
}
