// PRIOR-ATTEMPT EVIDENCE, AS SHOWN TO THE DRAFTER (open copy of feature-compose's priorAttemptFeedbackBlock and of
// retry-evidence's attemptEvidenceBlock, noEffectSpans, activeMustBeCalled and parentCheckBlock). Pure. These render
// what the closed store read returned; the no-effect lock and the must_be_called constraint ENFORCE the same lessons
// in closed code (retry-evidence.ts), whatever is shown here. The core checks that every refused region and active
// constraint the floor shows is still shown (the mandatory-line clamp).
import type { DrafterFacts, LessonRecord } from "./types.js";

type Span = { path: string; start: number; end: number };
type Refusal = { path: string; start: number; end: number; region_sha: string; region_start: number; region_end: number; kind?: string };
type Failure = { name: string; error?: string; expected?: string; received?: string; diff?: string };
type Constraint = { kind: "must_be_called"; symbol: string; introduced_in: string; derived?: true };

const IDENT = /^[A-Za-z_$][\w$]*$/;
const UNCALLED_REASON_RE = /\b(not called|never called|uncalled|no call[- ]?sites?|no callers?|not invoked|never invoked|dead code|unreachable|not referenced|never referenced|unused)\b/i;

/** The no-effect spans recorded on a lesson list (records with no_effect_vs_parent === true). */
export function noEffectSpans(lessons: unknown): Span[] {
  if (!Array.isArray(lessons)) return [];
  const out: Span[] = [];
  for (const l of lessons as LessonRecord[]) {
    if (!l || l.no_effect_vs_parent !== true || !Array.isArray(l.edited_spans)) continue;
    for (const s of l.edited_spans as Span[]) if (s && typeof s.path === "string" && Number.isInteger(s.start) && Number.isInteger(s.end)) out.push(s);
  }
  return out;
}

function legacyMustBeCalled(l: LessonRecord): Constraint[] {
  if (Array.isArray(l.constraints) || l.class !== "semantic_reject") return [];
  const reason = String(l.raw_excerpt ?? l.reason ?? "");
  if (!UNCALLED_REASON_RE.test(reason)) return [];
  const at = Array.isArray(l.edited_spans) ? String((l.edited_spans as Span[])[0]?.path ?? "") : "";
  const syms = new Set([...reason.matchAll(/`([A-Za-z_$][\w$]*)(?:\(\))?`/g)].map((m) => m[1]!).filter((x) => IDENT.test(x)));
  return [...syms].map((symbol) => ({ kind: "must_be_called" as const, symbol, introduced_in: at, derived: true as const }));
}

/** The must_be_called constraints in force over a lesson list: each symbol's latest record, unless lifted later. */
export function activeMustBeCalled(lessons: unknown, gapStatus = ""): Constraint[] {
  if (!Array.isArray(lessons) || gapStatus === "closed" || gapStatus === "superseded") return [];
  const act = new Map<string, Constraint>();
  for (const l of lessons as LessonRecord[]) {
    if (!l) continue;
    for (const c of legacyMustBeCalled(l)) act.set(c.symbol, c);
    for (const c of (Array.isArray(l.constraints) ? l.constraints : []) as Constraint[]) {
      if (c && c.kind === "must_be_called" && typeof c.symbol === "string" && IDENT.test(c.symbol)) act.set(c.symbol, { kind: "must_be_called", symbol: c.symbol, introduced_in: String(c.introduced_in ?? ""), ...(c.derived ? { derived: true as const } : {}) });
    }
    for (const x of (Array.isArray(l.constraints_lifted) ? l.constraints_lifted : []) as Array<{ symbol?: unknown }>) if (x && typeof x.symbol === "string") act.delete(x.symbol);
  }
  return [...act.values()];
}

/** The PRIOR ATTEMPT RECORD block: per structured attempt, where it failed, what it edited, its effect on the own
 *  check, the check's failing lines; then the refused regions and the active constraints. */
export function attemptEvidenceBlock(lessons: unknown, max = 3): string {
  if (!Array.isArray(lessons)) return "";
  const recs = (lessons as LessonRecord[]).filter((l) => l && (Array.isArray(l.edited_spans) || l.own_check || l.stage)).slice(-max);
  const active = activeMustBeCalled(lessons);
  if (recs.length === 0 && active.length === 0) return "";
  const lines: string[] = ["", "PRIOR ATTEMPT RECORD (measured on the previous drafts of THIS gap; data, not advice):"];
  for (const r of recs) {
    const spans = (Array.isArray(r.edited_spans) ? (r.edited_spans as Span[]) : []).map((s) => `${s.path}:${s.start}-${s.end}`);
    const eff = r.no_effect_vs_parent === true ? "NO EFFECT (the own check failed identically on the parent)" : r.no_effect_vs_parent === false ? "changed the own check's output" : "not measured";
    lines.push(`- attempt ${String(r.at ?? "?")}: failed at stage ${String(r.stage ?? "unknown")}; class ${String(r.class ?? "?")}; edited ${spans.length ? spans.join(", ") : "(nothing applied)"}; effect vs parent: ${eff}`);
    const allRefs = Array.isArray(r.refusals) ? (r.refusals as Refusal[]) : [];
    const refs = allRefs.filter((x) => x.kind !== "must_be_called");
    const crefs = allRefs.filter((x) => x.kind === "must_be_called");
    if (refs.length) lines.push(`    refused by the no-effect lock: ${refs.map((x) => `${x.path}:${x.start}-${x.end} (locked ${x.region_start}-${x.region_end})`).join(", ")}${r.escalation ? `; escalated: ${String((r.escalation as { outcome?: string }).outcome ?? "")}` : ""}`);
    if (crefs.length) lines.push(`    refused by a constraint: ${crefs.map((x) => x.region_sha.replace(/^must_be_called:/, "must_be_called(") + ")").join(", ")}${!refs.length && r.escalation ? `; escalated: ${String((r.escalation as { outcome?: string }).outcome ?? "")}` : ""}`);
    const dropped = Array.isArray(r.dropped_paths) ? (r.dropped_paths as unknown[]).map(String) : [];
    if (dropped.length) lines.push(`    dropped by the file-scope gate (not applied): ${dropped.join(", ")}${r.dropped_reason ? ` — ${String(r.dropped_reason)}` : ""}`);
    const oc = r.own_check as { test_file?: string; failing?: Failure[] } | undefined;
    for (const f of (oc?.failing ?? []).slice(0, 4)) {
      lines.push(`    own check ${String(oc?.test_file ?? "")} (fail) ${f.name}`);
      if (f.error) lines.push(`      ${f.error}`);
      if (f.expected) lines.push(`      ${f.expected}`);
      if (f.received) lines.push(`      ${f.received}`);
      if (f.diff) for (const d of f.diff.split("\n").slice(0, 8)) lines.push(`      ${d}`);
    }
  }
  const refused = noEffectSpans(lessons).map((s) => `${s.path}:${s.start}-${s.end}`);
  if (refused.length) lines.push(`REFUSED REGIONS (an edit op overlapping one of these is refused before it is written): ${[...new Set(refused)].join(", ")}`);
  for (const c of active) lines.push(`CONSTRAINT must_be_called(${c.symbol}) (introduced in ${c.introduced_in || "?"}): a draft that defines ${c.symbol} is refused before verify unless it also calls it on the live path, outside its own definition. A call in a test file, a comment or string, dead code (if (false), after a return) or a call whose result is discarded does not count.`);
  return lines.join("\n");
}

/** The prior-attempt feedback for this gap: a landed attempt, the gate's rejection, the per-gap lessons. Lines that
 *  say which blocks were shown go to `journal`. */
export function priorAttemptFeedbackBlock(meta: Readonly<Record<string, unknown>> | null | undefined, journal: string[]): string {
  if (!meta) return "";
  const reason = typeof meta.semantic_gate_reason === "string" ? meta.semantic_gate_reason.trim() : "";
  const loc = typeof meta.suspected_real_location === "string" ? meta.suspected_real_location.trim() : "";
  const lessons = (Array.isArray(meta.failure_lessons) ? meta.failure_lessons : []) as LessonRecord[];
  const landedSha = typeof meta.pending_outcome_verification === "string" && (meta.pending_outcome_verification as string).trim().length >= 7
    ? (meta.pending_outcome_verification as string).trim()
    : "";
  if (!reason && !loc && lessons.length === 0 && !landedSha) return "";
  const lines: string[] = [];
  if (landedSha) {
    journal.push(`prior-landed-attempt block shown for commit ${landedSha}`);
    lines.push(
      "",
      `PRIOR LANDED ATTEMPT — a previous draft for THIS gap PASSED the semantic gate and LANDED as commit ${landedSha}. The change is ALREADY IN THE FILE you are about to edit.`,
      "- Do NOT re-apply it, and do NOT revert it. Read the current file: if the described change is already present, the remaining work is whatever the gap asks for that is NOT yet there.",
      "- If nothing is left to do, say so and produce NO edit. An empty diff is a correct answer here; re-editing the same lines is not.",
      "- This gap is still open because its closure could not be VERIFIED, not because the fix failed. An open gap is not evidence that the previous attempt was wrong.",
    );
  }
  if (reason || loc || lessons.length > 0) {
    lines.push("", "PRIOR ATTEMPT FEEDBACK — a previous draft for THIS gap was REJECTED by the semantic gate. Do NOT repeat it; your plan MUST address what it missed:");
  }
  if (typeof meta.verify_failure_reason === "string" && meta.verify_failure_reason.trim()) lines.push(`- Verify failure from prior attempt: ${meta.verify_failure_reason.trim()}`);
  if (reason) lines.push(`- Rejection reason: ${reason}`);
  if (loc) lines.push(`- The real change site is: ${loc}. Your fix MUST edit that specific path/lines (not just adjacent or related code).`);
  const evidence = attemptEvidenceBlock(lessons);
  if (evidence) {
    journal.push(`prior-attempt record block shown: ${lessons.filter((l) => l && (l.stage || l.own_check)).length} structured attempt(s), ${noEffectSpans(lessons).length} refused region(s)`);
    lines.push(evidence);
  }
  if (lessons.length > 0) {
    lines.push("PER-GAP FAILURE LESSONS — this exact mistake was already made on THIS gap; a plan repeating it will be rolled back:");
    for (const entry of lessons.slice(-5)) {
      lines.push(`- ${String(entry.class)}: ${String(entry.reason)}`);
      if (typeof entry.raw_excerpt === "string" && entry.raw_excerpt.length > String(entry.reason).length) {
        lines.push(`  raw verify output (verbatim, from the prior failed attempt): ${entry.raw_excerpt.slice(0, 1500)}`);
      }
    }
  }
  if (reason || loc || lessons.length > 0) {
    lines.push("- A fix that again leaves the named path/lines untouched will be REJECTED again. Target the exact location the gate identified.");
  }
  return lines.join("\n");
}

/** The prompt line(s) for a decomposed step's parent check. */
export function parentCheckBlock(pc: DrafterFacts["parentCheck"]): string {
  if (!pc) return "";
  const lines = [`- This gap derives from parent gap ${pc.gap_id}. The parent's check (what must turn green for the parent to close): ${JSON.stringify(pc.check).slice(0, 400)}`];
  for (const f of pc.failing.slice(0, 3)) lines.push(`    parent check (fail) ${f.name}${f.expected ? ` | ${f.expected}` : ""}${f.received ? ` | ${f.received}` : ""}`);
  return lines.join("\n");
}

/** The feedback block for this compose: the gap's own history, then its source gap's record (same defect). */
export function renderPriorFeedback(f: DrafterFacts, journal: string[]): string {
  const lineage = f.lineageLessons.length > 0 ? attemptEvidenceBlock(f.lineageLessons) : "";
  return priorAttemptFeedbackBlock(f.gapMeta, journal) + (lineage ? `\n(the record below is this gap's SOURCE gap's; it is the same defect, and its refused regions are enforced here too)${lineage}` : "");
}
