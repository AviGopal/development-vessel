import type { ResolverResult } from "./types.js";

const METABOB_ENDPOINT = process.env["METABOB_ENDPOINT"] ?? "http://127.0.0.1:8080";
const METABOB_API_KEY = process.env["METABOB_API_KEY"] ?? "";
const CONCEPT_DB_ENDPOINT = process.env["CONCEPT_DB_ENDPOINT"] ?? "http://127.0.0.1:8260";

interface TraceTask {
  task_id?: string;
  resolver_id?: string;
  output_shape?: string;
  status?: string;
}

interface TraceRecord {
  id?: string;
  activity_id?: string;
  status?: string;
  tasks?: TraceTask[];
  created_at?: string;
}

interface ConceptPointer {
  type?: string;
  id?: string;
}

function buildAuthHeaders(extra: Record<string, string> = {}): Record<string, string> {
  const base: Record<string, string> = { ...extra };
  if (METABOB_API_KEY) {
    base["Authorization"] = `ApiKey ${METABOB_API_KEY}`;
  }
  return base;
}

/**
 * concept resolver: examines recent successful multi-task execution traces,
 * identifies the recurring task pattern they share (common resolver step
 * sequence and shape flow), and produces a concept summarizing that pattern.
 */
export async function resolveConcept(pointer: Record<string, unknown>): Promise<ResolverResult> {
  const signal = AbortSignal.timeout(30_000);

  // 1. Fetch recent execution traces (successful, multi-task)
  let traces: TraceRecord[] = [];
  try {
    const tracesResp = await fetch(
      `${METABOB_ENDPOINT}/v2/execution-traces?status=success&limit=50`,
      {
        headers: buildAuthHeaders({ "Content-Type": "application/json" }),
        signal,
      }
    );
    if (tracesResp.ok) {
      const body = (await tracesResp.json()) as unknown;
      const raw: unknown[] = Array.isArray(body)
        ? body
        : Array.isArray((body as Record<string, unknown>)?.["traces"])
        ? ((body as Record<string, unknown>)["traces"] as unknown[])
        : Array.isArray((body as Record<string, unknown>)?.["results"])
        ? ((body as Record<string, unknown>)["results"] as unknown[])
        : [];
      traces = raw.filter((t): t is TraceRecord => {
        if (typeof t !== "object" || t === null) return false;
        const rec = t as TraceRecord;
        return Array.isArray(rec.tasks) && (rec.tasks?.length ?? 0) > 1;
      });
    }
  } catch {
    // fall through with empty traces
  }

  // 2. Aggregate resolver-step sequences from traces
  const sequenceCounts = new Map<string, number>();
  const sequenceExamples = new Map<string, string[]>();

  for (const trace of traces) {
    const tasks = trace.tasks ?? [];
    if (tasks.length < 2) continue;
    const steps = tasks
      .map((t) => `${t.resolver_id ?? "unknown"}->${t.output_shape ?? "?"}`)
      .join(" | ");
    const prev = sequenceCounts.get(steps) ?? 0;
    sequenceCounts.set(steps, prev + 1);
    const examples = sequenceExamples.get(steps) ?? [];
    if (examples.length < 3) {
      examples.push(trace.activity_id ?? trace.id ?? "unknown");
    }
    sequenceExamples.set(steps, examples);
  }

  // 3. Find the most recurring pattern
  let topPattern = "";
  let topCount = 0;
  for (const [seq, count] of sequenceCounts) {
    if (count > topCount) {
      topCount = count;
      topPattern = seq;
    }
  }

  // 4. Parse the top pattern into structured steps
  const patternSteps = topPattern
    ? topPattern.split(" | ").map((step) => {
        const parts = step.split("->");
        return {
          resolver: parts[0] ?? "unknown",
          output_shape: parts[1] ?? "unknown",
        };
      })
    : [];

  // 5. Attempt to look up existing concept in concept-db for deduplication
  let existingConceptId: string | null = null;
  try {
    const searchResp = await fetch(
      `${CONCEPT_DB_ENDPOINT}/concepts/search?q=recurring+resolver+pattern&limit=5`,
      {
        headers: buildAuthHeaders(),
        signal: AbortSignal.timeout(10_000),
      }
    );
    if (searchResp.ok) {
      const body = (await searchResp.json()) as unknown;
      const results: unknown[] = Array.isArray(body)
        ? body
        : Array.isArray((body as Record<string, unknown>)?.["results"])
        ? ((body as Record<string, unknown>)["results"] as unknown[])
        : [];
      const found = results[0] ?? null;
      if (typeof found === "object" && found !== null) {
        const ptr = found as ConceptPointer;
        existingConceptId = ptr.id ?? null;
      }
    }
  } catch {
    // concept-db unavailable — proceed without deduplication
  }

  // 6. Build concept name and description from pattern
  const resolverNames = patternSteps
    .map((s) => s.resolver)
    .filter((r) => r !== "unknown")
    .slice(0, 4);
  const shapeNames = patternSteps
    .map((s) => s.output_shape)
    .filter((s) => s !== "unknown")
    .slice(0, 4);

  const patternName =
    resolverNames.length > 0
      ? resolverNames.map((r) => r.replace(/-/g, "_")).join("__")
      : "multi_step_resolver_flow";

  const patternLabel =
    resolverNames.length > 0
      ? resolverNames.join(" → ")
      : "(no dominant pattern found)";

  const description =
    topCount > 0
      ? `Recurring execution pattern observed ${topCount}x across recent successful traces. ` +
        `Resolver sequence: ${patternLabel}. ` +
        `Shape flow: ${shapeNames.join(" → ") || "(none)"}. ` +
        `Generalizes ${patternSteps.length} resolver steps into a reusable named pattern.`
      : "No dominant recurring pattern found in recent successful traces. " +
        "Insufficient trace data to generalize a concept.";

  const activities: string[] = [];
  const exs = sequenceExamples.get(topPattern);
  if (Array.isArray(exs)) {
    for (const ex of exs) {
      activities.push(ex);
    }
  }

  const report = {
    concept_name: patternName,
    label: patternLabel,
    description,
    occurrence_count: topCount,
    trace_count_analyzed: traces.length,
    resolver_steps: patternSteps,
    exemplar_activity_ids: activities,
    existing_concept_id: existingConceptId,
    all_pattern_frequencies: Object.fromEntries(
      [...sequenceCounts.entries()]
        .sort((a, b) => (b[1] ?? 0) - (a[1] ?? 0))
        .slice(0, 10)
        .map(([k, v]) => [k, v])
    ),
    pointer_type: (pointer["type"] as string | undefined) ?? "concept",
  };

  return { shape: "concept", body: report };
}

export async function resolveConceptFromTraces(pointer: Record<string, unknown>): Promise<ResolverResult> {
  return resolveConcept(pointer);
}