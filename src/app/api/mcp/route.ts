import { requireUser } from "@/lib/auth";
import { json, route } from "@/lib/http";
import { getEnv } from "@/lib/env";
import { MagicaClient } from "@/server/magica/client";
import { getSkillRegistry } from "@/server/skills/registry";
import { startDirectToolRun } from "@/server/direct-tools";
import { createToolRegistry } from "@/server/tools/registry";

export const dynamic = "force-dynamic";

const TOOLS = new Set(["crop_image", "gpt_image_2", "merge_videos"]);

type Rpc = { jsonrpc?: string; id?: string | number | null; method?: string; params?: Record<string, unknown> };

/** Optional MCP endpoint. Bearer auth. tools/call starts a durable Magica run and returns its id. */
export const POST = route(async ({ request }) => {
  const body = (await request.json()) as Rpc;
  const id = body.id ?? null;
  if (body.method === "initialize") {
    return json({
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: "2025-03-26",
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "agent-chat", version: "0.1.0" },
      },
    });
  }
  if (body.method === "notifications/initialized") {
    return new Response(null, { status: 202 });
  }
  const user = await requireUser(request);
  if (body.method === "tools/list") {
    const env = getEnv();
    const registry = createToolRegistry({
      skills: getSkillRegistry(),
      magica: new MagicaClient({ baseUrl: env.MAGICA_BASE_URL, apiKey: env.MAGICA_API_KEY }),
      sleep: async () => {},
    });
    const tools = registry.list().filter((tool) => TOOLS.has(tool.name));
    return json({
      jsonrpc: "2.0",
      id,
      result: {
        tools: await Promise.all(
          tools.map(async (tool) => ({
            name: tool.name,
            description: tool.description,
            inputSchema: await tool.parameters(),
          })),
        ),
      },
    });
  }
  if (body.method === "tools/call") {
    const params = body.params ?? {};
    const name = typeof params.name === "string" ? params.name : "";
    const run = await startDirectToolRun({
      userId: user.id,
      name,
      toolInput: params.arguments ?? {},
      clientRequestId: typeof params.clientRequestId === "string" ? params.clientRequestId : crypto.randomUUID(),
    });
    return json({
      jsonrpc: "2.0",
      id,
      result: { content: [{ type: "text", text: JSON.stringify(run) }], isError: false },
    });
  }
  return json({ jsonrpc: "2.0", id, error: { code: -32601, message: "Method not found" } });
});
