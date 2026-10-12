import type { Asset } from "@/generated/prisma/client";
import { getPrisma } from "@/lib/db";
import { decodeCursor, encodeCursor, pageLimit } from "@/server/pagination";

export function presentAsset(asset: Asset) {
  return {
    id: asset.id,
    kind: asset.kind,
    source: asset.source,
    mime: asset.mime,
    bytes: asset.bytes?.toString() ?? null,
    originalName: asset.originalName,
    url: asset.sourceUrl,
    isTemporaryUrl: asset.isTemporaryUrl,
    createdAt: asset.createdAt.toISOString(),
  };
}

export async function listAssets(userId: string, query: { cursor?: string; limit?: number }) {
  const limit = pageLimit(query.limit);
  const cursor = query.cursor ? decodeCursor(query.cursor) : undefined;
  const rows = await getPrisma().asset.findMany({
    where: {
      userId,
      ...(cursor ? { OR: [{ createdAt: { lt: cursor.at } }, { createdAt: cursor.at, id: { lt: cursor.id } }] } : {}),
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: limit + 1,
  });
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const last = page.at(-1);
  return {
    assets: page.map(presentAsset),
    nextCursor: hasMore && last ? encodeCursor(last.createdAt, last.id) : null,
  };
}
