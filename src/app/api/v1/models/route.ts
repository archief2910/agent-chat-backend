import { modelStatusSchema } from "@/contracts";
import { requireUser } from "@/lib/auth";
import { getEnv } from "@/lib/env";
import { json, route } from "@/lib/http";

export const dynamic = "force-dynamic";

export const GET = route(async ({ request }) => {
  await requireUser(request);
  const env = getEnv();
  return json(
    modelStatusSchema.parse({
      model: env.OPENROUTER_MODEL,
      status: "configured",
      paidFallback: false,
    }),
  );
});
