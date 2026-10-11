import pino from "pino";
import { currentContext } from "@/lib/trace";

export const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  base: undefined,
  redact: {
    paths: [
      "req.headers.authorization",
      "req.headers.cookie",
      "authorization",
      "apiKey",
      "accessToken",
      "*.authorization",
      "*.apiKey",
      "*.accessToken",
      "*.token",
    ],
    censor: "[redacted]",
  },
  mixin() {
    return currentContext() ?? {};
  },
});
