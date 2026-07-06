import type { ResolverResult } from "./types.js";

const METABOB_ENDPOINT = process.env["METABOB_ENDPOINT"] ?? "http://127.0.0.1:8080";
const METABOB_API_KEY = process.env["METABOB_API_KEY"] ?? "";

interface TraceTask {
  resolver_id?: string;
  output_shape?: string;
  status?: string;
}

interface ExecutionTrace {
  id?: string;
  status?: string;
  tasks?: TraceTask[];
  activity_id?: string;
}

interface TracesResponse {
  traces?: ExecutionTrace[];
  items?: ExecutionTrace[];
  data?: ExecutionTrace[];
}

function authHeaders(): Record<string, string> {
  const h: Record<string, string> = { "Content-Type": "application/json" };
  if (METABOB_API_KEY) h["Authorization"] = `ApiKey ${METABOB_API_KEY}`;
  return h;
}

async function fetchRecentSuccessfulTraces(): Promise<ExecutionTrace[]> {
  const url = `${METABOB_ENDPOINT}/v2/execution-traces?status=success&limit=50`;
  const res = await fetch(url, {
    headers: authHeaders(),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) return [];
  const body = (await res.json()) as any;
  const raw: unknown[] =
    (body as TracesResponse).traces ??
    (body as TracesResponse).items ??
    (body as TracesResponse).data ??
    (Array.isArray(body) ? (body as unknown[]) : []);
  return raw as ExecutionTrace[];
}

type PatternKey = string;

interface PatternEntry {
  count: number;
  activityIds: string[];
  resolverSteps: string[];
  shapeFlow: string[];
}

function buildPatternKey(trace: ExecutionTrace): PatternKey {
  const tasks = trace.tasks ?? [];
  const resolvers = tasks
    .map((t) => t.resolver_id ?? "unknown")
    .filter((r) => r !== "unknown");
  const shapes = tasks
    .map((t) => t.output_shape ?? "")
    .filter((s) => s.length > 0);
  return JSON.stringify({ resolvers, shapes });
}

function findDominantPattern(
  traces: ExecutionTrace[]
): PatternEntry & { key: PatternKey } {
  const multiTask = traces.filter(
    (t) => t.status === "success" && Array.isArray(t.tasks) && (t.tasks?.length ?? 0) > 1
  );

  const map = new Map<PatternKey, PatternEntry>();

  for (const trace of multiTask) {
    const key = buildPatternKey(trace);
    const existing = map.get(key);
    const tasks = trace.tasks ?? [];
    const resolverSteps = tasks
      .map((t) => t.resolver_id ?? "unknown")
      .filter((r) => r !== "unknown");
    const shapeFlow = tasks
      .map((t) => t.output_shape ?? "")
      .filter((s) => s.length > 0);
    const activityId = trace.activity_id ?? trace.id ?? "";
    if (existing) {
      existing.count += 1;
      if (activityId) existing.activityIds.push(activityId);
    } else {
      map.set(key, {
        count: 1,
        activityIds: activityId ? [activityId] : [],
        resolverSteps,
        shapeFlow,
      });
    }
  }

  let bestKey: PatternKey = "";
  let bestEntry: PatternEntry = { count: 0, activityIds: [], resolverSteps: [], shapeFlow: [] };

  for (const [k, v] of map.entries()) {
    if (v.count > bestEntry.count) {
      bestKey = k;
      bestEntry = v;
    }
  }

  return { key: bestKey, ...bestEntry };
}

function deriveConceptName(resolverSteps: string[], shapeFlow: string[]): string {
  const firstStep = resolverSteps[0] ?? "generic";
  const lastShape = shapeFlow[shapeFlow.length - 1] ?? "output";
  const camel = firstStep
    .split(/[_\-]/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join("");
  return `${camel}To${lastShape
    .split(/[_\-]/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join("")}Pattern`;
}

export async function resolveConceptFromTraces(
  _pointer: Record<string, unknown>
): Promise<ResolverResult> {
  const traces = await fetchRecentSuccessfulTraces();

  if (traces.length === 0) {
    return {
      shape: "concept",
      body: {
        name: "NoTracesAvailable",
        description:
          "No successful execution traces were found in the substrate. Cannot derive a recurring pattern concept.",
        activities: [],
        resolverSteps: [],
        shapeFlow: [],
        tracesSampled: 0,
        patternCount: 0,
      },
    };
  }

  const dominant = findDominantPattern(traces);
  const multiTaskSuccessful = traces.filter(
    (t) => t.status === "success" && (t.tasks?.length ?? 0) > 1
  ).length;

  const name = deriveConceptName(dominant.resolverSteps, dominant.shapeFlow);

  const description =
    dominant.count === 0
      ? `No recurring multi-task pattern detected across ${traces.length} sampled traces. All successful traces appear to be single-step.`
      : `Recurring execution pattern observed in ${dominant.count} of ${multiTaskSuccessful} successful multi-task traces. ` +
        `The pattern begins with resolver step(s) [${dominant.resolverSteps.slice(0, 3).join(", ")}] ` +
        `and produces shape flow [${dominant.shapeFlow.join(" → ")}]. ` +
        `This generalizes activities: ${dominant.activityIds.slice(0, 5).join(", ") || "(ids not available)"}. ` +
        `It represents a reusable composition topology the substrate executes frequently for this class of goal.`;

  return {
    shape: "concept",
    body: {
      name,
      description,
      activities: dominant.activityIds.slice(0, 10),
      resolverSteps: dominant.resolverSteps,
      shapeFlow: dominant.shapeFlow,
      tracesSampled: traces.length,
      patternCount: dominant.count,
    },
  };
}
