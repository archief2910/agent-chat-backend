import { getPrisma } from "@/lib/db";
import { AppError } from "@/lib/errors";
import { json, route } from "@/lib/http";
import { uploadConfig } from "@/server/uploads/config";
import { applyAssemblyStatus, parseAssemblyStatus, verifyNotification } from "@/server/uploads/transloadit";

export const dynamic = "force-dynamic";

/** Transloadit webhook. No user session; the HMAC signature is the authentication. */
export const POST = route(async ({ request }) => {
  const config = uploadConfig();
  const form = await request.formData();
  const raw = form.get("transloadit");
  const signature = form.get("signature");
  if (typeof raw !== "string" || typeof signature !== "string") {
    throw new AppError({ code: "VALIDATION_ERROR", status: 400, message: "Missing notification fields." });
  }
  if (!verifyNotification(raw, signature, config.authSecret)) {
    throw new AppError({ code: "FORBIDDEN", status: 403, message: "Invalid signature." });
  }
  const status = parseAssemblyStatus(JSON.parse(raw) as unknown);
  const result = await applyAssemblyStatus(getPrisma(), { status, config });
  return json({ ok: true, status: result.status });
});
