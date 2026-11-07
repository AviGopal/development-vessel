// Landing under semantic dissent: recording and settling a dissent, the dissent child gap, and the landing label a close reason carries. Lifted as-is from feature-compose.ts.
import { class2PredicateKey, resolveSubstrateGap, resolveSubstrateGapWrite as resolveSubstrateGapWriteStore } from "../resolvers/substrate-gap.js";
import { composeObserveSkip } from "../resolvers/compose-observe.js";
import { type SemanticGateVerdict } from "../gates/contract-narrowing.js";

/** Every gap-store write in this file: an observe compose writes none (compose-observe.ts). */
export const resolveSubstrateGapWrite: typeof resolveSubstrateGapWriteStore = async (p) => {
  if (composeObserveSkip("gap_store_write")) return { shape: "substrateGap_write", body: { ok: false, skipped: "observe" } } as Awaited<ReturnType<typeof resolveSubstrateGapWriteStore>>;
  return await resolveSubstrateGapWriteStore(p);
};
/** A gap check's identity for the dissent distinctness rule: the predicate key plus, for a test_suite check, its test names. */
export type CheckIdentity = { key: string; vessel: string | null; test_names: string[] };
export type SemanticDissent = {
  reason: string;
  gate_verdict: SemanticGateVerdict;
  at: string;
  later_outcome: null | { result: "passed" | "failed"; at: string; settled_by?: { gap_id: string; check_key: string } }
    | { result: "superseded"; at: string; settled_by: { landed_sha: string; check_key: string | null } };
  /** Evidence only: object-literal keys the diff added that nothing in the vessel's own src reads. */
  unread_keys?: string[];
  /** Stamped at landing (settleSemanticDissent): the landed commit, the parent's check, the minted child. */
  landed_sha?: string;
  own_check?: CheckIdentity | null;
  child_gap_id?: string;
};
type GapRowDeps = { readGap: (id: string) => Promise<Record<string, unknown> | null>; writeGap: (row: Record<string, unknown>) => Promise<void> };

/**
 * A MERGE write of one classification_metadata key: the store's identity fields from the row just read, and
 * ONLY `key` inside classification_metadata. The store carries every omitted key forward, so a concurrent
 * writer's keys are never reverted by this read's stale snapshot (the stale full-row write class). Status is
 * the row's own, so a write onto a closed gap never reopens it.
 */
function mergeMetadataKeyWrite(row: Record<string, unknown>, key: string, value: unknown): Record<string, unknown> {
  return {
    id: String(row.id ?? ""),
    category: row.category,
    summary: row.summary,
    detected_at: row.detected_at,
    status: row.status ?? "open",
    classification_metadata: { [key]: value },
  };
}
/** The gap store through the shaped substrateGap resolvers (the default for the dissent writer and reader). */
const storeGapRowDeps: GapRowDeps = {
  readGap: async (id) => ((((await resolveSubstrateGap({ type: "substrateGap", id, limit: 1 } as never))?.body as { gaps?: Record<string, unknown>[] } | undefined)?.gaps ?? [])[0] ?? null),
  writeGap: async (row) => { await resolveSubstrateGapWrite({ type: "substrateGap_write", gap: row } as never); },
};
/** The identity of a gap row's check (any predicate form), or null when it carries none. */
export function gapCheckIdentity(meta: Record<string, unknown> | null | undefined): CheckIdentity | null {
  const m = (meta ?? {}) as Record<string, unknown>;
  const er = m["evidence_resolve"] && typeof m["evidence_resolve"] === "object" ? (m["evidence_resolve"] as Record<string, unknown>) : null;
  const vs = typeof m["verify_shape"] === "string" && m["verify_shape"].trim() !== "" ? m["verify_shape"] : null;
  const lit = typeof m["expected_literal"] === "string" && m["expected_literal"] !== "" ? m["expected_literal"] : null;
  const url = typeof m["hardcoded_url"] === "string" && m["hardcoded_url"] !== "" ? m["hardcoded_url"] : null;
  if (!er && !vs && !lit && !url) return null;
  let vessel: string | null = null;
  let names: string[] = [];
  if (er && er["shape"] === "test_suite") {
    const input = (er["input"] && typeof er["input"] === "object" ? er["input"] : {}) as Record<string, unknown>;
    vessel = String(input["vessel"] ?? "").replace(/^repos\//, "") || null;
    names = Array.isArray(input["only_tests"]) ? (input["only_tests"] as unknown[]).filter((t): t is string => typeof t === "string" && t.trim() !== "") : [];
  }
  return { key: `${class2PredicateKey({ evidence_resolve: er, verify_shape: vs })}|${JSON.stringify([lit, url])}`, vessel, test_names: names };
}
/** Are two checks DIFFERENT checks? No identity is never distinct; a shared test name in one vessel is the same check. */
export function checksDistinct(a: CheckIdentity | null | undefined, b: CheckIdentity | null | undefined): boolean {
  if (!a || !b) return false;
  if (a.key === b.key) return false;
  if (a.vessel === b.vessel && a.test_names.some((n) => b.test_names.includes(n))) return false;
  return true;
}
/** A gap minted from a landing's semantic dissent (settleSemanticDissent). */
export function isDissentChild(meta: Record<string, unknown> | null | undefined): boolean {
  const m = (meta ?? {}) as Record<string, unknown>;
  return m["narrowed_from"] === "semantic_dissent" && typeof m["parent_gap_id"] === "string" && m["parent_gap_id"] !== "";
}
/** Why a check proposed for a dissent child cannot be its check (it is the dissented parent's), or null. */
export function dissentChildCheckRefusal(childMeta: Record<string, unknown> | null | undefined, proposed: Record<string, unknown>): string | null {
  if (!isDissentChild(childMeta)) return null;
  const spec = ((childMeta ?? {})["falsifier_spec"] ?? {}) as { must_differ_from?: CheckIdentity | null };
  if (!spec.must_differ_from) return null;
  return checksDistinct(gapCheckIdentity(proposed), spec.must_differ_from) ? null
    : "parent check: it is the dissented parent's own check (or shares its test name), which already passed; the child needs a different one";
}
/**
 * Does this landing carry a semantic dissent? A dissent whose landed_sha is the landing's (either may be
 * abbreviated), or — for a dissent recorded before landed_sha was stamped — one still unsettled.
 */
export function landedUnderDissent(meta: Record<string, unknown> | null | undefined, sha: string | null | undefined): boolean {
  const list = Array.isArray((meta ?? {})["semantic_dissent"]) ? ((meta ?? {})["semantic_dissent"] as Array<Record<string, unknown>>) : [];
  const s = String(sha ?? "").trim();
  return list.some((d) => {
    if (!d || typeof d !== "object") return false;
    if (typeof d.landed_sha === "string" && d.landed_sha !== "") return s.length >= 7 && (d.landed_sha.startsWith(s) || s.startsWith(d.landed_sha));
    return d.later_outcome == null;
  });
}
/**
 * Did the cutover stamp THIS landing landed_unverified? The flag is bound to landed_unverified_sha; a row stamped
 * before the sha was recorded counts as this landing's (partial is the safe reading).
 */
export function landedUnverifiedHere(meta: Record<string, unknown> | null | undefined, sha: string | null | undefined): boolean {
  const m = (meta ?? {}) as Record<string, unknown>;
  if (m["landed_unverified"] !== true) return false;
  const bound = typeof m["landed_unverified_sha"] === "string" ? (m["landed_unverified_sha"] as string).trim() : "";
  if (bound === "") return true;
  const s = String(sha ?? "").trim();
  if (s.length < 7) return true; // the closing landing is unknown: partial is the safe reading
  return bound.startsWith(s) || s.startsWith(bound);
}
/**
 * THE INDEPENDENT LANDING VERDICT (REALIGNMENT §2.1 item 2). The label the EVALUATOR (the pending-land sweep,
 * gap-to-feature independentLandingVerdict) writes after re-running the gap's own check on commit-pinned trees:
 * grounded only when the check was red at the landing's parent and green at the landed sha. Stored on the gap
 * row as classification_metadata.goal_verification_label.
 */
export const LANDING_LABELER = "sweep-parent-child";
export type GoalVerificationLabel = { grounded: boolean; labeler: string; sha: string; parent: string; tests: string[]; ran_at: string; reason?: string; shadow?: boolean; verifier?: { id: string; version: string; kind: string; control: { ref: string; verdict: string }; observed?: { parent: string; landed: string; would_ground: boolean } } };
/**
 * A label for THIS landing, or null. Bound like landedUnverifiedHere binds its flag, but failing the other way: a
 * label from any other labeler (the lander's own claim), an unbound one, or one for another sha is no label at all.
 * A label read from a stored row is a RECORD, never authority: any substrateGap_write writer can set it.
 */
export function landingLabelHere(meta: Record<string, unknown> | null | undefined, sha: string | null | undefined): GoalVerificationLabel | null {
  const l = (meta ?? {})["goal_verification_label"] as Partial<GoalVerificationLabel> | null | undefined;
  if (!l || typeof l !== "object" || l.labeler !== LANDING_LABELER) return null;
  const bound = typeof l.sha === "string" ? l.sha.trim() : "";
  const s = String(sha ?? "").trim();
  if (bound.length < 7 || s.length < 7 || !(bound.startsWith(s) || s.startsWith(bound))) return null;
  return l as GoalVerificationLabel;
}
/**
 * The closed_reason for a landing close: landed_partial under a dissent or when the cutover stamped the landing
 * landed_unverified (own check skipped, typecheck only), else literal-only, else landed_verified ONLY on
 * `independent`: a grounded label for this sha that the sweep computed IN THIS PASS from its own pinned re-run
 * (gap-to-feature independentLandingVerdict). A label stored on the row is not consulted: it is forgeable. Without
 * it the close waits ("awaiting_independent_verdict"): the gap's predicate reading 'absent' at HEAD, the lander's
 * own red->green, or a stored label never verifies a landing by itself.
 */
export function landedCloseReason(meta: Record<string, unknown> | null | undefined, sha: string | null | undefined, literalOnly: boolean, independent: GoalVerificationLabel | null = null): "landed_partial" | "landed_literal_only" | "landed_verified" | "awaiting_independent_verdict" {
  if (landedUnderDissent(meta, sha) || landedUnverifiedHere(meta, sha)) return "landed_partial";
  if (literalOnly) return "landed_literal_only";
  // A SHADOW label (a registered verifier's calibration evidence) never verifies a landing, whatever it claims.
  const l = landingLabelHere({ goal_verification_label: independent }, sha);
  return l?.grounded === true && l.shadow !== true ? "landed_verified" : "awaiting_independent_verdict";
}
/**
 * Append a dissent to the gap row's classification_metadata.semantic_dissent, where calibration reads it.
 * It deliberately does NOT write semantic_gate_reason: priorAttemptFeedbackBlock reads that as "your last
 * draft was rejected", and a landed dissent was not. Called only through settleSemanticDissent.
 */
export async function recordSemanticDissent(gapId: string, dissent: SemanticDissent, deps: GapRowDeps = storeGapRowDeps): Promise<void> {
  const row = await deps.readGap(gapId);
  if (!row || String(row.status ?? "") === "closed") return;
  const meta = (row.classification_metadata as Record<string, unknown>) ?? {};
  const prior = Array.isArray(meta.semantic_dissent) ? (meta.semantic_dissent as unknown[]) : [];
  await deps.writeGap(mergeMetadataKeyWrite(row, "semantic_dissent", [...prior, dissent].slice(-20)));
}
/**
 * NO PHANTOM DISSENT: record a dissent only for a landing that happened — push_status "pushed" with a
 * non-empty new_git_sha. A refused, deferred or unpushed cutover leaves no entry (a parked landing carries
 * its dissent to the resume, which settles it then). Never throws: a lost record is logged, not fatal.
 *
 * A pushed landing under dissent is PARTIAL: the record is stamped with the landed sha (landedCloseReason
 * reads it to close landed_partial) and the parent's check identity (resolveDissentOutcome reads it, so that
 * check can never settle the dissent "passed"), and the dissent's reason is minted into a narrowed child gap.
 *
 * STALE DISSENT (qa 2a): a pushed landing with NO dissent (its own gate agreed) supersedes the gap's unsettled
 * dissents of OTHER landings (supersedeStaleDissents), so a dissent never freezes the gap partial forever.
 */
export async function settleSemanticDissent(
  gapId: string,
  dissent: SemanticDissent | null | undefined,
  cutoverResult: unknown,
  deps: GapRowDeps = storeGapRowDeps,
): Promise<"recorded" | "superseded" | "not_landed" | "none" | "write_failed"> {
  if (!gapId) return "none";
  const r = (cutoverResult ?? {}) as Record<string, unknown>;
  const pushed = r["push_status"] === "pushed" && typeof r["new_git_sha"] === "string" && String(r["new_git_sha"]).trim() !== "";
  if (!dissent) {
    if (!pushed) return "none";
    try { return (await supersedeStaleDissents(gapId, String(r["new_git_sha"]).trim(), deps)) > 0 ? "superseded" : "none"; } catch (err) {
      console.warn(`[fc-semantic-dissent] gap=${gapId}: stale dissents NOT superseded (${(err as Error)?.message ?? String(err)}); the landing may still read partial`);
      return "write_failed";
    }
  }
  if (!pushed) return "not_landed";
  const sha = String(r["new_git_sha"]).trim();
  try {
    const row = await deps.readGap(gapId);
    const own = gapCheckIdentity((row?.classification_metadata as Record<string, unknown> | undefined) ?? {});
    const stamped: SemanticDissent = { ...dissent, landed_sha: sha, own_check: own };
    let childId: string | null = null;
    if (row && String(row.status ?? "") !== "closed") {
      try { childId = await mintDissentChild(row, stamped, deps); } catch (err) {
        console.warn(`[fc-semantic-dissent] gap=${gapId}: the dissent child was NOT minted (${(err as Error)?.message ?? String(err)}); the landing stays partial`);
      }
    }
    await recordSemanticDissent(gapId, childId ? { ...stamped, child_gap_id: childId } : stamped, deps);
    return "recorded";
  } catch (err) {
    console.warn(`[fc-semantic-dissent] gap=${gapId}: landed under dissent but the record was NOT written (${(err as Error)?.message ?? String(err)}) — calibration loses this sample`);
    return "write_failed";
  }
}
/**
 * A landing whose own gate AGREED supersedes every unsettled dissent of another landing on the gap:
 * later_outcome {result:"superseded", settled_by:{landed_sha, check_key}}. That landing then closes on its
 * own evidence (landedCloseReason: landed_verified). A dissent stamped with THIS sha is left alone. Returns the count.
 */
async function supersedeStaleDissents(gapId: string, sha: string, deps: GapRowDeps): Promise<number> {
  const row = await deps.readGap(gapId);
  if (!row) return 0;
  const meta = (row.classification_metadata as Record<string, unknown>) ?? {};
  const list = Array.isArray(meta.semantic_dissent) ? (meta.semantic_dissent as Array<Record<string, unknown>>) : [];
  const check = gapCheckIdentity(meta);
  const at = new Date().toISOString();
  let n = 0;
  const next = list.map((d) => {
    if (!d || d.later_outcome != null) return d;
    if (typeof d.landed_sha === "string" && d.landed_sha !== "" && (d.landed_sha.startsWith(sha) || sha.startsWith(d.landed_sha))) return d;
    n += 1;
    return { ...d, later_outcome: { result: "superseded", at, settled_by: { landed_sha: sha, check_key: check?.key ?? null } } };
  });
  if (n === 0) return 0;
  await deps.writeGap(mergeMetadataKeyWrite(row, "semantic_dissent", next));
  console.log(`[fc-semantic-dissent] gap=${gapId}: ${n} stale dissent(s) superseded by landing ${sha.slice(0, 12)}, which the gate agreed with`);
  return n;
}
/**
 * THE DISSENT BECOMES THE NEXT GAP: a narrowed child of the landed parent, built by the one narrowed-child
 * builder (gap-to-feature narrowedChildRecord). It keeps the parent's edit_site and drops every check of the
 * parent's (already green on the landed tree, so a copy would be born satisfied); its falsifier_spec names the
 * parent's check as the one its own must differ from (read by dissentChildCheckRefusal when decomposeGap
 * derives the child's check, and by resolveDissentOutcome when the child settles the parent's dissent).
 */
async function mintDissentChild(parent: Record<string, unknown>, d: SemanticDissent, deps: GapRowDeps): Promise<string> {
  const { narrowedChildRecord } = await import("../judge/gap-attempt-credit.js");
  const parentId = String(parent.id ?? "");
  const id = `${parentId}-dissent-narrowed`;
  const names = d.own_check?.test_names ?? [];
  const tail = `\n\nLANDED UNDER SEMANTIC DISSENT at ${String(d.landed_sha ?? "").slice(0, 12)}: the gap's own check went red->green, but the semantic gate refused the change: ${d.reason.slice(0, 800)}`
    + (d.unread_keys && d.unread_keys.length > 0 ? `\nKeys the change added that nothing in this vessel's own src reads (evidence only: another vessel may read them): ${d.unread_keys.join(", ")}.` : "")
    + `\nThis gap is the part the gate said is missing. Its check must FAIL on today's tree and must be a different check from the parent's own${names.length > 0 ? ` (${names.join("; ").slice(0, 300)})` : ""}, which already passes.`;
  const child = narrowedChildRecord(parent, (parent.classification_metadata as Record<string, unknown>) ?? {}, {
    id,
    checks: "drop",
    summaryTail: tail,
    extra: {
      narrowed_from: "semantic_dissent",
      dissent: { reason: d.reason, gate_verdict: d.gate_verdict, at: d.at, landed_sha: d.landed_sha ?? null, ...(d.unread_keys && d.unread_keys.length > 0 ? { unread_keys: d.unread_keys } : {}) },
      falsifier_spec: { derived_from: "semantic_dissent", must_differ_from: d.own_check ?? null, must_fail_on_landed_tree: true },
    },
  });
  await deps.writeGap(child);
  console.log(`[fc-semantic-dissent] gap=${parentId}: landed partial at ${String(d.landed_sha ?? "").slice(0, 12)}; minted ${id} from the dissent`);
  return id;
}
/**
 * THE READER: a post-land check resolved. Fill later_outcome {result, at} on the gap's pending dissents;
 * resolved entries are untouched; nothing to fill writes nothing. Called by the pending-land sweep
 * (gap-to-feature sweepPendingLandVerificationsOnce). Returns the count filled.
 *
 * NOT BY THE SAME CHECK: the sweep's "passed" is this row's own check, and a dissent landed because that check
 * went red->green, so it cannot also prove the gate wrong. "passed" fills a dissent only when the row's check
 * is DISTINCT from the dissent's own_check (checksDistinct); a dissent recorded before own_check was stamped is
 * taken to have landed on the row's check. "failed" (reverted, measured present while running) fills on any route.
 * A dissent child closing "passed" settles its PARENT's pending dissents, when its check is distinct from the
 * parent's (settled_by names the child and its check).
 */
export async function resolveDissentOutcome(gapId: string, outcome: { result: "passed" | "failed"; at?: string }, deps: GapRowDeps = storeGapRowDeps): Promise<number> {
  if (!gapId) return 0;
  const row = await deps.readGap(gapId);
  if (!row) return 0;
  const meta = (row.classification_metadata as Record<string, unknown>) ?? {};
  const list = Array.isArray(meta.semantic_dissent) ? (meta.semantic_dissent as Array<Record<string, unknown>>) : [];
  const at = outcome.at ?? new Date().toISOString();
  const settling = gapCheckIdentity(meta);
  let filled = 0;
  let refused = 0;
  const next = list.map((d) => {
    if (!d || d.later_outcome != null) return d;
    if (outcome.result === "passed" && !checksDistinct(settling, (d.own_check as CheckIdentity | null | undefined) ?? settling)) { refused += 1; return d; }
    filled += 1;
    return { ...d, later_outcome: { result: outcome.result, at } };
  });
  if (refused > 0) console.log(`[fc-semantic-dissent] gap=${gapId}: ${refused} dissent(s) NOT settled passed — the check that passed is the one the gate doubted`);
  if (filled > 0) await deps.writeGap(mergeMetadataKeyWrite(row, "semantic_dissent", next));
  if (outcome.result === "passed" && isDissentChild(meta)) filled += await settleParentDissentByChild(gapId, meta, settling, at, deps);
  return filled;
}
async function settleParentDissentByChild(childId: string, childMeta: Record<string, unknown>, childCheck: CheckIdentity | null, at: string, deps: GapRowDeps): Promise<number> {
  const parentId = String(childMeta.parent_gap_id ?? "");
  const mustDiffer = ((childMeta.falsifier_spec ?? {}) as { must_differ_from?: CheckIdentity | null }).must_differ_from ?? null;
  const parent = parentId ? await deps.readGap(parentId) : null;
  if (!parent || !childCheck) return 0;
  const pm = (parent.classification_metadata as Record<string, unknown>) ?? {};
  const list = Array.isArray(pm.semantic_dissent) ? (pm.semantic_dissent as Array<Record<string, unknown>>) : [];
  let filled = 0;
  const next = list.map((d) => {
    if (!d || d.later_outcome != null || d.child_gap_id !== childId) return d;
    const own = (d.own_check as CheckIdentity | null | undefined) ?? mustDiffer;
    if (!checksDistinct(childCheck, own) || (mustDiffer && !checksDistinct(childCheck, mustDiffer))) return d;
    filled += 1;
    return { ...d, later_outcome: { result: "passed", at, settled_by: { gap_id: childId, check_key: childCheck.key } } };
  });
  if (filled > 0) await deps.writeGap(mergeMetadataKeyWrite(parent, "semantic_dissent", next));
  return filled;
}
