import { createHash } from "node:crypto";
import { AppError } from "@/lib/errors";
import { getEnv } from "@/lib/env";
import { getPrisma } from "@/lib/db";
import { upsertUser } from "@/server/users";

const unauthenticated = new AppError({
  code: "UNAUTHENTICATED",
  status: 401,
  message: "Sign in to continue.",
});

export function hashApiKey(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export async function requireUser(request: Request) {
  const header = request.headers.get("authorization");
  if (!header?.startsWith("Bearer ")) throw unauthenticated;
  const token = header.slice("Bearer ".length).trim();
  if (token.startsWith("ak_")) {
    const key = await getPrisma().apiKey.findUnique({
      where: { hash: hashApiKey(token) },
      include: { user: true },
    });
    if (!key || key.revokedAt) throw unauthenticated;
    return key.user;
  }
  const { createClerkClient } = await import("@clerk/backend");
  const env = getEnv();
  const client = createClerkClient({
    secretKey: env.CLERK_SECRET_KEY,
    publishableKey: env.CLERK_PUBLISHABLE_KEY,
  });
  const state = await client.authenticateRequest(request, {
    authorizedParties: [env.FRONTEND_ORIGIN],
    ...(env.CLERK_JWT_KEY ? { jwtKey: env.CLERK_JWT_KEY } : {}),
  });
  if (!state.isAuthenticated) {
    throw new AppError({
      code: "UNAUTHENTICATED",
      status: 401,
      message: "Sign in to continue.",
    });
  }
  const auth = state.toAuth();
  if (!auth?.userId) {
    throw new AppError({
      code: "UNAUTHENTICATED",
      status: 401,
      message: "Sign in to continue.",
    });
  }
  return upsertUser(auth.userId);
}
