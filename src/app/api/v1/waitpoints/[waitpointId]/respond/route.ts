import { wait } from "@trigger.dev/sdk";
import { waitpointRespondBodySchema } from "@/contracts";
import { requireUser } from "@/lib/auth";
import { getPrisma } from "@/lib/db";
import { json, readJson, route } from "@/lib/http";
import { respondToWaitpoint } from "@/server/waitpoints/service";

export const dynamic = "force-dynamic";

export const POST = route(async ({ request, params }) => {
  const user = await requireUser(request);
  const body = await readJson(request, waitpointRespondBodySchema);
  const result = await respondToWaitpoint(
    getPrisma(),
    { userId: user.id, waitpointId: params.waitpointId ?? "", response: body.response },
    async (tokenId, data) => {
      await wait.completeToken(tokenId, data);
    },
  );
  return json(result);
});
