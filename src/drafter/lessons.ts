// KNOWN FAILURE MODES AND PER-FILE LESSONS, AS SHOWN TO THE DRAFTER (open copy of feature-compose's
// COMPOSE_LESSON_GUIDANCE and of the renderers of composeLessonsBlock and fileLessonsBlock). Pure: the concept-db
// rows and the JSONL lines are what the closed recall read; which lesson WRITES happen, and the class each failure is
// written as, stay closed.
import type { DrafterFacts, LessonQuery } from "./types.js";
import { renderSuccessCriterion } from "./prompt.js";

export const COMPOSE_LESSON_GUIDANCE: Readonly<Record<string, string>> = {
  empty_diff_identity_edit: "every edit op MUST carry a non-empty old_string copied VERBATIM from the current file content and a new_string that DIFFERS from it — an op whose applied diff is empty is a hard reject",
  anchor_not_found: "old_string anchors must be copied verbatim from the CURRENT file content shown in the grounding — never reconstructed from memory",
  typecheck_dangling_reference: "a symbol you USE must be DECLARED in the same plan — if the new_string references a constant, helper or type, either it already exists in the grounding or your plan must add its declaration too; and when deleting or renaming a symbol, update EVERY reference to it in the same plan — search the grounding for the symbol name first",
  syntax_break: "the new_string must be syntactically complete ON ITS OWN — count the brackets and quotes you open and close, and never leave a call, string or arrow body unterminated; a replacement that splices anchor text or a placeholder such as dollar-ampersand into the middle of an expression is the usual cause; and deletions must respect block structure — never delete across a function or brace boundary",
  partial_spec_omission: "if the spec lists N numbered items, the plan must implement ALL N — partial implementations are rejected",
  wrong_location: "anchor each edit to the EXACT symbol/site named in the spec, not a similarly-named one",
  dead_insertion_unwired: "new code must be WIRED to a live path (registered, imported AND called) — declared-but-never-used insertions are rejected",
  mis_localized_path: "only touch file paths that appear in the grounding file tree — never invent vessel or file names",
  verify_failed: "the edited vessel must pass strict tsc after the change",
  semantic_reject: "the diff must concretely address the spec on a live code path — and for a complaint about something being WRONG or UNREADABLE, correct it rather than remove it. Blanking, zeroing, hiding or emptying the value someone complained about satisfies the words and fails the person: 'the elapsed column keeps counting after a run finished' wants the FINAL duration held still, not '0s'. Before writing the op, state what the surface should READ after the fix, and make the op produce that",
};

/** Extra concept-db recall this module asks the core for (phase 1: none; the closed recall's own query is a fact). */
export function lessonQueriesFor(_f: DrafterFacts): LessonQuery[] {
  return [];
}

/** KNOWN FAILURE MODES: the concept-db rows (with the latest actual rejection per class), else JSONL class counts. */
export function renderComposeLessons(f: DrafterFacts): string {
  const hit = f.lessonSource === "concept-db" ? f.lessonHits[0] : undefined;
  if (hit && hit.rows.length > 0) {
    const latestByClass = new Map<string, string>();
    for (const line of f.lessonJsonlTail) { try { const rec = JSON.parse(line) as { class?: string; reason?: string }; if (rec.class && rec.reason) latestByClass.set(rec.class, rec.reason); } catch { /* skip unparseable line */ } }
    const obs = [...latestByClass.entries()].slice(-8).map(([c, r]) => `- ${c}: ${r.replace(/\s+/g, " ").trim().slice(0, 300)}`).join("\n");
    const obsBlock = obs ? `\n\nMOST RECENT ACTUAL REJECTION per class — verbatim judge verdicts on real composes, not general advice:\n${obs}` : "";
    return `\n\nKNOWN FAILURE MODES from this substrate's own rejected composes — plans repeating these are rolled back:\n${hit.rows.map((r) => `- ${r}`).join("\n")}${obsBlock}`;
  }
  if (f.lessonSource !== "jsonl") return "";
  const counts = new Map<string, number>();
  for (const l of f.lessonJsonlTail) { try { const r = JSON.parse(l) as { class?: string }; if (r.class) counts.set(r.class, (counts.get(r.class) ?? 0) + 1); } catch { /* skip bad line */ } }
  if (counts.size === 0) return "";
  const rows = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8)
    .map(([cls, n]) => `- (${n}x) ${cls}: ${COMPOSE_LESSON_GUIDANCE[cls] ?? "avoid repeating this failure class"}`);
  return `\n\nKNOWN FAILURE MODES from this substrate's own rejected composes — plans repeating these are rolled back:\n${rows.join("\n")}`;
}

/** PRIOR TYPECHECK FAILURES / CONSEQUENCES OF EARLIER LANDINGS on the files this spec names. */
export function renderFileLessons(f: DrafterFacts): string {
  const specText = f.spec;
  if (!specText) return "";
  const relevant: Array<{ at: string; files: string[]; tsc: string; kind?: string }> = [];
  for (const ln of f.fileLessonsTail) {
    try {
      const e = JSON.parse(ln) as { at?: string; files?: string[]; tsc?: string; kind?: string };
      if (!Array.isArray(e.files) || !e.tsc) continue;
      if (e.files.some((x) => specText.includes(String(x)) || specText.includes(String(x).split("/").pop() ?? String(x)))) {
        relevant.push({ at: e.at ?? "", files: e.files.map(String), tsc: String(e.tsc), kind: typeof e.kind === "string" ? e.kind : undefined });
      }
    } catch { /* skip malformed line */ }
  }
  if (relevant.length === 0) return "";
  const consequences = relevant.filter((r) => r.kind === "attempt_consequence");
  const tscOnly = relevant.filter((r) => r.kind !== "attempt_consequence");
  let block = "";
  if (tscOnly.length > 0) {
    block += "\n\nPRIOR TYPECHECK FAILURES ON THESE FILES (verbatim diagnostics from earlier failed attempts on the same files — your op plan MUST avoid re-introducing these errors; declare each new variable exactly once, in the correct scope):\n" + tscOnly.slice(-3).map((r) => `- [${r.at}] files=${r.files.join(",")}\n${r.tsc.slice(0, 1500)}`).join("\n");
  }
  if (consequences.length > 0) {
    block += "\n\nCONSEQUENCES OF EARLIER LANDINGS ON THESE FILES (causal attempt ledger: a change that landed on these files later broke a check — do not repeat it):\n" + consequences.slice(-3).map((r) => `- [${r.at}] files=${r.files.join(",")}: ${r.tsc.slice(0, 600)}`).join("\n");
  }
  return block;
}

/** A seed file (src/seed/**): an activity template the runtime reads, delivered by seed version. */
const SEED_PATH_RE = /(?:^|\/)src\/seed\/[^\s]+\.ts\b/;

/**
 * SEED DELIVERY, for a compose whose edit site or targets are under src/seed/: the fact the drafter needs at the moment
 * it edits a seed template (verify refuses the edit without it: src/seed-delivery-verify.ts).
 */
export function renderSeedDeliveryLesson(f: DrafterFacts): string {
  const sites = [String(f.gapMeta["edit_site"] ?? ""), ...f.targets.files];
  if (!sites.some((s) => SEED_PATH_RE.test(s))) return "";
  return "\n\nSEED TEMPLATES (src/seed/): a running substrate re-uploads an activity seed template only when its metadata.seed_version rises above the registered one (seed delivery skips a template whose seed_version is absent or unchanged), so an edit to a template's tasks or their config that does not raise metadata.seed_version never reaches the runtime, and verify refuses it. In the same edit, raise metadata.seed_version by one (add metadata: { seed_version: 1 } when the template has none). A template's config is read by its task's resolver: a change is only real if that resolver behaves differently with it, and it must keep doing what it did before.";
}

/** The lesson text the decompose prompt (after the principles) and the refine prompt read. */
export function renderLessons(f: DrafterFacts): string {
  return renderComposeLessons(f) + renderFileLessons(f) + renderSuccessCriterion(f) + renderSeedDeliveryLesson(f);
}
