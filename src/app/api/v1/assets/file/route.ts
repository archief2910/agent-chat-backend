import { requireUser } from "@/lib/auth";
import { getPrisma } from "@/lib/db";
import { AppError } from "@/lib/errors";
import { route } from "@/lib/http";
import { notFound } from "@/server/users";

export const dynamic = "force-dynamic";

export const GET = route(async ({ request }) => {
  const user = await requireUser(request);
  const sourceUrl = new URL(request.url).searchParams.get("url");
  if (!sourceUrl || !/^https?:\/\//.test(sourceUrl)) {
    throw new AppError({ code: "VALIDATION_ERROR", status: 400, message: "The file address is missing.", retryable: false });
  }
  const asset = await getPrisma().asset.findFirst({ where: { userId: user.id, sourceUrl } });
  if (!asset?.sourceUrl) throw notFound("File not found.");
  const upstream = await fetch(asset.sourceUrl);
  if (!upstream.ok || !upstream.body) {
    throw new AppError({ code: "UPSTREAM", status: 502, message: "The file could not be downloaded.", retryable: true });
  }
  const name = (asset.originalName ?? "download").replace(/["\r\n]/g, "");
  return new Response(upstream.body, {
    headers: {
      "Content-Type": asset.mime || "application/octet-stream",
      "Content-Disposition": `attachment; filename="${name}"`,
    },
  });
});
