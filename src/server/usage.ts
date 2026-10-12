import { formatCredits } from "@/server/credits";
import { getPrisma } from "@/lib/db";
import { notFound } from "@/server/users";

/** Magica's usage page keeps charges before this date on Usage Old. */
export const USAGE_OLD_CUTOFF = new Date("2026-08-13T00:00:00.000Z");

const MEDIA_TOOLS = new Set(["gpt_image_2", "crop_image", "merge_videos"]);

const TOOL_LABELS: Record<string, string> = {
  gpt_image_2: "AI Gpt Image 2",
  crop_image: "AI Crop Image",
  merge_videos: "AI Merge Videos",
};

export type UsagePeriodId = "current" | "previous" | "older";

export function periodRange(period: UsagePeriodId, now: Date): { from: Date; to: Date } {
  if (period === "older") return { from: new Date(0), to: new Date(USAGE_OLD_CUTOFF.getTime() - 1) };
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth();
  if (period === "previous") {
    return {
      from: new Date(Date.UTC(year, month - 1, 1)),
      to: new Date(Date.UTC(year, month, 0, 23, 59, 59, 999)),
    };
  }
  return { from: new Date(Date.UTC(year, month, 1)), to: now };
}

export function usageToolName(name: string): string {
  return TOOL_LABELS[name] ?? name.replaceAll("_", " ");
}

type CaptureInput = { amount: bigint; toolInvocationId: string | null; createdAt: Date };
type RunInput = { id: string; createdAt: Date; captures: CaptureInput[] };
type ToolInput = { id: string; name: string; createdAt: Date; chargedMicrocredits: bigint };

type Execution = {
  id: string;
  debitedMicrocredits: string;
  createdAt: string;
  steps: Array<{ name: string; createdAt: string; debitedMicrocredits: string }>;
};

function slug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function sum(values: bigint[]): bigint {
  return values.reduce((total, value) => total + value, 0n);
}

export function buildUsage(input: {
  period: UsagePeriodId;
  from: Date;
  to: Date;
  runs: RunInput[];
  tools: ToolInput[];
}): {
  period: { id: UsagePeriodId; from: string; to: string };
  totals: { debitedMicrocredits: string; executions: number; categories: number };
  categories: Array<{
    id: string;
    name: string;
    debitedMicrocredits: string;
    executions: number;
    latestUsageAt: string | null;
    rows: Execution[];
  }>;
} {
  const groups = new Map<string, { name: string; rows: Array<Execution & { amount: bigint; at: number }> }>();
  function add(name: string, row: Execution & { amount: bigint; at: number }) {
    const current = groups.get(name) ?? { name, rows: [] };
    current.rows.push(row);
    groups.set(name, current);
  }

  for (const run of input.runs) {
    const own = run.captures.filter((capture) => capture.toolInvocationId === null);
    const amount = sum(own.map((capture) => capture.amount));
    const at = own[0]?.createdAt ?? run.createdAt;
    add("AI Agent Chat", {
      id: run.id,
      amount,
      at: at.getTime(),
      debitedMicrocredits: amount.toString(),
      createdAt: at.toISOString(),
      steps: [{ name: "AI LLM Admission Reservation", createdAt: at.toISOString(), debitedMicrocredits: amount.toString() }],
    });
  }

  for (const tool of input.tools) {
    if (!MEDIA_TOOLS.has(tool.name) && tool.chargedMicrocredits <= 0n) continue;
    const name = usageToolName(tool.name);
    add(name, {
      id: tool.id,
      amount: tool.chargedMicrocredits,
      at: tool.createdAt.getTime(),
      debitedMicrocredits: tool.chargedMicrocredits.toString(),
      createdAt: tool.createdAt.toISOString(),
      steps: [{ name, createdAt: tool.createdAt.toISOString(), debitedMicrocredits: tool.chargedMicrocredits.toString() }],
    });
  }

  const categories = [...groups.values()]
    .map((group) => {
      const rows = [...group.rows].sort((left, right) => right.at - left.at || right.id.localeCompare(left.id));
      const latest = rows[0];
      return {
        id: slug(group.name),
        name: group.name,
        debitedMicrocredits: sum(rows.map((row) => row.amount)).toString(),
        executions: rows.length,
        latestUsageAt: latest ? latest.createdAt : null,
        rows: rows.map((row) => ({
          id: row.id,
          debitedMicrocredits: row.debitedMicrocredits,
          createdAt: row.createdAt,
          steps: row.steps,
        })),
      };
    })
    .sort((left, right) => {
      const leftTime = left.latestUsageAt ? new Date(left.latestUsageAt).getTime() : 0;
      const rightTime = right.latestUsageAt ? new Date(right.latestUsageAt).getTime() : 0;
      return rightTime - leftTime || left.name.localeCompare(right.name);
    });

  return {
    period: { id: input.period, from: input.from.toISOString(), to: input.to.toISOString() },
    totals: {
      debitedMicrocredits: sum(categories.map((category) => BigInt(category.debitedMicrocredits))).toString(),
      executions: categories.reduce((total, category) => total + category.executions, 0),
      categories: categories.length,
    },
    categories,
  };
}

export async function getUsage(userId: string, period: UsagePeriodId, now = new Date()) {
  const range = periodRange(period, now);
  const prisma = getPrisma();
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) throw notFound("Account not found.");
  const createdAt = { gte: range.from, lte: range.to };
  const [runs, direct] = await Promise.all([
    prisma.agentRun.findMany({
      where: { userId, createdAt },
      orderBy: { createdAt: "desc" },
      take: 200,
      include: {
        ledger: { where: { type: "capture" }, select: { amount: true, toolInvocationId: true, createdAt: true } },
        tools: { select: { id: true, name: true, createdAt: true, chargedMicrocredits: true } },
      },
    }),
    prisma.directToolRun.findMany({
      where: { userId, createdAt },
      orderBy: { createdAt: "desc" },
      take: 200,
      select: { id: true, name: true, createdAt: true, chargedMicrocredits: true },
    }),
  ]);
  return {
    balanceMicrocredits: user.creditBalance.toString(),
    credits: formatCredits(user.creditBalance),
    ...buildUsage({
      period,
      from: range.from,
      to: range.to,
      runs: runs.map((run) => ({
        id: run.id,
        createdAt: run.createdAt,
        captures: run.ledger,
      })),
      tools: [...runs.flatMap((run) => run.tools), ...direct],
    }),
  };
}
