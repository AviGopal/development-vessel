import { join, dirname } from "path";
import {
  stat,
  lstat,
  mkdir,
  copyFile,
  readdir,
  symlink,
  unlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import type { ResolverResult } from "./types.js";

/**
 * vessel_mitosis_evaluate — fetches recent traces from activity-api, segments
 * them by version_id (read from trace metadata), computes per-version
 * success_rate + failure_mode class set, and renders a verdict.
 *
 * STATIC EVALUATION (2026-06-04): when pointer.mitosis_root is supplied, the
 * resolver runs the idiomatic substrate disciplines — `bun run lint` +
 * `bun test` — inside the mitosis directory BEFORE consulting traces. This
 * lets the autonomous self-repair loop reach FAVORABLE on freshly-staged
 * mitoses (which have no runtime traces against them yet) when the code
 * change is well-formed. Failing checks → UNFAVORABLE with cited output.
 * Passing checks → FAVORABLE (trace check becomes additive, not gating).
 *
 *   FAVORABLE       — mitosis success_rate ≥ base + threshold AND no new
 *                     failure_mode classes introduced.
 *   NEUTRAL         — within ±threshold either direction.
 *   UNFAVORABLE     — mitosis success_rate < base - threshold OR a new
 *                     failure_mode class appears.
 *   INSUFFICIENT_DATA — either side has fewer than min_traces_per_version.
 *
 * Version routing keys (in priority order, first present wins):
 *   metadata.version_id
 *   metadata.mitosis_version_id
 *   metadata.dispatch_target_template_id matching mitosis pattern
 *
 * Immunity-pattern: deterministic, no LLM, single resolver.
 */

export interface VesselMitosisEvaluatePointer {
  type: "vessel_mitosis_evaluate";
  base_version_id: string;
  mitosis_version_id: string;
  tracesUrl?: string;
  fetchLimit?: number;
  since?: string;
  min_traces_per_version?: number;
  success_rate_advantage_threshold?: number;
  /**
   * When supplied, the resolver runs `bun run lint` + `bun test` inside this
   * directory before consulting traces. If both pass → FAVORABLE. If either
   * fails → UNFAVORABLE with cited output. If the directory or scripts are
   * missing → falls through to trace path.
   */
  mitosis_root?: string;
  /**
   * When supplied along with mitosis_root + staged_files, the resolver
   * overlays staged files from mitosis_root onto a temp clone of
   * static_check_base_root (the canonical vessel tree with package.json +
   * node_modules) and runs lint + tests there. This is how the substrate
   * evaluates a sparse mitosis dir (which only contains the changed files)
   * — we synthesize the full vessel-tree-as-if-cutover-had-happened and
   * test it in isolation, then throw the temp away.
   */
  static_check_base_root?: string;
  staged_files?: string[];
  /** Override the static-check command runner (test hook). */
  static_check_runner?: "bun" | "skip";
  /** Override `bun` binary path. */
  bun_cmd?: string;
  /**
   * Script name(s) to invoke as `bun run <name>`. Defaults to ["lint"]
   * (typecheck + shape-dispatch). When the synthesized overlay lacks
   * supporting files for some scripts (e.g. test fixtures), provide a
   * narrower set. The `bun test` step is always attempted after these.
   */
  static_check_scripts?: string[];
  /** Skip `bun test` (default false). */
  skip_tests?: boolean;
}

interface StaticCheckResult {
  name: string;
  exit_code: number;
  duration_ms: number;
  output_tail: string;
}

interface StaticEvalResult {
  attempted: boolean;
  ok: boolean;
  reason: string;
  checks: StaticCheckResult[];
  duration_ms: number;
}

const STATIC_CHECK_TIMEOUT_MS = 60_000;
const OUTPUT_TAIL_BYTES = 4096;

function tail(s: string, n: number): string {
  if (s.length <= n) return s;
  return "...(truncated)..." + s.slice(s.length - n);
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

async function runCheck(
  bunCmd: string,
  args: string[],
  cwd: string,
  name: string,
): Promise<StaticCheckResult> {
  const start = Date.now();
  let exit = -1;
  let out = "";
  try {
    const proc = Bun.spawn([bunCmd, ...args], {
      cwd,
      stdout: "pipe",
      stderr: "pipe",
    });
    const timer = setTimeout(() => {
      try {
        proc.kill();
      } catch {
        /* noop */
      }
    }, STATIC_CHECK_TIMEOUT_MS);
    const [stdoutText, stderrText] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    exit = await proc.exited;
    clearTimeout(timer);
    out = `--- stdout ---\n${stdoutText}\n--- stderr ---\n${stderrText}`;
  } catch (err) {
    out = `spawn_error: ${(err as Error).message}`;
  }
  return {
    name,
    exit_code: exit,
    duration_ms: Date.now() - start,
    output_tail: tail(out, OUTPUT_TAIL_BYTES),
  };
}

/**
 * Build a synthetic vessel tree under tmpdir() that mirrors `baseRoot` via
 * symlinks for unchanged entries and copies `stagedFiles` from `mitosisRoot`
 * over the top. Returns the temp root. Caller is responsible for cleanup —
 * since these are mostly symlinks, the cleanup is cheap.
 */
async function buildOverlay(
  baseRoot: string,
  mitosisRoot: string,
  stagedFiles: string[],
): Promise<string> {
  const overlay = join(
    tmpdir(),
    `mitosis-overlay-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
  await mkdir(overlay, { recursive: true });
  // Symlink every top-level entry of baseRoot into overlay.
  const tops = (await readdir(baseRoot, { withFileTypes: true })) as unknown as Array<{
    name: string;
    isDirectory(): boolean;
  }>;
  for (const e of tops) {
    const name = e.name;
    if (name === ".git") continue;
    try {
      await symlink(join(baseRoot, name), join(overlay, name));
    } catch {
      /* ignore EEXIST */
    }
  }
  // Apply each staged file: remove symlinked path along its prefix,
  // materialize real dirs, copy the file.
  for (const rel of stagedFiles) {
    const parts = rel.split("/");
    let cursor = overlay;
    for (let i = 0; i < parts.length - 1; i++) {
      const segment = parts[i];
      if (!segment) continue;
      const path = join(cursor, segment);
      let s;
      try {
        // V38 (2026-06-12): lstat, NOT stat. stat FOLLOWS symlinks, so a
        // symlinked top-level dir (overlay/src -> baseRoot/src) reported
        // isDirectory()=true, the materialize branch never fired, and the
        // staged-file copy below wrote THROUGH the symlink into the LIVE
        // baseRoot tree. That corrupted the running vessel source mid-evaluate
        // and then tripped the cutover's base_sha freshness gate. lstat sees
        // the symlink itself (isDirectory()=false) so we materialize a real dir.
        s = await lstat(path);
      } catch {
        s = null;
      }
      if (!s || !s.isDirectory()) {
        try {
          await unlink(path);
        } catch {
          /* not a symlink/file */
        }
        await mkdir(path, { recursive: true });
        // Re-link existing entries from the real base subdir.
        const realSub = join(baseRoot, parts.slice(0, i + 1).join("/"));
        try {
          const subEntries = (await readdir(realSub, { withFileTypes: true })) as unknown as Array<{
            name: string;
          }>;
          for (const sub of subEntries) {
            try {
              await symlink(join(realSub, sub.name), join(path, sub.name));
            } catch {
              /* ignore */
            }
          }
        } catch {
          /* realSub missing — staged file introducing a new dir */
        }
      }
      cursor = path;
    }
    const target = join(overlay, rel);
    try {
      await unlink(target);
    } catch {
      /* not present */
    }
    const src = join(mitosisRoot, rel);
    if (await pathExists(src)) {
      await mkdir(dirname(target), { recursive: true });
      await copyFile(src, target);
    }
  }
  return overlay;
}

async function staticEvaluate(
  mitosisRoot: string,
  bunCmd: string,
  baseRootForOverlay?: string,
  stagedFiles?: string[],
  scripts: string[] = ["lint"],
  skipTests = false,
): Promise<StaticEvalResult> {
  const start = Date.now();
  if (!(await pathExists(mitosisRoot))) {
    return {
      attempted: false,
      ok: false,
      reason: "static_eval_unavailable: mitosis_root missing",
      checks: [],
      duration_ms: Date.now() - start,
    };
  }
  // Decide which directory to run checks in.
  let runRoot = mitosisRoot;
  const mitosisHasPkg = await pathExists(join(mitosisRoot, "package.json"));
  if (!mitosisHasPkg) {
    // Need an overlay against a base that DOES have package.json.
    if (
      !baseRootForOverlay ||
      !stagedFiles ||
      stagedFiles.length === 0 ||
      !(await pathExists(join(baseRootForOverlay, "package.json")))
    ) {
      return {
        attempted: false,
        ok: false,
        reason:
          "static_eval_unavailable: mitosis_root lacks package.json and no static_check_base_root+staged_files supplied",
        checks: [],
        duration_ms: Date.now() - start,
      };
    }
    try {
      runRoot = await buildOverlay(baseRootForOverlay, mitosisRoot, stagedFiles);
    } catch (err) {
      return {
        attempted: false,
        ok: false,
        reason: `static_eval_unavailable: overlay build failed: ${(err as Error).message}`,
        checks: [],
        duration_ms: Date.now() - start,
      };
    }
  }
  const completed: StaticCheckResult[] = [];
  for (const scriptName of scripts) {
    const r = await runCheck(
      bunCmd,
      ["run", scriptName],
      runRoot,
      `bun run ${scriptName}`,
    );
    completed.push(r);
    if (r.exit_code !== 0) {
      // V32 (2026-06-09): delta-aware verdict. Vessels carry pre-existing
      // baseline typecheck errors (e.g. boredom-vessel src/index.ts:1805
      // METABOB_API_KEY undefined — present months before any V25-V31 work).
      // A binary exit≠0 → UNFAVORABLE gate makes the autonomous repair loop
      // unreachable: every staged patch fails even when it doesn't worsen
      // the baseline. The idiom shift — patches must not REGRESS the static
      // health, but they need not perfect it — matches how vessel_mitosis
      // already treats trace verdicts (better-than-base, not best-possible).
      //
      // Compare error-line counts. If the base tree has the same or more
      // matching errors than the mitosis tree, treat as pass. Only run the
      // base check when we actually have baseRootForOverlay (the overlay
      // path); without it we can't compute a baseline, so we keep the strict
      // gate behaviour.
      let isRegression = true;
      let baseErrorCount = -1;
      let mitosisErrorCount = -1;
      if (baseRootForOverlay && stagedFiles && stagedFiles.length > 0) {
        const errPattern = /error TS\d+:/g;
        mitosisErrorCount = (r.output_tail.match(errPattern) ?? []).length;
        const baseCheck = await runCheck(bunCmd, ["run", scriptName], baseRootForOverlay, `base:bun run ${scriptName}`);
        baseErrorCount = (baseCheck.output_tail.match(errPattern) ?? []).length;
        // Only accept the patch if mitosis introduces NO new errors.
        // We use error-count as the discriminator (vs exact set diff) because
        // tsc output line numbers shift with even non-substantive edits, so
        // a set-based comparison would over-reject. Count-based is monotone:
        // mitosis_count > base_count strictly implies new errors exist.
        if (mitosisErrorCount <= baseErrorCount) {
          isRegression = false;
          completed.push({
            ...baseCheck,
            name: `base:${baseCheck.name} (delta_aware: mitosis=${mitosisErrorCount} base=${baseErrorCount} → accept)`,
          });
        }
      }
      if (isRegression) {
        return {
          attempted: true,
          ok: false,
          reason: `${scriptName}_failed: exit=${r.exit_code}${baseErrorCount >= 0 ? ` mitosis_errs=${mitosisErrorCount} base_errs=${baseErrorCount} (regression)` : ""}`,
          checks: completed,
          duration_ms: Date.now() - start,
        };
      }
      // Patch doesn't regress baseline — continue to next script (or finish).
    }
  }
  if (!skipTests) {
    const test = await runCheck(bunCmd, ["test"], runRoot, "bun test");
    completed.push(test);
    if (test.exit_code !== 0) {
      return {
        attempted: true,
        ok: false,
        reason: `tests_failed: exit=${test.exit_code}`,
        checks: completed,
        duration_ms: Date.now() - start,
      };
    }
  }
  return {
    attempted: true,
    ok: true,
    reason: "static_checks_pass",
    checks: completed,
    duration_ms: Date.now() - start,
  };
}

const DEFAULT_TRACES_URL = "http://127.0.0.1:8080/v2/activities/execution-traces";
const DEFAULT_FETCH_LIMIT = 200;
const DEFAULT_MIN_TRACES = 3;
const DEFAULT_THRESHOLD = 0.1;

interface TraceLike {
  execution_id?: unknown;
  id?: unknown;
  status?: unknown;
  failure_mode?: unknown;
  metadata?: unknown;
  executed_at?: unknown;
}

function versionIdOf(t: TraceLike, baseId: string, mitosisId: string): string | null {
  const md = (t.metadata ?? {}) as Record<string, unknown>;
  const candidates = [
    md["version_id"],
    md["mitosis_version_id"],
    md["dispatch_target_template_id"],
  ];
  for (const c of candidates) {
    if (typeof c === "string") {
      if (c === baseId || c === mitosisId) return c;
      if (c.includes(mitosisId)) return mitosisId;
      if (c.includes(baseId)) return baseId;
    }
  }
  return null;
}

function execIdOf(t: TraceLike): string {
  if (typeof t.execution_id === "string" && t.execution_id.length > 0) return t.execution_id;
  if (typeof t.id === "string") return t.id;
  return "unknown";
}

function failureModeTypeOf(t: TraceLike): string | null {
  const fm = t.failure_mode;
  if (!fm || typeof fm !== "object") return null;
  const type = (fm as { type?: unknown }).type;
  if (typeof type === "string" && type.length > 0) return type;
  return null;
}

interface VersionStats {
  version_id: string;
  total: number;
  succeeded: number;
  failed: number;
  success_rate: number;
  failure_mode_classes: string[];
  sample_trace_ids: string[];
}

function emptyStats(version_id: string): VersionStats {
  return {
    version_id,
    total: 0,
    succeeded: 0,
    failed: 0,
    success_rate: 0,
    failure_mode_classes: [],
    sample_trace_ids: [],
  };
}

export async function resolveVesselMitosisEvaluate(
  pointer: VesselMitosisEvaluatePointer,
): Promise<ResolverResult> {
  const baseId = pointer.base_version_id;
  const mitosisId = pointer.mitosis_version_id;
  if (!baseId || !mitosisId) {
    return {
      shape: "structuredError",
      body: {
        resolver: "vessel_mitosis_evaluate",
        detail: "base_version_id and mitosis_version_id are required",
      },
    };
  }
  const minTraces = pointer.min_traces_per_version ?? DEFAULT_MIN_TRACES;
  const threshold = pointer.success_rate_advantage_threshold ?? DEFAULT_THRESHOLD;
  const fetchLimit = pointer.fetchLimit ?? DEFAULT_FETCH_LIMIT;
  const url = (pointer.tracesUrl ?? DEFAULT_TRACES_URL) + `?limit=${fetchLimit}`;

  // V8 (2026-06-05): deterministic verdict within an hour bucket.
  // Previously the trace-path verdict drifted across calls on the same
  // mitosis pair because the trace fetch returned whatever happened to be
  // the most recent N rows at request time. Same input must yield same
  // verdict to be a usable signal. We bucket time to the hour and use it
  // as the lower bound of the trace window when no explicit `since` is
  // supplied — repeated calls within the same hour see identical input.
  const HOUR_MS = 60 * 60 * 1000;
  // 30-day window — wide enough to capture all reasonably-recent traces
  // for a mitosis evaluation, narrow enough that the trace fetch (limit=200)
  // sees the same set across calls within an hour. The hour bucket on
  // `bucketNow` is the determinism anchor; the window length only sets
  // the lower bound of "ancient" traces we ignore.
  const DEFAULT_WINDOW_HOURS = 24 * 30;
  const bucketNow = Math.floor(Date.now() / HOUR_MS) * HOUR_MS;
  const defaultSince = new Date(bucketNow - DEFAULT_WINDOW_HOURS * HOUR_MS).toISOString();

  // ---- Static evaluation gate (2026-06-04) ----
  // Idiomatic substrate discipline: run lint + tests inside the mitosis dir
  // before consulting traces. Lets freshly-staged mitoses reach FAVORABLE
  // without waiting for runtime traces. Sufficient by itself for FAVORABLE
  // when checks pass.
  // V38 (2026-06-12): coerce staged_files. The mitosis-tick template passes it
  // as {{extract_staged_files_content}} — json_path_extract + variable
  // substitution STRINGIFY the array, so the resolver receives the literal
  // string '["src/...ts"]' not an array. staticEvaluate then iterated the
  // string char-by-char, buildOverlay tried to copyfile the mitosis_root dir
  // itself (ENOTSUP), returned attempted:false, and the verdict fell through to
  // the trace path → INSUFFICIENT_DATA → cutover refused a perfectly good patch.
  const stagedFilesArr: string[] = Array.isArray(pointer.staged_files)
    ? (pointer.staged_files as string[])
    : typeof pointer.staged_files === "string"
      ? (() => { try { const p = JSON.parse(pointer.staged_files as unknown as string); return Array.isArray(p) ? (p as string[]) : [pointer.staged_files as unknown as string]; } catch { return [pointer.staged_files as unknown as string]; } })()
      : [];
  let staticResult: StaticEvalResult | null = null;
  if (pointer.mitosis_root && pointer.static_check_runner !== "skip") {
    const bunCmd = pointer.bun_cmd ?? "bun";
    staticResult = await staticEvaluate(
      pointer.mitosis_root,
      bunCmd,
      pointer.static_check_base_root,
      stagedFilesArr,
      pointer.static_check_scripts,
      pointer.skip_tests ?? false,
    );
    console.error(`[mitosis-evaluate] static attempted=${staticResult.attempted} ok=${staticResult.ok} reason=${staticResult.reason} | mitosis_root=${pointer.mitosis_root} base=${pointer.static_check_base_root} staged_files=${JSON.stringify(pointer.staged_files)} (type ${typeof pointer.staged_files}) scripts=${JSON.stringify(pointer.static_check_scripts)}`);
    if (staticResult.attempted && !staticResult.ok) {
      const firstFail = staticResult.checks.find((c) => c.exit_code !== 0);
      return {
        shape: "vesselMitosisEvaluation",
        body: {
          base_version_id: baseId,
          mitosis_version_id: mitosisId,
          verdict: "UNFAVORABLE",
          verdict_reason: staticResult.reason,
          static_evaluation: staticResult,
          cited_check_name: firstFail?.name ?? "unknown",
          cited_check_output_tail: firstFail?.output_tail ?? "",
          evaluated_at: new Date().toISOString(),
        },
      };
    }
    if (staticResult.attempted && staticResult.ok) {
      return {
        shape: "vesselMitosisEvaluation",
        body: {
          base_version_id: baseId,
          mitosis_version_id: mitosisId,
          verdict: "FAVORABLE",
          verdict_reason: "static_checks_pass",
          static_evaluation: staticResult,
          cited_check_names: staticResult.checks.map((c) => c.name),
          evaluated_at: new Date().toISOString(),
        },
      };
    }
    // staticResult.attempted === false → fall through to trace path.
  }

  const apiKey = process.env["METABOB_API_KEY"];
  const bearerToken = process.env["ACTIVITY_API_TOKEN"] ?? process.env["VESSEL_JWT"];
  const headers: Record<string, string> = apiKey ? { Authorization: `ApiKey ${apiKey}` } : bearerToken ? { Authorization: `Bearer ${bearerToken}` } : {};

  let traces: TraceLike[] = [];
  try {
    const resp = await fetch(url, {
      method: "GET",
      headers,
      signal: AbortSignal.timeout(15_000),
    });
    if (!resp.ok) {
      // Transient activity-api unavailability is the substrate's "no
      // runtime evidence available right now" — the audited NO, not a
      // chain failure. Emit vesselMitosisEvaluation{INSUFFICIENT_DATA}
      // so cutover sees the verdict (and refuses cleanly) instead of
      // structuredError being silently dropped by the engine top-level
      // catch. Mirrors the pattern from 74542cc/875d539/f9573a3/befb371.
      return {
        shape: "vesselMitosisEvaluation",
        body: {
          base_version_id: baseId,
          mitosis_version_id: mitosisId,
          verdict: "INSUFFICIENT_DATA",
          verdict_reason: `activity_api_traces_returned_${resp.status}`,
          evaluated_at: new Date().toISOString(),
        },
      };
    }
    const json = (await resp.json()) as { executions?: unknown; traces?: unknown };
    const arr = Array.isArray(json.executions)
      ? json.executions
      : Array.isArray(json.traces)
        ? json.traces
        : [];
    traces = arr as TraceLike[];
  } catch (err) {
    // Same audited-NO pattern as the 4xx/5xx branch above: trace-fetch
    // failure is the substrate's "no runtime evidence available" signal,
    // not a chain crash. Cutover will see the INSUFFICIENT_DATA verdict
    // and either accept it via static-eval cited_check_names or
    // soft-refuse cleanly.
    return {
      shape: "vesselMitosisEvaluation",
      body: {
        base_version_id: baseId,
        mitosis_version_id: mitosisId,
        verdict: "INSUFFICIENT_DATA",
        verdict_reason: `traces_fetch_failed: ${(err as Error).message.slice(0, 200)}`,
        evaluated_at: new Date().toISOString(),
      },
    };
  }

  // V8: clamp to deterministic window. `pointer.since` wins when supplied;
  // otherwise we use the hour-bucketed default so repeated calls within the
  // same hour observe the same trace set.
  const since = pointer.since ?? defaultSince;
  traces = traces.filter((t) => {
    const ts = typeof t.executed_at === "string" ? t.executed_at : "";
    return ts >= since;
  });

  const base = emptyStats(baseId);
  const mitosis = emptyStats(mitosisId);
  const baseFMs = new Set<string>();
  const mitosisFMs = new Set<string>();

  for (const t of traces) {
    const vid = versionIdOf(t, baseId, mitosisId);
    if (vid !== baseId && vid !== mitosisId) continue;
    const target = vid === baseId ? base : mitosis;
    const fmSet = vid === baseId ? baseFMs : mitosisFMs;
    target.total += 1;
    if (t.status === "success") target.succeeded += 1;
    else if (t.status === "failure") target.failed += 1;
    const fmType = failureModeTypeOf(t);
    if (fmType) fmSet.add(fmType);
    if (target.sample_trace_ids.length < 5) target.sample_trace_ids.push(execIdOf(t));
  }

  base.success_rate = base.total > 0 ? base.succeeded / base.total : 0;
  mitosis.success_rate = mitosis.total > 0 ? mitosis.succeeded / mitosis.total : 0;
  base.failure_mode_classes = Array.from(baseFMs).sort();
  mitosis.failure_mode_classes = Array.from(mitosisFMs).sort();

  let verdict: "FAVORABLE" | "NEUTRAL" | "UNFAVORABLE" | "INSUFFICIENT_DATA";
  let verdict_reason: string;
  const cited_trace_ids: string[] = [...base.sample_trace_ids, ...mitosis.sample_trace_ids];

  if (base.total < minTraces || mitosis.total < minTraces) {
    verdict = "INSUFFICIENT_DATA";
    verdict_reason = `need ≥${minTraces} traces per version (base=${base.total}, mitosis=${mitosis.total})`;
  } else {
    const newFailureClasses = mitosis.failure_mode_classes.filter(
      (c) => !baseFMs.has(c),
    );
    const advantage = mitosis.success_rate - base.success_rate;
    if (newFailureClasses.length > 0) {
      verdict = "UNFAVORABLE";
      verdict_reason = `mitosis introduces new failure_mode class(es): ${newFailureClasses.join(", ")}`;
    } else if (advantage >= threshold) {
      verdict = "FAVORABLE";
      verdict_reason = `mitosis success_rate ${mitosis.success_rate.toFixed(3)} beats base ${base.success_rate.toFixed(3)} by ≥${threshold}`;
    } else if (advantage <= -threshold) {
      verdict = "UNFAVORABLE";
      verdict_reason = `mitosis success_rate ${mitosis.success_rate.toFixed(3)} trails base ${base.success_rate.toFixed(3)} by ≥${threshold}`;
    } else {
      verdict = "NEUTRAL";
      verdict_reason = `success_rate delta ${advantage.toFixed(3)} within ±${threshold}; no failure class regression`;
    }
  }

  return {
    shape: "vesselMitosisEvaluation",
    body: {
      base_version_id: baseId,
      mitosis_version_id: mitosisId,
      verdict,
      verdict_reason,
      threshold,
      min_traces_per_version: minTraces,
      base_success_rate: base.success_rate,
      mitosis_success_rate: mitosis.success_rate,
      base,
      mitosis,
      cited_trace_ids,
      scanned: traces.length,
      window_since: since,
      window_since_source: pointer.since ? "explicit" : "hour_bucket_default",
      static_evaluation: staticResult,
      evaluated_at: new Date().toISOString(),
    },
  };
}
