import { AsyncLocalStorage } from "node:async_hooks";

export type RequestContext = {
  traceId: string;
  chatId?: string;
  runId?: string;
  messageId?: string;
  processId?: string;
  waitpointTokenId?: string;
};

export const requestContext = new AsyncLocalStorage<RequestContext>();

export function runWithContext<T>(context: RequestContext, fn: () => T): T {
  return requestContext.run(context, fn);
}

export function currentContext(): RequestContext | undefined {
  return requestContext.getStore();
}

export function extendContext(patch: Partial<RequestContext>): RequestContext {
  const current = currentContext();
  return { traceId: current?.traceId ?? "unknown", ...current, ...patch };
}
