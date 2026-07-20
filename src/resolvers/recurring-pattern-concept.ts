import type { ResolverResult } from "./types.js";

export interface RecurringPatternPointer {
  type: "recurringPatternConcept";
  limit?: number;
}

async function fetchTraces(limit: number): Promise<any[]> {
  const endpoint = process.env["METABOB_ENDPOINT"] ?? "http://127.0.0.1:8080";
  const apiKey = process.env["METABOB_API_KEY"] ?? "";
  const res = await fetch(`${endpoint}/v2/traces?outcome=success&limit=${limit}`, {
    headers: apiKey ? { Authorization: `ApiKey ${apiKey}` } : {},
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) return [];
  const json = (await res.json()) as any;
  const traces = json?.traces ?? json?.data ?? [];
  if (!Array.isArray(traces)) return [];
  return traces;
}

function extractSteps(trace: any): string[] {
  const steps = trace?.steps ?? trace?.resolver_steps ?? trace?.activities ?? [];
  if (!Array.isArray(steps)) return [];
  const out: string[] = [];
  for (const s of steps) {
    const name = s?.shape ?? s?.type ?? s?.name;
    if (typeof name === "string") out.push(name);
  }
  return out;
}

function commonPrefixSequences(sequences: string[][]): string[] {
  if (sequences.length === 0) return [];
  const minLen = sequences.reduce((m, s) => Math.min(m, s.length), sequences[0]?.length ?? 0);
  const prefix: string[] = [];
  for (let i = 0; i < minLen; i++) {
    const first = sequences[0]?.[i];
    if (typeof first !== "string") break;
    let allSame = true;
    for (let j = 1; j < sequences.length; j++) {
      if (sequences[j]?.[i] !== first) {
        allSame = false;
        break;
      }
    }
    if (allSame) prefix.push(first);
    else break;
  }
  return prefix;
}

export async function resolveRecurringPatternConcept(pointer: RecurringPatternPointer): Promise<ResolverResult> {
  const limit = pointer?.limit ?? 20;
  const traces = await fetchTraces(limit);
  const successful = traces.filter((t) => (t?.outcome ?? t?.status) === "success");
  const sequences = successful.map((t) => extractSteps(t));
  const filtered = sequences.filter((s) => s.length > 0);
  const shared = filtered.length > 1 ? commonPrefixSequences(filtered) : (filtered[0] ?? []);
  const activities = shared.map((shape, idx) => ({
    order: idx + 1,
    shape: shape ?? "unknown",
    generalized: `Recurring step: ${shape ?? "unknown"}`,
  }));
  const name = shared.length > 0 ? `recurring:${shared.join("->")}` : "recurring:unknown";
  const description = shared.length > 0
    ? `Most recent successful executions commonly begin with the sequence ${shared.join(" -> ")} across ${filtered.length} traces.`
    : "No recurring pattern identified from available successful traces.";
  return {
    shape: "recurringPatternConcept",
    body: {
      name,
      description,
      activities,
    },
  };
}
