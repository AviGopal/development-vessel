import type { ResolverResult } from "./types.js";
import { readFileSync } from "node:fs";

export interface RecurringPatternClusterPointer {
  type: string;
  events?: string[];
  min_count?: number;
}

function normalizeEvent(event: string): string {
  return event
    .toLowerCase()
    .replace(/\d+/g, "<N>")
    .replace(/\s+/g, " ")
    .trim();
}

export async function resolveRecurringPatternCluster(
  pointer: RecurringPatternClusterPointer,
): Promise<ResolverResult> {
  let events: string[];

  if (pointer.events !== undefined) {
    events = pointer.events;
  } else {
    try {
      const filePath = "/workspace/proposals/compose-lessons.jsonl";
      const raw = readFileSync(filePath, "utf8");
      const lines = raw.split("\n").filter((l) => l.trim().length > 0);
      const lastLines = lines.slice(-200);
      const parsed: string[] = [];
      for (const line of lastLines) {
        try {
          const obj = JSON.parse(line) as Record<string, unknown>;
          const cls = obj["class"];
          if (typeof cls === "string") {
            parsed.push(cls);
          }
        } catch {
          // skip unparseable lines
        }
      }
      events = parsed;
    } catch {
      events = [];
    }
  }

  const minCount = pointer.min_count ?? 2;

  // Count occurrences per normalized pattern, tracking raw examples
  const patternCounts = new Map<string, number>();
  const patternExamples = new Map<string, string[]>();

  for (const event of events) {
    const normalized = normalizeEvent(event);
    patternCounts.set(normalized, (patternCounts.get(normalized) ?? 0) + 1);
    const examples = patternExamples.get(normalized) ?? [];
    if (examples.length < 3) {
      examples.push(event);
    }
    patternExamples.set(normalized, examples);
  }

  // Keep clusters with count >= minCount
  const clusters: Array<{ pattern: string; count: number; examples: string[] }> = [];
  for (const [pattern, count] of patternCounts) {
    if (count >= minCount) {
      clusters.push({
        pattern,
        count,
        examples: patternExamples.get(pattern) ?? [],
      });
    }
  }

  // Sort by count descending
  clusters.sort((a, b) => b.count - a.count);

  return {
    shape: "recurringPatternCluster",
    body: {
      clusters,
      total_events: events.length,
    },
  };
}
