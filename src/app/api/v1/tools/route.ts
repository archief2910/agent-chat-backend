import { z } from "zod";
import { toolDescriptorSchema } from "@/contracts";
import { requireUser } from "@/lib/auth";
import { getEnv } from "@/lib/env";
import { json, route } from "@/lib/http";
import { MagicaClient } from "@/server/magica/client";
import { getSkillRegistry } from "@/server/skills/registry";
import { createToolRegistry, describeTools } from "@/server/tools/registry";

export const dynamic = "force-dynamic";

export const GET = route(async ({ request }) => {
  await requireUser(request);
  const env = getEnv();
  const registry = createToolRegistry({
    skills: getSkillRegistry(),
    magica: new MagicaClient({ baseUrl: env.MAGICA_BASE_URL, apiKey: env.MAGICA_API_KEY }),
    sleep: async () => {},
  });
  return json({ tools: z.array(toolDescriptorSchema).parse(describeTools(registry)) });
});
