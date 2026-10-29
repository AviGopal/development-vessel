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
  | { status: "found"; check: OwnCheck; row: Record<string, unknown> }
  | { status: "none"; why: string; row?: Record<string, unknown> }
  | { status: "unreadable"; why: string };

/** Read the landing gap's row by id and extract its own test_suite check. */
/**
 * Why a gap-store read was not a substrateGap answer, WITH the holder's own detail (CHANGE-30b). A forwarded read
 * that failed comes back as a structuredError whose body.detail says which way it failed (substrate-gap.ts
 * forwardToGapStore: "answered HTTP <status>" vs "unreachable: <timeout|socket closed|...>"); logging only the shape
 * made a 401, a timeout and a dropped socket read identically. One definition, used by every gap-store read here.
 */
export function gapStoreAnsweredWhy(r: { shape?: string; body?: { detail?: unknown } } | null | undefined): string {
  const detail = r?.body?.detail;
  return `gap store answered ${r?.shape ?? "nothing"}${typeof detail === "string" && detail.trim() ? `: ${detail.trim().slice(0, 200)}` : ""}`;
}

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
  const r = res as { shape?: string; body?: { gaps?: unknown; detail?: unknown } } | null;
  if (!r || r.shape !== "substrateGap" || !Array.isArray(r.body?.gaps)) {
    return { status: "unreadable", why: gapStoreAnsweredWhy(r) };
  }
  const row = (r.body!.gaps as Array<Record<string, unknown>>).find((g) => String(g?.["id"]) === gapId);
  if (!row) return { status: "none", why: `no gap row ${gapId}` };
  const check = ownTestSuiteCheckOf(row, vessel);
  if (!check) return { status: "none", why: `gap ${gapId} carries no test_suite check for ${vessel}`, row };
  return { status: "found", check, row };
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

/**
 * CONSECUTIVE UNMEASURABLE OWN-CHECK RUNS BEFORE THE CHECK, NOT THE TREE, IS TREATED AS BROKEN.
 * One unmeasurable run is usually the environment (no shell producer, a saturated box). The same gap's
 * check coming back unmeasurable three cutovers in a row, with no measured run in between, is the check:
 * a test title that no longer exists (bun: `regex "<name>" matched 0 tests`, no summary), a moved test
 * file, a vessel it cannot run in. Recomposing code cannot fix that. Three keeps a single flaky outage,
 * or two, from demoting a sound check, and still stops the lane after a handful of wasted composes.
 */
export const OWN_CHECK_UNMEASURABLE_ESCALATE_AT = 3;

/**
 * The classification_metadata keys to merge into the landing gap's row after an own-check run (the store
 * carries omitted keys forward, so only these are written), or null when nothing needs writing.
 *   - unmeasurable: own_check_unmeasurable_count +1, own_check_last_reason, own_check_last_at;
 *     at OWN_CHECK_UNMEASURABLE_ESCALATE_AT the check is DEMOTED for re-derivation: evidence_resolve is
 *     written null (the store's classifier then re-stamps the falsifier "none"), and the broken check is
 *     kept beside it in own_check_broken. That puts the gap in the falsifier supply backlog
 *     (gap-lifecycle-scan isFalsifierSupplyCandidate) whose gap_falsify pass re-derives a class-2 check
 *     for the gap itself (decomposeGap parentCheck mode, written only when it reads 'present'), and out
 *     of autonomous compose wherever require_falsifier_classes is set (gap-to-feature admission).
 *   - measured (pass or fail): the count resets to 0 when it was non-zero.
 */
export function ownCheckOutcomeUpdate(
  meta: Record<string, unknown> | null | undefined,
  outcome: { measured: boolean; reason: string },
  nowIso: string,
): { update: Record<string, unknown> | null; count: number; escalated: boolean } {
  const m = (meta ?? {}) as Record<string, unknown>;
  const prior = typeof m["own_check_unmeasurable_count"] === "number" && Number.isFinite(m["own_check_unmeasurable_count"]) ? (m["own_check_unmeasurable_count"] as number) : 0;
  const reason = String(outcome.reason ?? "").slice(0, 300);
  if (outcome.measured) {
    if (prior === 0) return { update: null, count: 0, escalated: false };
    return { update: { own_check_unmeasurable_count: 0, own_check_last_reason: reason, own_check_last_at: nowIso }, count: 0, escalated: false };
  }
  const count = prior + 1;
  const update: Record<string, unknown> = { own_check_unmeasurable_count: count, own_check_last_reason: reason, own_check_last_at: nowIso };
  const escalated = count >= OWN_CHECK_UNMEASURABLE_ESCALATE_AT && m["evidence_resolve"] != null;
  if (escalated) {
    update["evidence_resolve"] = null;
    update["own_check_broken"] = {
      evidence_resolve: m["evidence_resolve"],
      unmeasurable_count: count,
      last_reason: reason,
      escalated_at: nowIso,
      route: "gap_falsify parent_check re-derivation (falsifier none)",
    };
  }
  return { update, count, escalated };
}

/**
 * LANDING ADMISSIBILITY: ONE RULE FOR EVERY ROUTE THAT LANDS (user ruling 2026-10-16T23:59:15Z "Before RUN 2"; gap
 * a-mitosis-cutover-landing-bypasses-its-gaps-red-own-check-and-operator-hold).
 *
 * Measured: substrate-authored 9ab61e0 (light-dispatch, 10-02, apply_proposal_as_patch + vessel_mitosis_cutover)
 * landed an auth-only fix that the gap family's operator ORDERING hold forbade, and whose own check was red. Both
 * routes (feature_compose and apply -> patch_with_tools -> mitosis) end in resolveVesselMitosisCutover, so the rule is
 * enforced there, at cutover time (a hold set after staging still refuses): the cutover's own-check gate (cf517dbe,
 * 2.5 h after 9ab61e0) already refuses a red candidate; this adds what it lacked.
 *   - HOLD: the shaped operator_hold field on the gap OR ANY FAMILY MEMBER (the parent_gap_id chain and duplicate_of
 *     targets), walked with a visited set (no depth constant; a duplicate_of chain can loop). Never read from text.
 *   - RED ON THE PARENT: when the gap carries an own check, a candidate whose check was ALREADY green on the parent
 *     tree did not do what the gap asked (the change is not the fix); refused. An unmeasurable parent run admits and
 *     says so. A gap with NO own check is admitted and says so ("admitted: no own check"); it is never blanket-refused.
 * Every refusal carries a reason code (hold | family_hold | green_on_parent) for the trace and the gap row (law 8).
 */
export type HoldFinding =
  | { held: false; visited: string[] }
  | { held: true; holder: string; relation: "self" | "parent" | "duplicate_of"; reason: string; visited: string[] };

/** The gap's own hold, then its family's: the parent_gap_id chain and duplicate_of targets, each visited once. */
export async function familyHold(
  row: Record<string, unknown>,
  read: (p: Record<string, unknown>) => Promise<unknown>,
): Promise<HoldFinding | { unreadable: string }> {
  const metaOf = (r: Record<string, unknown>) => ((r["classification_metadata"] ?? {}) as Record<string, unknown>);
  const linksOf = (r: Record<string, unknown>): Array<{ id: string; relation: "parent" | "duplicate_of" }> => {
    const m = metaOf(r);
    const out: Array<{ id: string; relation: "parent" | "duplicate_of" }> = [];
    const parent = m["parent_gap_id"] ?? r["parent_gap_id"];
    if (typeof parent === "string" && parent.trim()) out.push({ id: parent.trim(), relation: "parent" });
    const dup = m["duplicate_of"];
    for (const d of Array.isArray(dup) ? dup : [dup]) if (typeof d === "string" && d.trim()) out.push({ id: d.trim(), relation: "duplicate_of" });
    return out;
  };
  const visited = new Set<string>();
  const queue: Array<{ row: Record<string, unknown>; relation: "self" | "parent" | "duplicate_of" }> = [{ row, relation: "self" }];
  while (queue.length > 0) {
    const { row: r, relation } = queue.shift()!;
    const id = String(r["id"] ?? "");
    if (!id || visited.has(id)) continue;
    visited.add(id);
    const m = metaOf(r);
    if (m["operator_hold"] === true) {
      return { held: true, holder: id, relation, reason: String(m["operator_hold_reason"] ?? "operator_hold set").slice(0, 300), visited: [...visited] };
    }
    for (const link of linksOf(r)) {
      if (visited.has(link.id)) continue;
      let res: unknown;
      try { res = await read({ type: "substrateGap", id: link.id, limit: 1 }); } catch (err) { return { unreadable: `family read of ${link.id} threw: ${(err as Error).message}` }; }
      const rr = res as { shape?: string; body?: { gaps?: unknown } } | null;
      if (!rr || rr.shape !== "substrateGap" || !Array.isArray(rr.body?.gaps)) return { unreadable: `family read of ${link.id}: ${gapStoreAnsweredWhy(rr as never)}` };
      const member = (rr.body!.gaps as Array<Record<string, unknown>>).find((g) => String(g?.["id"]) === link.id);
      // An ancestor the store no longer holds cannot hold anything; it is noted as visited and the walk goes on.
      if (!member) { visited.add(link.id); continue; }
      queue.push({ row: member, relation: relation === "self" ? link.relation : relation });
    }
  }
  return { held: false, visited: [...visited] };
}

/**
 * AN UNANCHORED ROUTE-EDIT SRC LANDING IS A PROPOSAL, NOT A LANDING (finding agf_kox0hqmw8dgv). The edit-intent route
 * (route-edit-*) landed goal-host src for gaps whose check supply found no falsifiable anchor (check_supply no_anchor,
 * falsifier none): one change emitted a fabricated oracle_verified:true, the other was dead code. Both were admitted
 * as "no own check" and only stamped landed_unverified, so nothing could tell a real fix from a hollow one, while the
 * check lane's arm-time soundness guards (which refuse unsound checks) never saw them. So the cutover lands an
 * UNDIRECTED route-edit change that touches src/ only when its gap's check is ARMED (routeEditUnarmedWhy below), and
 * then the ordinary own check must still pass on the staged tree; otherwise it refuses (unanchored_src_landing) before
 * the commit and before any credit, and the change stays a proposal. A directed landing (the cutover's stamp-verified
 * directedLandingOrigin, never a flag on the pointer or the row) keeps the reviewed no-check path. A landing of test
 * files only (an arming landing adds the gap's own check under test/checks/) touches no src/ and is not refused here.
 */
export function isRouteEditGap(gapId: string, row: Record<string, unknown> | null | undefined): boolean {
  if (/^(?:recommit-)*route-edit-[0-9a-f]+/.test(gapId)) return true;
  if (!row) return false;
  const meta = (row["classification_metadata"] ?? {}) as Record<string, unknown>;
  return row["category"] === "edit_intent_route" || (meta["route_edit_persisted"] != null && typeof meta["route_edit_persisted"] === "object");
}

/** Whether any staged path (vessel-relative) is under src/. */
export function touchesSrc(paths: readonly string[] | null | undefined): boolean {
  return Array.isArray(paths) && paths.some((p) => typeof p === "string" && /^src\//.test(p.replace(/^(?:\.\/)+/, "")));
}

/**
 * Null when a route-edit gap's check is ARMED, else why not. Armed is what check supply writes when it arms a check
 * (gap-check-supply.ts): the row carries a test_suite own check, its falsifier is class2 (string or { class } form),
 * and its check_supply ledger is state "armed", red_at_head true, last_verdict "present". Anything else (no row,
 * no_anchor, arm_refused, existence_only, green_at_head, goal_dispatched, a stale or malformed arm record) is not.
 */
export function routeEditUnarmedWhy(row: Record<string, unknown> | null | undefined, ownCheckFound: boolean): string | null {
  if (!row) return "no gap row";
  const meta = (row["classification_metadata"] ?? {}) as Record<string, unknown>;
  const cs = (meta["check_supply"] && typeof meta["check_supply"] === "object" ? meta["check_supply"] : {}) as Record<string, unknown>;
  const raw = meta["falsifier"];
  const fc = String((raw && typeof raw === "object" ? (raw as { class?: unknown }).class : raw) ?? "").toLowerCase();
  const found = `check_supply.state=${String(cs["state"] ?? "missing")}, falsifier=${fc || "missing"}, red_at_head=${String(cs["red_at_head"] ?? "missing")}, last_verdict=${String(cs["last_verdict"] ?? "missing")}${ownCheckFound ? "" : ", no test_suite own check"}`;
  if (cs["state"] !== "armed" || fc !== "class2" || cs["red_at_head"] !== true || cs["last_verdict"] !== "present" || !ownCheckFound) return found;
  return null;
}

export type LandingRefuseClass = "hold" | "family_hold" | "green_on_parent";
export type Admissibility = { ok: true; note: string } | { ok: false; refuse_class: LandingRefuseClass; reason: string };

/** The one admissibility rule (see LANDING ADMISSIBILITY above). Pure: the cutover gathers the evidence. */
export function landingAdmissible(input: {
  hold: HoldFinding;
  ownCheck: null | { parent: { pass: boolean; measured: boolean; reason: string } };
}): Admissibility {
  const h = input.hold;
  if (h.held) {
    return h.relation === "self"
      ? { ok: false, refuse_class: "hold", reason: `gap ${h.holder} carries operator_hold: ${h.reason}` }
      : { ok: false, refuse_class: "family_hold", reason: `family member ${h.holder} (${h.relation}) carries operator_hold: ${h.reason}` };
  }
  if (input.ownCheck === null) return { ok: true, note: "admitted: no own check" };
  const p = input.ownCheck.parent;
  if (p.measured && p.pass) return { ok: false, refuse_class: "green_on_parent", reason: `the gap's own check is already GREEN on the parent tree (${p.reason}); the candidate is not what makes it pass` };
  if (!p.measured) return { ok: true, note: `admitted: own check green on the candidate; parent run unmeasurable (${p.reason})` };
  return { ok: true, note: `admitted: own check red on the parent (${p.reason}), green on the candidate` };
}
