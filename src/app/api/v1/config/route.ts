import { getEnv } from "@/lib/env";
import { json, route } from "@/lib/http";
import { formatCredits } from "@/server/credits";
import { ALLOWED_UPLOAD_MIME } from "@/server/uploads/transloadit";

export const dynamic = "force-dynamic";

export const GET = route(async () => {
  const env = getEnv();
  const admission = BigInt(env.CREDIT_ADMISSION_MICROCREDITS);
  return json({
    model: env.OPENROUTER_MODEL,
    maxMessageChars: env.MAX_MESSAGE_CHARS,
    admissionMicrocredits: admission.toString(),
    admissionCredits: formatCredits(admission),
    uploads: {
      enabled: Boolean(env.TRANSLOADIT_AUTH_KEY && env.TRANSLOADIT_AUTH_SECRET && env.TRANSLOADIT_TEMPLATE_ID),
      maxFiles: env.UPLOAD_MAX_FILES,
      maxFileBytes: env.UPLOAD_MAX_FILE_BYTES,
      monthlyBytes: env.UPLOAD_MONTHLY_BYTES,
      allowedMime: ALLOWED_UPLOAD_MIME.source,
    },
    waitpointTimeoutMinutes: env.WAITPOINT_TIMEOUT_MINUTES,
  });
});
