/**
 * A STAGED MITOSIS LANDS ON ITS GAP'S OWN EVIDENCE, NOT ON TYPECHECK ALONE.
 *
 * Measured on node 1 (activity-api landing fb9a985): patch_with_tools staged
 * /vessels/activity-api-mitosis-<ts> and its in-loop gate refused it
 * (evaluate_refused:static_eval_unavailable); 43s later the same gap's attempt FAILED its
 * verify and the lane minted a recommit-…-verify_failed child. The staged root and its
 * mitosis-pending.json were left in place, the cutover's change_window defer "preserved the
 * verified patch for the next maintenance window", and half an hour later mitosis-tick
 * re-evaluated it with `scripts=["typecheck"]`, got FAVORABLE citing only `bun run typecheck`,
 * and pushed it. The gap's class-2 test_suite check — the one thing that said whether the
 * change did what the gap asked — was never run against the tree that landed.
 *
 * Two seams, both read by vessel_mitosis_cutover:
 *   1. markStagedMitosisUnlandable — a verify failure for a gap marks the staged mitosis for
 *      that gap's lineage as unlandable, with the reason, in mitosis-pending.json — the only
 *      thing the deferred path (mitosis-tick) reads to find a staged tree. Not inside the staged
 *      root: the cutover's scope-creep gate refuses any file there outside staged_files, which
 *      would turn the marker into an unrelated refusal. readUnlandableMarker is the cutover's read.
 *   2. loadOwnCheck / judgeOwnCheck — the landing gap's own class-2 test_suite check
 *      (evidence_resolve.input {vessel, test_file, only_tests}, zero_field
 *      requested_not_passing) and the verdict over its re-run on the staged tree. A skipped
 *      requested test, a run that printed no summary, or a run that counted nothing is NOT
 *      a pass.
 *
 * No imports beyond node: this module is loaded by the cutover and by feature_compose, and
 * must stay cheap and side-effect free at import time.
 */
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** Compose failure classes that mean "the attempt's own verify ran and failed". */
export const VERIFY_FAILURE_CLASSES: ReadonlySet<string> = new Set([
  "verify_failed",
  "syntax_break",
  "typecheck_dangling_reference",
]);

/**
 * The lineage root of a gap id. feature_compose files `recommit-<gap.id>-<cls>` on a repeated
 * failure, so `recommit-recommit-X-verify_failed-verify_failed` descends from X: strip each
 * leading `recommit-` and one trailing `-<cls>` per prefix stripped (classes are snake_case,
 * never hyphenated).
 */
export function gapLineageRoot(id: string): string {
  let s = String(id ?? "").trim();
  let n = 0;
  while (s.startsWith("recommit-")) {
    s = s.slice("recommit-".length);
    n++;
  }
  for (let i = 0; i < n; i++) s = s.replace(/-[a-z][a-z0-9_]*$/, "");
  return s;
}

export function sameGapLineage(a: unknown, b: unknown): boolean {
  const x = typeof a === "string" ? a.trim() : "";
  const y = typeof b === "string" ? b.trim() : "";
  if (!x || !y) return false;
  return x === y || gapLineageRoot(x) === gapLineageRoot(y);
}

function defaultPendingPath(): string {
  return join(process.env["WORKSPACE_ROOT"] ?? process.cwd(), "mitosis-pending.json");
}

export interface UnlandableRecord {
  unlandable: true;
  gap_id: string;
  pending_gap_id: string;
  mitosis_version_id: string | null;
  mitosis_root: string | null;
  failure_class: string;
  reason: string;
  at: string;
}

/**
 * Mark the currently-pending staged mitosis unlandable when it belongs to `gapId`'s lineage.
 * Never throws. Returns what it did, so the caller can log it (a silent skip reads as a pass).
 */
export async function markStagedMitosisUnlandable(args: {
  gapId: string;
  failureClass: string;
  reason: string;
  pendingPath?: string;
}): Promise<{ marked: boolean; why: string; record?: UnlandableRecord }> {
  const pendingPath = args.pendingPath ?? defaultPendingPath();
  let pending: Record<string, unknown>;
  try {
    pending = JSON.parse(await readFile(pendingPath, "utf-8")) as Record<string, unknown>;
  } catch {
    return { marked: false, why: "no readable pending mitosis" };
  }
  if (!pending || typeof pending !== "object") return { marked: false, why: "pending is not an object" };
  if (!sameGapLineage(pending["gap_id"], args.gapId)) {
    return { marked: false, why: `pending mitosis belongs to ${String(pending["gap_id"] ?? "<none>")}, not ${args.gapId}'s lineage` };
  }
  const record: UnlandableRecord = {
    unlandable: true,
    gap_id: args.gapId,
    pending_gap_id: String(pending["gap_id"]),
    mitosis_version_id: typeof pending["mitosis_version_id"] === "string" ? (pending["mitosis_version_id"] as string) : null,
    mitosis_root: typeof pending["mitosis_root"] === "string" ? (pending["mitosis_root"] as string) : null,
    failure_class: args.failureClass,
    reason: String(args.reason ?? "").slice(0, 400),
    at: new Date().toISOString(),
  };
  try {
    await writeFile(pendingPath, JSON.stringify({ ...pending, unlandable: record }, null, 2));
  } catch (err) {
    return { marked: false, why: `pending write failed: ${(err as Error).message}` };
  }
  console.error(
    `[staged-mitosis] marked ${record.mitosis_version_id ?? "<unknown>"} UNLANDABLE: gap ${args.gapId} ${args.failureClass} — ${record.reason.slice(0, 160)}`,
  );
  return { marked: true, why: "marked", record };
}

/** The unlandable record for THIS staged mitosis: the pending file's, scoped to its version id. */
export async function readUnlandableMarker(args: {
  mitosisVersionId: string;
  pendingPath?: string;
}): Promise<Record<string, unknown> | null> {
  try {
    const p = JSON.parse(await readFile(args.pendingPath ?? defaultPendingPath(), "utf-8")) as Record<string, unknown>;
    const u = p?.["unlandable"];
    if (p?.["mitosis_version_id"] === args.mitosisVersionId && u && typeof u === "object") return u as Record<string, unknown>;
  } catch {
    /* no pending file */
  }
  return null;
}

export interface OwnCheck {
  gap_id: string;
  vessel: string;
  test_file: string;
  only_tests: string[];
}

/** The gap row's class-2 test_suite check for `vessel`, or null when it carries none. */
export function ownTestSuiteCheckOf(row: Record<string, unknown> | null | undefined, vessel: string): OwnCheck | null {
  const meta = row?.["classification_metadata"];
  if (!meta || typeof meta !== "object") return null;
  const er = (meta as Record<string, unknown>)["evidence_resolve"] as Record<string, unknown> | undefined;
  if (!er || typeof er !== "object" || er["shape"] !== "test_suite") return null;
  const input = er["input"] as Record<string, unknown> | undefined;
  if (!input || typeof input !== "object") return null;
  const v = String(input["vessel"] ?? "").replace(/^repos\//, "");
  if (!v || v !== vessel.replace(/^repos\//, "")) return null;
  const onlyTests = Array.isArray(input["only_tests"])
    ? (input["only_tests"] as unknown[]).filter((t): t is string => typeof t === "string" && t.trim().length > 0)
    : [];
  const testFile = typeof input["test_file"] === "string" ? (input["test_file"] as string).trim() : "";
  if (onlyTests.length === 0 || !testFile) return null;
  return { gap_id: String(row?.["id"] ?? ""), vessel: v, test_file: testFile, only_tests: onlyTests };
}

export type OwnCheckLoad =
  | { status: "found"; check: OwnCheck }
  | { status: "none"; why: string }
  | { status: "unreadable"; why: string };

/** Read the landing gap's row by id and extract its own test_suite check. */
export async function loadOwnCheck(
  vessel: string,
  gapId: string,
  read: (p: Record<string, unknown>) => Promise<unknown>,
): Promise<OwnCheckLoad> {
  if (!gapId) return { status: "none", why: "landing carries no gap id" };
  let res: unknown;
  try {
    res = await read({ type: "substrateGap", id: gapId, limit: 1 });
  } catch (err) {
    return { status: "unreadable", why: `gap store read threw: ${(err as Error).message}` };
  }
  const r = res as { shape?: string; body?: { gaps?: unknown } } | null;
  if (!r || r.shape !== "substrateGap" || !Array.isArray(r.body?.gaps)) {
    return { status: "unreadable", why: `gap store answered ${r?.shape ?? "nothing"}` };
  }
  const row = (r.body!.gaps as Array<Record<string, unknown>>).find((g) => String(g?.["id"]) === gapId);
  if (!row) return { status: "none", why: `no gap row ${gapId}` };
  const check = ownTestSuiteCheckOf(row, vessel);
  if (!check) return { status: "none", why: `gap ${gapId} carries no test_suite check for ${vessel}` };
  return { status: "found", check };
}

/**
 * Judge a test_suite body for the gap's own check. PASS only when the run printed a summary,
 * every requested test has a pass line (requested_not_passing === 0), nothing failed, NOTHING
 * WAS SKIPPED, and at least as many tests passed as were requested. `measured:false` means
 * the run said nothing either way (no summary, transport error) — a deferral, not a verdict.
 */
export function judgeOwnCheck(body: Record<string, unknown> | null | undefined, onlyTests: string[]): {
  pass: boolean;
  measured: boolean;
  reason: string;
} {
  if (!body || typeof body !== "object") return { pass: false, measured: false, reason: "no test_suite result" };
  if (body["ran"] !== true) return { pass: false, measured: false, reason: "test_suite printed no summary (did not run)" };
  const num = (k: string): number | null => (typeof body[k] === "number" && Number.isFinite(body[k] as number) ? (body[k] as number) : null);
  const rnp = num("requested_not_passing");
  const pass = num("pass") ?? 0;
  const fail = num("fail") ?? 0;
  const skip = num("skip") ?? 0;
  if (skip > 0) return { pass: false, measured: true, reason: `${skip} test(s) SKIPPED — a skipped test is not a passing test` };
  if (rnp === null) return { pass: false, measured: true, reason: "requested_not_passing unreported" };
  if (rnp > 0) return { pass: false, measured: true, reason: `${rnp}/${onlyTests.length} requested test(s) not passing` };
  if (fail > 0) return { pass: false, measured: true, reason: `${fail} test(s) failed` };
  if (pass < onlyTests.length) return { pass: false, measured: true, reason: `only ${pass} test(s) passed for ${onlyTests.length} requested` };
  return { pass: true, measured: true, reason: `${pass} pass, 0 fail, 0 skip; requested_not_passing=0` };
}

/**
 * feature_compose's failure path: when the class it records means the attempt's own verify ran and
 * failed, the staged mitosis for that gap's lineage must not be landed later by a path that only
 * re-typechecks it. Never throws.
 */
export async function markOnComposeFailure(
  gapId: string,
  failureClass: string,
  reason: string,
  pendingPath?: string,
): Promise<{ marked: boolean; why: string }> {
  if (!gapId || !VERIFY_FAILURE_CLASSES.has(failureClass)) return { marked: false, why: `class ${failureClass} is not a verify failure` };
  try {
    const r = await markStagedMitosisUnlandable({ gapId, failureClass, reason, ...(pendingPath ? { pendingPath } : {}) });
    return { marked: r.marked, why: r.why };
  } catch (err) {
    return { marked: false, why: `mark failed: ${(err as Error).message}` };
  }
}
