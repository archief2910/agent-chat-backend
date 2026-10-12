import { randomBytes } from "node:crypto";
import { hashApiKey } from "@/lib/auth";
import { getPrisma } from "@/lib/db";
import { notFound } from "@/server/users";

export async function createApiKey(userId: string, name: string) {
  const secret = randomBytes(24).toString("base64url");
  const token = `ak_${secret}`;
  const prefix = token.slice(0, 11);
  const key = await getPrisma().apiKey.create({
    data: { userId, name, prefix, hash: hashApiKey(token) },
  });
  return { id: key.id, name: key.name, prefix: key.prefix, key: token, createdAt: key.createdAt.toISOString() };
}

export async function listApiKeys(userId: string) {
  const keys = await getPrisma().apiKey.findMany({
    where: { userId, revokedAt: null },
    orderBy: { createdAt: "desc" },
    take: 50,
  });
  return keys.map((key) => ({ id: key.id, name: key.name, prefix: key.prefix, createdAt: key.createdAt.toISOString() }));
}

export async function revokeApiKey(userId: string, id: string) {
  const result = await getPrisma().apiKey.updateMany({
    where: { id, userId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
  if (result.count === 0) throw notFound("API key not found.");
}
