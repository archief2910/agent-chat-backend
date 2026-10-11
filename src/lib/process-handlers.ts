import { logger } from "@/lib/logger";

let installed = false;

export function installProcessHandlers(): void {
  if (installed) return;
  installed = true;
  process.on("unhandledRejection", (reason) => {
    logger.error({ err: reason }, "unhandled rejection");
  });
  process.on("uncaughtException", (error) => {
    logger.fatal({ err: error }, "uncaught exception");
  });
}
