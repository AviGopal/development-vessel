import type { ResolverResult } from "./types.js";
import { resolveSourceCodeAnalysis } from "./source-code-analysis.js";
import { resolveFsList } from "./fs-list.js";
import { resolveSubstrateGapWrite } from "./substrate-gap.js";

/**
 * THE FALSIFIER A KNOWN-ANSWER PROBE ALREADY HOLDS.
 *
 * This detector fires when a probe returns EMPTY SUCCESS — and "empty" is not a
 * judgement, it is a measurement the probe has *already made* against a fixture
 * whose answer is known to be nonzero (`file_count > 0` at line ~55,
 * `entries.length > 0` at line ~87). That measurement used to be discarded at
 * write time, so the gap was born with nothing to test and could only leave by
 * the 30-day expiry timer. Carrying it through is accounting recovery, not
 * invention: re-resolving the same shape with the same input and reading the
 * same field IS the probe, run again.
 *
 * `shape` is the name the REGISTRY ADVERTISES (src/config.ts `discovery.shapes`
 * — "sourceCodeAnalysis" line 479, "fs_list" line 160), never the internal
 * resolver-function name. The sweep dispatches this name; an unadvertised one
 * resolves to nothing and yields the same 'unknown' as no predicate at all.
 *
 * POLARITY — WHY THESE PROBES ARE THE ONLY SAFE FIT. verifyGapConditionAsync's
 * `nonzero_field` heuristic (gap-to-feature.ts, "Defect heuristic 2") reads
 * zero/null/undefined as DEFECT STILL PRESENT and nonzero as ABSENT (fixed). So
 * the field must count HEALTH, not defects. A defect-count field (occurrences,
 * slow probes, violations) is inverted under that heuristic: it would read
 * "fixed" while the defect stands and "broken" once it is gone. A known-answer
 * probe is health-polarity by construction — the fixture guarantees nonzero when
 * the sensor works — which is why this detector carries a predicate and the
 * counting detectors in this repo deliberately do not.
 */
export interface SensingProbePredicate {
  /** Advertised shape the sweep re-resolves. */
  shape: string;
  /** The fixture input — the same one the probe used. */
  input: Record<string, unknown>;
  /** Health-polarity field: nonzero when the sensor works. */
  nonzero_field: string;
}

export const SENSING_PROBE_PREDICATES: Readonly<Record<string, SensingProbePredicate>> = {
  "source-code-analysis": {
    shape: "sourceCodeAnalysis",
    input: { target_path: "repos/development-vessel" },
    nonzero_field: "file_count",
  },
  "fs-list": {
    shape: "fs_list",
    input: { path: "/vessels/development-vessel" },
    // directoryListing body carries `count: entries.length`. Do NOT name
    // `entries`: an empty ARRAY is not `=== 0`, so heuristic 2 would read the
    // empty-success case as healthy — the exact false close this detector exists
    // to catch.
    nonzero_field: "count",
  },
};

/**
 * The exact `substrateGap_write` payload the tick files for a failing probe.
 * Extracted (behaviour-identical) so the emitted predicate is assertable without
 * a live gap store — the write itself is unchanged.
 */
export function buildSensingGapWrite(
  probeName: string,
  now: Date = new Date(),
): Record<string, unknown> {
  const predicate = SENSING_PROBE_PREDICATES[probeName];
  return {
    type: "substrateGap_write",
    gap: {
      id: "sensing-empty-success-" + probeName + "-" + now.toISOString().slice(0, 10),
      category: "systematic_failure",
      source: "sensing-integrity-tick",
      summary:
        "Known-answer probe " +
        probeName +
        " returned EMPTY SUCCESS (fixture guarantees nonzero result): the sensor is hiding a failure the reach gate cannot judge. Fix the resolver to return a structured error or real data.",
      classification_metadata: {
        failing_capability: probeName,
        edit_site: "repos/development-vessel/src/resolvers/" + probeName + ".ts",
        // Omitted entirely for a probe with no registered predicate: "none" is an
        // honest answer, and a fabricated predicate is worse than none because it
        // reads as measurable.
        ...(predicate ? { evidence_resolve: predicate } : {}),
      },
      status: "open",
    },
  };
}

export async function resolveSensingIntegrityTick(
  _pointer: Record<string, unknown>,
): Promise<ResolverResult> {
  type ProbeOutcome = "pass" | "empty_success_fail" | "loud_error";
  interface ProbeRecord {
    name: string;
    outcome: ProbeOutcome;
    detail: string;
  }

  const probes: ProbeRecord[] = [];
  let failures_filed = 0;

  async function fileGap(probeName: string): Promise<void> {
    await resolveSubstrateGapWrite(buildSensingGapWrite(probeName) as never);
    failures_filed++;
  }

  // Probe 1: source-code-analysis
  try {
    const result = await resolveSourceCodeAnalysis({
      target_path: "repos/development-vessel",
    });
    const body = result.body as Record<string, unknown>;
    const hasError =
      typeof body["error"] === "string" && body["error"].length > 0;
    const fileCount =
      typeof body["file_count"] === "number" ? body["file_count"] : 0;
    if (hasError || fileCount > 0) {
      probes.push({
        name: "source-code-analysis",
        outcome: "pass",
        detail: hasError
          ? `loud error: ${body["error"]}`
          : `file_count=${fileCount}`,
      });
    } else {
      probes.push({
        name: "source-code-analysis",
        outcome: "empty_success_fail",
        detail: "no error and file_count is 0 or missing",
      });
      await fileGap("source-code-analysis");
    }
  } catch (err) {
    probes.push({
      name: "source-code-analysis",
      outcome: "loud_error",
      detail: err instanceof Error ? err.message : String(err),
    });
  }

  // Probe 2: fs-list
  try {
    const result = await resolveFsList({
      type: "fs_list",
      path: "/vessels/development-vessel",
    } as never);
    const body = result.body as Record<string, unknown>;
    const entries = Array.isArray(body["entries"]) ? body["entries"] : [];
    if (entries.length > 0) {
      probes.push({
        name: "fs-list",
        outcome: "pass",
        detail: `entries.length=${entries.length}`,
      });
    } else {
      probes.push({
        name: "fs-list",
        outcome: "empty_success_fail",
        detail: "entries array is empty",
      });
      await fileGap("fs-list");
    }
  } catch (err) {
    probes.push({
      name: "fs-list",
      outcome: "loud_error",
      detail: err instanceof Error ? err.message : String(err),
    });
  }

  // Probe 3: placeholder for future fixtures
  probes.push({
    name: "probe-3-placeholder",
    outcome: "pass",
    detail: "skipped — reserved for future known-answer fixtures",
  });

  return {
    shape: "sensingIntegrityReport",
    body: {
      probes,
      failures_filed,
      checked_at: new Date().toISOString(),
    },
  };
}
