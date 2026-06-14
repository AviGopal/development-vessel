import type { ResolverResult } from "./types.js";

/**
 * vessel_write_error_scan — deterministic detector for vessels logging repeated
 * persistence (write) errors.
 *
 * Meta-detector for the bug class where concept-db logged a SurrealDB INSERT
 * failure ("Found NULL for field content, but expected a option<string>") on
 * EVERY concept_create_write — the write-audit impulse silently dropping on
 * every mint. The concept write "succeeded" so no trace failed; the only signal
 * was a repeating ERROR line in the vessel's journal that nothing watched.
 *
 * Scans each configured systemd unit's journal over a window for an error
 * pattern, and emits a substrateGap when the match count exceeds a threshold
 * (so transient one-offs don't trigger). Routes the fix into the
 * gap → bridge → drafter loop so the next instance self-completes.
 *
 * Reads the journal inside substrate-live via journalctl (Bun.spawn). Mirrors
 * stale_pointer_emit / phantom_trace_scan: one server-side resolver,
 * deterministic filter, conditional emit, no LLM.
 */

interface ScanTarget {
  unit: string;
  /** Extended-regex error pattern (grep -E). */
  pattern: string;
}

export interface VesselWriteErrorScanPointer {
  type: "vessel_write_error_scan";
  /** Units + error patterns to scan. Defaults cover the data-bearing vessels' SQL/write errors. */
  targets?: ScanTarget[];
  /** Lookback window in minutes for journalctl --since. Default 30. */
  windowMinutes?: number;
  /** Emit a gap when match count >= this. Default 3. */
  threshold?: number;
  /** Override dev-vessel impulses URL (self-POST). */
  devVesselImpulsesUrl?: string;
  /** dry_run = true: scan + report but do not POST gaps. */
  dry_run?: boolean;
  /** Test hook: count function override (returns match count for a target). */
  _countFn?: (t: ScanTarget, windowMinutes: number) => Promise<number>;
}

const DEFAULT_DEV_VESSEL_URL = "http://127.0.0.1:8090/v2/impulses/resolve";
const DEFAULT_WINDOW_MINUTES = 30;
const DEFAULT_THRESHOLD = 3;
const DEFAULT_TARGETS: ScanTarget[] = [
  { unit: "concept-db.service", pattern: "SurrealDB query failed|Found NULL for field|expected a option" },
  { unit: "activity-api.service", pattern: "SurrealDB query failed|INSERT.*failed|UPDATE.*failed" },
  { unit: "identity-vessel.service", pattern: "SurrealDB query failed|insert failed" },
];

interface WriteErrorFinding {
  unit: string;
  pattern: string;
  match_count: number;
  gap_id: string;
  posted: boolean;
  post_status?: number | "error";
}

/** Count journal lines in `unit` matching `pattern` over the last `windowMinutes`. */
async function journalMatchCount(t: ScanTarget, windowMinutes: number): Promise<number> {
  try {
    const proc = Bun.spawn(
      ["journalctl", "--no-pager", "-u", t.unit, "--since", `${windowMinutes} minutes ago`],
      { stdout: "pipe", stderr: "ignore" },
    );
    const out = await new Response(proc.stdout).text();
    await proc.exited;
    let re: RegExp;
    try { re = new RegExp(t.pattern); } catch { return 0; }
    let n = 0;
    for (const line of out.split("\n")) if (re.test(line)) n += 1;
    return n;
  } catch {
    return 0;
  }
}

export async function resolveVesselWriteErrorScan(
  pointer: VesselWriteErrorScanPointer,
): Promise<ResolverResult> {
  const emitUrl = pointer.devVesselImpulsesUrl ?? DEFAULT_DEV_VESSEL_URL;
  const dryRun = pointer.dry_run === true;
  const windowMinutes = pointer.windowMinutes ?? DEFAULT_WINDOW_MINUTES;
  const threshold = pointer.threshold ?? DEFAULT_THRESHOLD;
  const targets = pointer.targets ?? DEFAULT_TARGETS;
  const countFn = pointer._countFn ?? journalMatchCount;

  const apiKey = process.env["METABOB_API_KEY"];
  const authHeader: Record<string, string> = apiKey ? { Authorization: `ApiKey ${apiKey}` } : {};

  // 1. Count matches per target.
  const findings: WriteErrorFinding[] = [];
  const perTarget: Array<{ unit: string; match_count: number }> = [];
  for (const t of targets) {
    const count = await countFn(t, windowMinutes);
    perTarget.push({ unit: t.unit, match_count: count });
    if (count >= threshold) {
      findings.push({
        unit: t.unit,
        pattern: t.pattern,
        match_count: count,
        gap_id: `vessel-write-error-${t.unit}`.replace(/[^a-zA-Z0-9._-]/g, "_"),
        posted: false,
      });
    }
  }

  // 2. Emit one substrateGap per offending unit (unless dry_run).
  if (!dryRun) {
    for (const f of findings) {
      const body = {
        impulse: {
          pointer: {
            type: "substrateGap_write",
            gap: {
              id: f.gap_id,
              category: "activity_lifecycle",
              source: "substrate_detected",
              summary:
                `Vessel ${f.unit} logged ${f.match_count} persistence-error lines in the last ` +
                `${windowMinutes}m matching /${f.pattern}/ — a repeating write failure that no ` +
                `trace surfaces (the class where concept-db dropped its write-audit on every mint).`,
              detected_at: new Date().toISOString(),
              status: "open",
              classification_metadata: {
                gap_subtype: "vessel_write_error",
                unit: f.unit,
                error_pattern: f.pattern,
                match_count: f.match_count,
                window_minutes: windowMinutes,
                remediation_hint:
                  "Inspect the failing INSERT/UPDATE in the named vessel. Common cause: SurrealDB " +
                  "NULL vs NONE on option<...> fields (pass NONE, not null). Mirrors the concept-db " +
                  "impulse-INSERT NULL→NONE fix.",
              },
            },
          },
        },
      };
      try {
        const resp = await fetch(emitUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json", ...authHeader },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(10_000),
        });
        f.post_status = resp.status;
        f.posted = resp.ok;
      } catch {
        f.post_status = "error";
      }
    }
  }

  return {
    shape: "vesselWriteErrorReport",
    body: {
      window_minutes: windowMinutes,
      threshold,
      per_target: perTarget,
      finding_count: findings.length,
      findings,
      dry_run: dryRun,
      completed_at: new Date().toISOString(),
    },
  };
}
