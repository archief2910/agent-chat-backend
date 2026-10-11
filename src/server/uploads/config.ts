import { getEnv } from "@/lib/env";
import { AppError } from "@/lib/errors";
import type { UploadConfig } from "@/server/uploads/transloadit";

export function uploadConfig(): UploadConfig {
  const env = getEnv();
  if (!env.TRANSLOADIT_AUTH_KEY || !env.TRANSLOADIT_AUTH_SECRET || !env.TRANSLOADIT_TEMPLATE_ID) {
    throw new AppError({
      code: "UPLOADS_UNAVAILABLE",
      status: 503,
      message: "Uploads are not configured on this server.",
      retryable: false,
    });
  }
  return {
    authKey: env.TRANSLOADIT_AUTH_KEY,
    authSecret: env.TRANSLOADIT_AUTH_SECRET,
    templateId: env.TRANSLOADIT_TEMPLATE_ID,
    notifyUrl: env.TRANSLOADIT_NOTIFY_URL ?? `${env.APP_BASE_URL}/api/v1/uploads/notify`,
    ...(env.TRANSLOADIT_RESULT_STEP ? { resultStep: env.TRANSLOADIT_RESULT_STEP } : {}),
    monthlyBytes: BigInt(env.UPLOAD_MONTHLY_BYTES),
    maxFileBytes: env.UPLOAD_MAX_FILE_BYTES,
    maxFiles: env.UPLOAD_MAX_FILES,
  };
}
