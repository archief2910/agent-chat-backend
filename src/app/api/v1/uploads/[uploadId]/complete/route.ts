import { completeAssemblyBodySchema } from "@/contracts";
import { requireUser } from "@/lib/auth";
import { getPrisma } from "@/lib/db";
import { json, readJson, route } from "@/lib/http";
import { presentAsset } from "@/server/assets";
import { uploadConfig } from "@/server/uploads/config";
import { applyAssemblyStatus, fetchAssemblyStatus } from "@/server/uploads/transloadit";
import { notFound } from "@/server/users";

export const dynamic = "force-dynamic";

/** The client reports an Assembly id; the server re-reads its status from Transloadit before trusting it. */
export const POST = route(async ({ request, params }) => {
  const user = await requireUser(request);
  const body = await readJson(request, completeAssemblyBodySchema);
  const prisma = getPrisma();
  const upload = await prisma.uploadAssembly.findFirst({ where: { id: params.uploadId ?? "", userId: user.id } });
  if (!upload) throw notFound("Upload not found.");
  const status = await fetchAssemblyStatus(body.assemblyId);
  if (status.fields?.uploadId !== upload.id) throw notFound("Upload not found.");
  const result = await applyAssemblyStatus(prisma, { status, config: uploadConfig(), expectedUserId: user.id });
  const assets = await prisma.asset.findMany({ where: { uploadId: upload.id, userId: user.id }, orderBy: { createdAt: "asc" } });
  return json({ ...result, assets: assets.map(presentAsset) });
});
