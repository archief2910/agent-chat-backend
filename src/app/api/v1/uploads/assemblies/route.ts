import { createAssemblyBodySchema, createAssemblyResponseSchema } from "@/contracts";
import { requireUser } from "@/lib/auth";
import { getPrisma } from "@/lib/db";
import { json, readJson, route } from "@/lib/http";
import { uploadConfig } from "@/server/uploads/config";
import { createUpload } from "@/server/uploads/transloadit";

export const dynamic = "force-dynamic";

export const POST = route(async ({ request }) => {
  const user = await requireUser(request);
  const body = await readJson(request, createAssemblyBodySchema);
  const signed = await createUpload(getPrisma(), { userId: user.id, files: body.files, config: uploadConfig() });
  return json(createAssemblyResponseSchema.parse(signed), 201);
});
