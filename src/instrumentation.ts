export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { installProcessHandlers } = await import("@/lib/process-handlers");
    installProcessHandlers();
  }
}
