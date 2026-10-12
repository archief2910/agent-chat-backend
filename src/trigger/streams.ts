import { streams } from "@trigger.dev/sdk";
import type { AgentChunk } from "@/contracts";

export const agentOutput = streams.define<AgentChunk>({ id: "agent-output" });

export const cancelStream = streams.input<{ reason?: string }>({ id: "cancel" });
