import { json, route } from "@/lib/http";
import { getPrisma } from "@/lib/db";

export const dynamic = "force-dynamic";

export const GET = route(async () => {
  try {
    await getPrisma().$queryRaw`SELECT 1`;
    return json({ ok: true, database: "up" });
  } catch {
    return json({ ok: false, database: "down" }, 503);
  }
});
