import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";

const MAX_SKILL_BYTES = 64 * 1024;
const MAX_ASSET_BYTES = 256 * 1024;
const ALLOWED_EXTENSIONS = new Set([".md", ".txt", ".json", ".png", ".jpg", ".jpeg", ".webp"]);

const frontmatterSchema = z.object({
  name: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  description: z.string().trim().min(1).max(400),
});

export class SkillManifestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SkillManifestError";
  }
}

export class SkillAccessError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SkillAccessError";
  }
}

export type SkillRecord = {
  name: string;
  description: string;
  body: string;
  hash: string;
  directory: string;
};

export function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

export function parseSkillFile(source: string, directoryName: string): Omit<SkillRecord, "directory"> {
  if (Buffer.byteLength(source) > MAX_SKILL_BYTES) {
    throw new SkillManifestError(`${directoryName}: SKILL.md is too large`);
  }
  const match = source.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  const raw = match?.[1];
  const body = match?.[2];
  if (!raw || body === undefined) throw new SkillManifestError(`${directoryName}: missing YAML frontmatter`);
  const data: Record<string, string> = {};
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const separator = line.indexOf(":");
    if (separator === -1) throw new SkillManifestError(`${directoryName}: invalid frontmatter`);
    const key = line.slice(0, separator).trim();
    let value = line.slice(separator + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    data[key] = value;
  }
  const parsed = frontmatterSchema.safeParse(data);
  if (!parsed.success) throw new SkillManifestError(`${directoryName}: invalid skill frontmatter`);
  if (parsed.data.name !== directoryName) {
    throw new SkillManifestError(`${directoryName}: frontmatter name must match the directory`);
  }
  return {
    name: parsed.data.name,
    description: parsed.data.description,
    body: body.trim(),
    hash: sha256(source),
  };
}

export function assertUniqueSkills(names: string[]): void {
  const seen = new Set<string>();
  for (const name of names) {
    if (seen.has(name)) throw new SkillManifestError(`Duplicate skill name: ${name}`);
    seen.add(name);
  }
}

export function loadSkills(root: string): SkillRecord[] {
  if (!fs.existsSync(root)) throw new SkillManifestError(`Skill directory not found: ${root}`);
  const names = new Set<string>();
  const skills: SkillRecord[] = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const filePath = path.join(root, entry.name, "SKILL.md");
    if (!fs.existsSync(filePath)) throw new SkillManifestError(`${entry.name}: SKILL.md is missing`);
    const parsed = parseSkillFile(fs.readFileSync(filePath, "utf8"), entry.name);
    if (names.has(parsed.name)) throw new SkillManifestError(`Duplicate skill name: ${parsed.name}`);
    names.add(parsed.name);
    skills.push({ ...parsed, directory: path.join(root, entry.name) });
  }
  assertUniqueSkills(skills.map((skill) => skill.name));
  skills.sort((a, b) => a.name.localeCompare(b.name));
  return skills;
}

export function resolveSkillFile(skillDirectory: string, relativePath: string): string {
  if (relativePath.includes("\0")) throw new SkillAccessError("Unsupported path");
  let decoded = relativePath;
  try {
    decoded = decodeURIComponent(relativePath);
  } catch {
    throw new SkillAccessError("Unsupported path");
  }
  if (decoded.includes("\0") || path.posix.isAbsolute(decoded) || path.win32.isAbsolute(decoded)) {
    throw new SkillAccessError("Unsupported path");
  }
  const root = fs.realpathSync(skillDirectory);
  const candidate = path.resolve(root, decoded);
  if (!fs.existsSync(candidate)) throw new SkillAccessError("File not found");
  const real = fs.realpathSync(candidate);
  const relative = path.relative(root, real);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new SkillAccessError("Path escapes the skill directory");
  }
  const extension = path.extname(real).toLowerCase();
  if (!ALLOWED_EXTENSIONS.has(extension)) throw new SkillAccessError("Unsupported file type");
  const stat = fs.statSync(real);
  if (!stat.isFile() || stat.size > MAX_ASSET_BYTES) throw new SkillAccessError("File is too large or not a file");
  return real;
}

export function defaultSkillsRoot(): string {
  const fromHere = path.resolve(import.meta.dirname, "../../../agent-skills");
  if (fs.existsSync(fromHere)) return fromHere;
  return path.resolve(process.cwd(), "agent-skills");
}

export function createSkillRegistry(root = defaultSkillsRoot()) {
  const skills = loadSkills(root);
  const byName = new Map(skills.map((skill) => [skill.name, skill]));
  return {
    list: () => skills.map(({ name, description }) => ({ name, description })),
    get: (name: string) => byName.get(name) ?? null,
    readAsset: (name: string, relativePath: string) => {
      const skill = byName.get(name);
      if (!skill) throw new SkillAccessError("Unknown skill");
      const filePath = resolveSkillFile(skill.directory, relativePath);
      const extension = path.extname(filePath).toLowerCase();
      const binary = extension !== ".md" && extension !== ".txt" && extension !== ".json";
      return {
        path: relativePath,
        mime: mimeFor(extension),
        text: binary ? null : fs.readFileSync(filePath, "utf8"),
        base64: binary ? fs.readFileSync(filePath).toString("base64") : null,
      };
    },
  };
}

function mimeFor(extension: string): string {
  switch (extension) {
    case ".md":
      return "text/markdown";
    case ".txt":
      return "text/plain";
    case ".json":
      return "application/json";
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".webp":
      return "image/webp";
    default:
      return "application/octet-stream";
  }
}

export type SkillRegistry = ReturnType<typeof createSkillRegistry>;

let shared: SkillRegistry | undefined;

/** Scanned once per process; a malformed skill fails startup instead of a live turn. */
export function getSkillRegistry(): SkillRegistry {
  shared ??= createSkillRegistry();
  return shared;
}
