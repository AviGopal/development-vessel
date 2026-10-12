// THE DRAFTER MODULE (OPEN): WHAT THE DRAFTER IS SHOWN.
//
// feature_compose's closed core (src/resolvers/feature-compose.ts) gathers every fact for a compose under its own
// read allowlist and byte caps, then calls the two functions below through one dynamic import. This module is
// PURE: facts in, a DrafterContext out; no I/O, no tools, no endpoints, no model choice, no environment.
//
//   planDrafterReads(facts)       which extra files to read, which lesson queries to run, how far up the ancestor
//                                 chain to read; the core clamps every request (allowlist, counts, bytes) and
//                                 fulfils only what passes.
//   assembleDrafterContext(facts) the grounding window, the prior-attempt feedback, the principles and lessons, the
//                                 op-budget hint and journal lines. The core validates it (exact keys, prompt
//                                 bytes, op budget, target visibility, mandatory lines) and, on any refusal or
//                                 throw, drafts with its own floor (today's assembly) instead.
//
// Nothing this module returns is read by a gate: the target set, the region, the op-budget ceiling, the lessons
// the no-effect lock enforces and every verdict are computed by the closed core. Version 1 renders exactly what the
// floor renders (the open data golden under src/drafter/golden/ pins that, as a review instrument).
import { regionCandidatesFromText } from "../resolvers/region-probe.js";
import type { DrafterContext, DrafterFacts, DrafterReadPlan } from "./types.js";
import { renderGroundTruth } from "./windows.js";
import { renderOwnCheck } from "./own-check.js";
import { renderPriorFeedback } from "./evidence.js";
import { lessonQueriesFor, renderLessons } from "./lessons.js";

const VERSION = "drafter-v1";
/** The default op budget of a region-named gap with no explicit max_ops (one site per compose, a few edits). */
const REGION_OP_BUDGET = 4;

/** The windowing hints: the region literal first, then the gap's located excerpts, then the spec's long lines. */
function focusHintsOf(f: DrafterFacts): string[] {
  return [f.regionHint, f.gapMeta.matched_excerpt, f.gapMeta.suspected_real_location, f.gapMeta.edit_site, ...f.spec.split("\n").map((l) => l.trim()).filter((l) => l.length >= 20)]
    .filter((h): h is string => typeof h === "string" && h.trim().length >= 12)
    .map((h) => h.trim());
}
/** The centring probes: the region literal, then identifiers mined from the request. */
function probesOf(f: DrafterFacts): string[] {
  return [f.regionHint, ...regionCandidatesFromText(`${f.spec}\n${f.gapSummary}`)].filter(Boolean);
}

export function planDrafterReads(f: DrafterFacts): DrafterReadPlan {
  return { reads: [], lessonQueries: lessonQueriesFor(f), ancestorDepth: 0 };
}

export function assembleDrafterContext(f: DrafterFacts): DrafterContext {
  const journal: string[] = [];
  const focusHints = focusHintsOf(f);
  const targetWindows: Record<string, string> = {};
  let grounding = f.verifyVessels.length > 0 ? renderGroundTruth(f, focusHints, probesOf(f), targetWindows) : "";
  grounding += renderOwnCheck(f, focusHints);
  grounding += f.symbolDecls + f.safeAnchors;
  grounding += f.contracts;
  grounding += f.existingSymbols;
  const priorFeedback = renderPriorFeedback(f, journal);
  if (f.lineageLessons.length > 0) journal.push(`source gap record shown: ${f.lineageLessons.length} lesson(s)`);
  return {
    grounding,
    targetWindows,
    priorFeedback,
    principles: f.principles,
    composeLessons: renderLessons(f),
    netNewTargets: [...f.targets.netNew],
    opBudgetHint: f.regionHint && !f.opCeilingDeclared ? REGION_OP_BUDGET : f.opCeiling,
    journal,
    version: VERSION,
  };
}
