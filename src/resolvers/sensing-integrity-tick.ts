import type { ResolverResult } from "./types.js";
import { resolveSourceCodeAnalysis } from "./source-code-analysis.js";
import { resolveFsList } from "./fs-list.js";
import { resolveSubstrateGapWrite } from "./substrate-gap.js";

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
    await resolveSubstrateGapWrite({
      type: "substrateGap_write",
      gap: {
        id:
          "sensing-empty-success-" +
          probeName +
          "-" +
          new Date().toISOString().slice(0, 10),
        category: "systematic_failure",
        source: "sensing-integrity-tick",
        summary:
          "Known-answer probe " +
          probeName +
          " returned EMPTY SUCCESS (fixture guarantees nonzero result): the sensor is hiding a failure the reach gate cannot judge. Fix the resolver to return a structured error or real data.",
        classification_metadata: {
          failing_capability: probeName,
          edit_site:
            "repos/development-vessel/src/resolvers/" + probeName + ".ts",
        },
        status: "open",
      },
    } as never);
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
