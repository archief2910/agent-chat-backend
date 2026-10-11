import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

// Writes the backend Zod contracts into the frontend repo with a content hash, so a
// hand edit or a stale copy is detectable (`--check` exits 1 when they differ).
const source = path.resolve(import.meta.dirname, "../src/contracts/index.ts");
const target = path.resolve(process.argv.find((arg) => arg.startsWith("--out="))?.slice(6) ?? "../agent-chat-frontend/src/generated/contracts.ts");
const body = fs.readFileSync(source, "utf8");
const hash = createHash("sha256").update(body).digest("hex");
const output = `// Generated from agent-chat-backend/src/contracts/index.ts. Do not edit.\n// contracts-sha256: ${hash}\n${body}`;

if (process.argv.includes("--check")) {
  const current = fs.existsSync(target) ? fs.readFileSync(target, "utf8") : "";
  if (current !== output) {
    console.error(`Contracts are out of date: ${target}`);
    process.exit(1);
  }
  console.log("Contracts are up to date.");
} else {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, output);
  console.log(`Wrote ${target}`);
}
