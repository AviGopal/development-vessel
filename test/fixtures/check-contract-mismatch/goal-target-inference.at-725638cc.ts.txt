import { registryFieldFor, registryRatioFor } from "./registry-field";
import { verbatimReadTarget } from "./verbatim-read";
import { isMutationShape } from "./judge/shapes";
import { goalDemandsArtifact, isReadQuestionGoal } from "./read-goal";
import { isShapeName } from "./shape-name";
import { betaSample } from "./beta-sample";
import { describedCandidatesBlock, lexicalChoice, validity, type Candidate, type ChooserTier, type ShapeCatalog } from "./described-producers";
import { NOVEL_OPTION, RESIDUAL_OPTION, parseNovel, parseResidual, type NovelTarget } from "./novel-target";
/**
 * Goal→target-shape inference (lever 4, 2026-06-25).
 *
 * A natural-language goal dispatched with only {goal} (no expected_output_shapes
 * and no targetTemplateId) gives the shape-graph walk NO target, so it runs in
 * opportunistic mode and selects the highest-Thompson tick (e.g. an obsidian
 * bridge) irrespective of goal relevance — failing hollow. We seed the walk by
 * inferring the 1-3 output impulse shapes whose production would satisfy the goal,
 * reusing the verifyGoalReached LLM pattern but at the FRONT of the walk.
 *
 * The model is CONSTRAINED to the known producible-shape vocabulary (discovery's
 * advertised shapes — the set the walk can actually backward-chain / mint to), and
 * the result is filtered against that vocabulary so hallucinated shapes are dropped.
 * Returns [] on LLM-down / parse-fail / empty (caller falls back to opportunistic).
 *
const MAX_TARGET_SHAPES = 3;
 * Extracted into its own module (not inlined in index.ts) so it is unit-testable
 * without booting the vessel's HTTP server, and so `fetch` can be injected.
 */

export type FetchLike = typeof fetch;

// Stable, non-time-based hash of the goal text for caching (mirrors the goal_hash
// activity-api keys goal_execution_paths by: a deterministic digest of the goal).
// FNV-1a 32-bit. NOT Date.now()-based — same goal must map to the same key so the
// cache actually deduplicates LLM calls across retries / re-dispatches.
export function goalHashOf(goal: string): string {
  // Key on WORK, not surface form (§12.6 step 5, 2026-08-14). Coalesce TRIVIAL rephrasings — case,
  // whitespace runs, and line-wrapping — so identical work shares ONE cell instead of scattering
  // across cells keyed by surface form. NFC handles Unicode equivalence; lowercase + whitespace
  // collapse + trim strips variation that is NOT work.
  //
  // The prior form hashed the raw text AND suffixed the LINE COUNT — pure surface form — so
  // "Produce a report" and "produce  a\nreport" keyed DIFFERENT cells for identical work. This is
  // goal-host-LOCAL (inference cache, router-buffer ids, lexical-rebind donor key); activity-api
  // keys its persistent per-goal posteriors from goal_text independently, so this does NOT re-key
  // stored learning — it only sharpens local coalescing / rebind matching across rephrasings.
  const normalized = goal.normalize("NFC").toLowerCase().replace(/\s+/g, " ").trim().replace(/[.,!?;:]+$/, "");
  let hash = 2166136261 >>> 0; // FNV-1a 32-bit offset basis
  for (let i = 0; i < normalized.length; i++) {
    hash ^= normalized.charCodeAt(i);
    hash = (hash * 16777619) >>> 0; // FNV prime
  }
  return hash.toString(16).padStart(8, "0");
}

const INFER_CACHE_MAX = 512;
const MAX_TARGET_SHAPES = 3;

export interface GoalTargetDecision {
  shapes: string[];
  confidence: number;
  alternatives: string[][];
  /** I-T (i): with a shape catalog, every shape proposed or considered, with its validity and (if invalid) why. */
  candidates?: Candidate[];
  /** I-T (i): who chose among the valid candidates. */
  chooser_tier?: ChooserTier;
  /** J2b: the chooser found NO candidate whose production satisfies the goal, and described what is needed (novel-target.ts). */
  novel?: NovelTarget;
  /** Piece 5: what the chosen set leaves unsatisfied, in the chooser's words, and what the one residual recall added. */
  residual?: { text: string; recalled: string[]; added: string[]; unknown?: true };
  /** The selection's decision-time record (on the FINAL decision only, carried to the dispatch record): every candidate
   *  set with its (s, f), the set chosen, the targets excluded, the failed targets the guard kept because the goal's own
   *  words demand them, and whether the routes were re-asked. */
  target_selection?: { candidates: Array<{ shapes: string[]; s: number; f: number }>; chosen: string[]; excluded: string[]; kept: string[]; reasked: boolean };
}

export interface InferGoalTargetShapesOpts {
  /** Targets the goal's LATEST attempt failed on with no artifact (CHANGE-35 / A2b-minimal): not chosen again. */
  excludeTargets?: readonly string[];
  /** Set only on the retry's single re-ask (inferGoalTargetDecision): the routes skip their memo and the deterministic
   *  shortcuts (which would propose the same set again) and the chooser is told not to propose these shapes. */
  doNotPropose?: readonly string[];
  llmEndpoint?: string;
  /** Injectable for tests; defaults to global fetch. */
  fetchImpl?: FetchLike;
  maxTargetShapes?: number;
  /** In-process cache keyed by goal_hash; pass a shared Map to persist across calls. */
  cache?: Map<string, string[]>;
  model?: string;
  timeoutMs?: number;
  /**
   * Optional routed-completion hook. When provided, the LLM call is delegated to
   * this (the goal-host LLM router picks the vessel/model per task type and learns
   * from the outcome) instead of the built-in fetch. Returns the completion text,
   * or null on failure. Keeps this module testable and endpoint-agnostic.
   */
  complete?: (prompt: string) => Promise<string | null>;
  decisionCache?: Map<string, GoalTargetDecision>;
  /** The FINAL decision (after the read rule and the retry exclusion), keyed by goal_hash: what the caller dispatches
   *  and what its readers (failure memory, path record, reach gate fallback) must see. `decisionCache` is the routes'
   *  memo of the UNFILTERED decision and is not that (CHANGE-35 A2b-min repair). */
  finalDecisionCache?: Map<string, GoalTargetDecision>;
  /** This goal class's recorded paths (activity-api GET /v2/goal-paths?goal_text=): each row's target set and its
   *  reach counters. When given, the proposed target sets are RE-RANKED by a Thompson draw over them (A2b-proper). */
  targetPosterior?: readonly TargetPathRow[];
  /** J4: this goal's failure-memory rows since its last reach, supplied only when paths are not recorded (observe). */
  failureRows?: readonly TargetPathRow[];
  /** Shapes the caller expects the goal to produce; when undefined, infer from goal. */
  expectedOutputShapes?: string[];
  /** A pre-pinned target template id; when provided, skip inference. */
  firstTarget?: string;
  /** I-T (i): what each advertised shape produces (discovery's shape descriptions) and, where known, what it requires.
   *  When given, targets are VALID described producers (described-producers.ts). */
  shapeCatalog?: ShapeCatalog;
  /** I-T (i): shapes present in the pool at choice time (binds a producer's pool-sourced required input). */
  poolShapes?: readonly string[];
  /** I-T structural (piece 3): the BOUNDED candidate names the LLM chooser is shown (recalled ∪ goal-path), in place of
   *  the whole advertised vocabulary, so the prompt does not grow with the shape count. The vocabulary itself still
   *  bounds what may be chosen and what the deterministic routes consult. */
  promptVocabulary?: readonly string[];
  /** Piece 5: recall by meaning for a RESIDUAL (the unsatisfied part of the goal); the caller's own shape recall, bounded
   *  by the same shaped k. Returns a described catalog of recalled, advertised shapes, or null when recall can't be asked. */
  recallResidual?: (text: string) => Promise<ShapeCatalog | null>;
}

/**
 * Infer the 1-3 producible output shapes that satisfy `goal`, constrained to
 * `knownShapes`. When expectedOutputShapes is undefined and firstTarget is not
 * provided, this function will infer goal-satisfying shapes to seed the walk.
 * Caches by goal_hash so a second call with the same goal does not re-hit the
 * LLM. Returns [] when inference is unavailable / empty / unparseable.
 */
export async function inferGoalTargetShapes(
  goal: string,
  knownShapes: string[],
  opts: InferGoalTargetShapesOpts = {},
): Promise<string[]> {
  const llmEndpoint = opts.llmEndpoint;
  if (!goal || knownShapes.length === 0) return [];
  if (!opts.complete && !llmEndpoint) return [];

  // If caller did not provide expectedOutputShapes and no firstTarget is pinned,
  // infer the goal-satisfying output shapes from the known producible vocabulary
  // to seed the walk with goal-relevant targets instead of running opportunistically.
  // (A substrate-authored edit, 53e4267, once added an early `return []` for exactly
  // this case — the INVERSE of what this comment specifies — which turned the whole
  // function into a permanent no-op and left 5 tests red for 10 days. Typecheck
  // passed, so the autonomous verify gate never saw it. Do not reintroduce it: the
  // no-target case is the one this function exists to serve.)

  // Path rewriting logic removed. It was incorrectly converting valid repo-relative paths
  // into non-existent absolute paths. The original goal string is now used directly.
  const cache = opts.cache;
  const cacheKey = goalHashOf(goal);
  if (cache) {
    const cached = cache.get(cacheKey);
    if (cached) return cached;
  }

  const known = new Set(knownShapes);
  const fetchImpl = opts.fetchImpl ?? fetch;
  const model = opts.model ?? "auto";
  // shellResult is the UNIVERSAL executor (real bash). Steer imperative / system-
  // inspection goals to it — but ONLY mention it when it is actually producible.
  // EDIT RULE — the counterweight to the worked example in the prompt.
  //
  // The prompt teaches ANALYSIS by example ("find code-quality risks" ->
  // problem_detection / code_quality) and never mentions editing. With nothing
  // pulling the other way, a REPAIR goal inherits that pull. Observed live,
  // twice, with a working model: "Fix whatever writes those records..." routed
  // to a write-bridge, and "Change that source code so..." inferred
  // ["problem_detection"] — after which the walk correctly reported "no template
  // produces the inferred target shapes" and filed a capability gap. Routing was
  // not broken; the prompt had never been told that CHANGING code is a different
  // job from INSPECTING it.
  //
  // Mentioned ONLY when an edit shape is actually producible — same discipline
  // as shellRule, so the model is never steered at a shape the substrate cannot
  // serve. This is law 8 (put the load-bearing fact where it is used), not a
  // keyword shortcut: the deterministic shortcuts elsewhere in this file each
  // return a SINGLE shape and silently drop the other half of a
  // compose-then-persist goal, which is how a truncated plan gets graded
  // "reached" while the write never happened.
  const producibleEditShapes = [
    "code_modification_proposal",
    "fs_edit",
    "fileEditResult",
    "fs_write",
    "fileWriteResult",
  ].filter((s) => known.has(s));
  const editRule = producibleEditShapes.length > 0
    ? `\n\nSPECIAL RULE — CHANGING code is not ANALYSING code. If the goal asks to CHANGE, FIX, REPAIR, IMPLEMENT, EDIT or REWRITE source code, choose an edit shape (${producibleEditShapes.join(" / ")}) — NOT an analysis shape. Analysis shapes such as problem_detection and code_quality REPORT what is wrong; they never alter the code, so a repair goal routed to one yields a finding and leaves the defect in place. Choose an analysis shape ONLY when the goal asks to find, review, audit or report rather than to alter. When a goal asks BOTH to change code and to report on it, return BOTH shapes.`
    : "";

  const shellRule = known.has("shellResult")
    ? `\n\nSPECIAL RULE — the "shellResult" shape is the UNIVERSAL EXECUTOR: producing it RUNS a real shell command. If the goal is fundamentally about RUNNING a command or INSPECTING the repo / filesystem / running system — counting, listing, "how many", "report the current", checking, or running some command X — and NO more-specific analysis / write / data-processing shape in the KNOWN list fits, choose "shellResult". Do NOT choose "shellResult" for analysis / review / note-writing / data-processing / code-edit goals that have a specific matching shape (e.g. problem_detection, code_quality, a write shape) — those are not shell jobs.`
    : "";
  const prompt = `You route a substrate GOAL to the output impulse shape(s) whose PRODUCTION would satisfy it.

GOAL: ${goal}

KNOWN producible output shapes (you MUST choose ONLY from this list — these are the shapes the substrate can actually produce):
${JSON.stringify(knownShapes)}

Return the 1-3 shapes from the KNOWN list whose production best satisfies the goal. Pick the most specific capability-matched shapes (e.g. a "find code-quality risks" goal maps to code-analysis shapes like problem_detection / code_quality, NOT to a note-writing or summary shape). If nothing in the list fits, return an empty array.${editRule}${shellRule}

Respond with ONLY JSON: {"target_shapes": ["<shape from KNOWN list>"]}`;

  try {
    let text: string;
    if (opts.complete) {
      const t = await opts.complete(prompt);
      if (t == null) return [];
      text = t;
    } else {
      const r = await fetchImpl(`${llmEndpoint!.replace(/\/$/, "")}/resolve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "llm_completion", prompt, model }),
        signal: AbortSignal.timeout(opts.timeoutMs ?? 60_000),
      });
      if (!r.ok) return [];
      const j: any = await r.json();
      text = j?.body?.content ?? j?.content ?? j?.body?.text ?? "";
    }
    const m = String(text).match(/\{[\s\S]*\}/);
    if (!m) return [];
    const parsed: any = JSON.parse(m[0]);
    const raw = Array.isArray(parsed?.target_shapes) ? parsed.target_shapes : [];
    // CONSTRAIN to the known vocabulary — drop any hallucinated shape.
    const filtered = Array.from(
      new Set(
        raw
          .map((s: unknown) => String(s))
          .filter((s: string) => known.has(s))
          .map((s: string) =>
            (s === "activity_create_variant" || s === "variant_promote") && known.has("activityVariant_write")
              ? "activityVariant_write"
              : s,
          ),
      ),
  ).slice(0, MAX_TARGET_SHAPES) as string[];
    if (cache) {
      if (cache.size >= INFER_CACHE_MAX) {
        const first = cache.keys().next().value;
        if (first !== undefined) cache.delete(first);
      }
      cache.set(cacheKey, filtered);
    }
    return filtered;
  } catch {
    return [];
  }
}

/**
 * Infer the goal-target shapes AND return a structured decision with confidence
 * and alternative framings. Shares the same guard clauses and vocabulary
 * filtering as inferGoalTargetShapes but returns a GoalTargetDecision.
 * Returns { shapes: [], confidence: 0, alternatives: [] } on any failure.
 */
// -- Deterministic composition-ask fallback (2026-08-13) --------------------------
// Recover a [intermediate, terminal] target for "produce/derive <named shape>, then
// persist it as a note/concept/gap" WITHOUT the LLM/concept-recall, so a
// compute-then-emit composition survives a recall/transport outage (observed: the LLM
// inferrer returns [] when concept-db is unreachable, and every such goal then gets an
// empty target and fails). PRECISION-ONLY: returns null unless BOTH a write terminal
// AND a DISTINCT known intermediate shape are named; used only where the caller would
// otherwise return an empty decision -- never preempts the richer LLM path.
const _COMPOSITION_WRITE_CLAUSE = /\b(?:write|writes|writing|save|saves|saving|record|records|recording|store|stores|storing|persist|persists|persisting|append|appends|appending|capture|captures|capturing|file)\b[^.]{0,48}?\b(?:note|notes|memory|memories|concept|concepts|document|documents|gap|gaps|journal|entry|entries|obsidian|vault)\b/i;
function _shapeToPhrase(s: string): string {
  return s.replace(/[_-]+/g, " ").replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase().trim();
}
function deterministicCompositionAsk(goal: string, knownShapes: string[]): GoalTargetDecision | null {
  const wm = _COMPOSITION_WRITE_CLAUSE.exec(goal);
  if (!wm) return null;
  // WRITE_CLAUSE confirms a persist-verb + sink-noun within 48 chars. The ACTUAL sink
  // is the LAST recognised sink noun in the sentence from the write verb, so an
  // adjectival "concept-level" / "gap-severity" earlier in the window cannot hijack the
  // terminal away from the real "... in a memory note".
  const _sentence = goal.slice(wm.index, wm.index + 120).split(/[.!?]/)[0];
  const _sinkRe = /\b(note|notes|memory|memories|journal|entry|entries|document|documents|obsidian|vault|concept|concepts|gap|gaps)\b/gi;
  let _sm: RegExpExecArray | null; let _lastSink: string | null = null;
  while ((_sm = _sinkRe.exec(_sentence)) !== null) _lastSink = _sm[1].toLowerCase();
  const terminal = _lastSink == null ? null
    : /^concepts?$/.test(_lastSink) && knownShapes.includes("concept_write") ? "concept_write"
    : /^gaps?$/.test(_lastSink) && knownShapes.includes("substrateGap_write") ? "substrateGap_write"
    : knownShapes.includes("memoryNote_write") ? "memoryNote_write"
    : null;
  if (!terminal) return null;
  const excluded = new Set<string>([
    "shellResult", terminal, terminal.replace(/_write$/, ""),
    "memoryNote_write", "concept_write", "substrateGap_write", "memoryNote", "concept", "substrateGap",
  ]);
  const before = goal.slice(0, wm.index);
  let best: { shape: string; len: number } | null = null;
  for (const sh of knownShapes) {
    if (excluded.has(sh) || sh.endsWith("_write")) continue;
    const phrase = _shapeToPhrase(sh);
    if (phrase.length < 5) continue;
    const re = new RegExp(`\\b${phrase.split(/\s+/).map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("[\\s_-]+")}\\b`, "i");
    if (re.test(before) && (!best || phrase.length > best.len)) best = { shape: sh, len: phrase.length };
  }
  if (!best) return null;
  return { shapes: [best.shape, terminal], confidence: 0.8, alternatives: [] };
}
// -- Deterministic self-development env-gate route (2026-08-13) ---------------------
// A natural-language self-dev goal ("identify capabilities gated behind environment
// variables") names no shape with an ACTION verb, so _namedShape misses and the LLM
// inferrer (worked examples teach only code-analysis mapping) returns [] over ~388
// obscure names -> empty target -> opportunistic walk -> degenerate template -> 0 shapes
// (hollow; operator-observed on the "decompose failures into environmental conditions"
// goal). env_gate_scan IS advertised and self-grounding (walks the source tree, emits a
// substantive envGateReport with NO trace-store/hub dependency). Fold this into the
// `empty` value so it fires wherever inference would OTHERWISE return empty -- recall-down
// bail AND LLM-declines-[] -- covering both modes the operator observed. SCOPED to
// env_gate_scan ALONE (the one self-dev organ verified substantive without the flaky hub);
// hub-severed organs (failure_mode_summary=404, trace_*_report) are withheld until
// repaired, since routing to a severed shape hollow-greens the dispatch. !WRITE_CLAUSE so
// "save an env-gate note" keeps its compose-then-persist path; knownShapes-guarded so a
// spoke masking the producer falls through unchanged.
function deterministicWebSearchRoute(goal: string, knownShapes: string[]): GoalTargetDecision | null {
  if (!knownShapes.includes("web_search")) return null;
  const WORLD_QUERY = /\b(what('s| is) happening (in|around) the world (right now|today)|current events|world news|latest news)\b/i;
  if (!WORLD_QUERY.test(goal)) return null;
  return { shapes: ["web_search"], confidence: 0.9, alternatives: [] };
}

function deterministicEnvGateRoute(goal: string, knownShapes: string[]): GoalTargetDecision | null {
  if (!knownShapes.includes("env_gate_scan")) return null;
  if (_COMPOSITION_WRITE_CLAUSE.test(goal)) return null;
  const ENV_GATE = /\benv(?:ironment)?[\s_-]*(?:var(?:iable)?s?[\s_-]*)?gat(?:e|ed|ing)|\benv[\s_-]?gat|gated\s+behind\s+(?:an?\s+)?(?:env|environment)|\bgat(?:e|ed|ing)\b[\s\S]{0,24}\benv(?:ironment)?[\s_-]*var/i;
  if (!ENV_GATE.test(goal)) return null;
  return { shapes: ["env_gate_scan"], confidence: 0.7, alternatives: knownShapes.includes("shellResult") ? [["shellResult"]] : [] };
}
/**
 * IF THE SHARED REGISTRY MATCHER CAN ANSWER THE GOAL, THE TARGET IS shellResult.
 *
 * MEASURED 2026-08-17 by a controlled re-run — same code, two wordings, minutes apart:
 *
 *   "How many shapes are in the discovery registry?"       -> ["shellResult"] @0.6 -> REACHED
 *   "Report the totalShapes value from the discovery ..."  -> []            @0    -> failed
 *
 * The verb regex below is a list of conversational counting phrases. "report the VALUE" is
 * not among them ("report the number|count|result|digest" is), and "totalShapes" is a single
 * token, so the precise phrasing fell through to empty and the walk had nothing to aim at.
 *
 * I ALREADY "FIXED" THIS ONCE, IN THE WRONG COMPONENT. Teaching registryFieldFor the
 * canonical field names made the MATCHER understand `totalShapes` and changed nothing,
 * because the matcher is consulted downstream of the target decision — and this function is
 * what makes that decision. A fix landing in the component that shares the defect's
 * VOCABULARY is not thereby in the component that shares its CONTROL FLOW. The tell was a
 * live probe of the matcher returning the right answer while the live walk kept failing.
 *
 * Reusing registryFieldFor/registryRatioFor rather than widening the verb regex is
 * deliberate (law 3): they are the SAME rule the command builder and the reach oracle
 * share, so a goal routed here is one the producer can definitely build and the verifier can
 * definitely check. Widening the regex would route goals no producer serves.
 *
 * Their abstentions come along for free, and that is the safety property: a two-operand or
 * two-entity goal returns null from BOTH, so this declines to route and the goal falls
 * through to the LLM inferrer. The abstention that stopped a false reach earlier today
 * cannot be reopened by this new door.
 */
function deterministicRegistryRoute(goal: string, knownShapes: string[]): GoalTargetDecision | null {
  const webSearchDecision = deterministicWebSearchRoute(goal, knownShapes);
  if (webSearchDecision) return webSearchDecision;
  if (!knownShapes.includes("shellResult")) return null;
  // A COMPUTE-THEN-EMIT GOAL IS NOT A LOOKUP. "how many vessels are registered? store the
  // answer in <X>" asks for a count AND a write; routing it to shellResult alone answers
  // half and drops the rest — the dropped-operand failure that cost an alpha +2 earlier
  // today, arriving through this new door. An existing suite guard caught exactly this on
  // the first version of this function, which is the guard doing its job.
  //
  // registryFieldFor cannot see it: the counting clause is well-formed and names one
  // entity, so it answers correctly about the part of the goal it CAN represent. Same
  // lesson as the two-source scope defect — a matcher must not be trusted past the
  // dimension it models, and the emit clause is a dimension it does not model at all.
  if (/\b(store|save|write|persist|record|emit|append|insert|create|file|note|commit|publish|send|post)\b/i.test(goal)) return null;
  if (registryFieldFor(goal) === null && registryRatioFor(goal) === null) return null;
  // 0.6 matches what the conversational phrasing already earns for the identical question —
  // the two wordings ask the same thing and must not be graded differently.
  return { shapes: ["shellResult"], confidence: 0.6, alternatives: [] };
}

/**
 * "READ <abs path> AND TELL ME EXACTLY WHAT IT SAYS" — THE TARGET IS THE FILE READ.
 *
 * Measured on a fresh podman spoke during install acceptance: this goal inferred [] @0 three
 * times, because the LLM and concept recall a spoke resolves on its hub were unavailable. With
 * no target the walk ran unrelated pool activities and went HOLLOW without reading the file.
 *
 * Same construction as deterministicRegistryRoute: the rule is the SHARED parse
 * (verbatimReadTarget) that the reach gate's verbatim oracle and the walk's path binding
 * (index.ts) also use, so a goal routed here is one the producer can be handed a path for and
 * the oracle can grade. Its abstentions come along: a second path, a transformation word
 * (count, summarize, line N, edit, …) or a repo-relative path returns null and the goal falls
 * through unchanged.
 *
 * knownShapes-guarded like its siblings, and fileContent (local-tools) ONLY: development-vessel's
 * fs_read has weaker containment (a lexical path check, no realpath, no systemd path blocks), so
 * a deterministic, LLM-free route must never fall through to it. With fileContent not advertised
 * it declines — a target no producer serves would only file a capability gap. Read scope stays
 * the producer's own containment; this route only names the path the goal already names.
 */
/**
 * A GAP INVESTIGATION'S PRODUCT IS ITS DECOMPOSITION (CHANGE-35). The FALLBACK for a text-only goal (a human typing
 * "investigate gap X", a replay): the builders that KNOW the gap send expected_output_shapes ["gapDecomposition"] with
 * the gap id bound, and caller-supplied targets skip inference entirely. Uses the existing isGapInvestigationGoal;
 * the gap id is bound at the walk's resolve (gapIdOfGoalText), not here.
 */
function deterministicGapDecompositionRoute(goal: string, knownShapes: string[]): GoalTargetDecision | null {
  if (!isGapInvestigationGoal(goal) || !knownShapes.includes("gapDecomposition")) return null;
  return { shapes: ["gapDecomposition"], confidence: 0.85, alternatives: [] };
}

function deterministicVerbatimReadRoute(goal: string, knownShapes: string[]): GoalTargetDecision | null {
  if (!goal || verbatimReadTarget(goal) === null) return null;
  // A read-then-persist ask ("... and save it as a memory note") is a composition; this route
  // returns ONE shape and would drop the write. verbatimReadTarget does not exclude save/store/
  // record, so guard here exactly as the env-gate sibling does.
  if (_COMPOSITION_WRITE_CLAUSE.test(goal)) return null;
  if (!knownShapes.includes("fileContent")) return null;
  return { shapes: ["fileContent"], confidence: 0.8, alternatives: [] };
}

/**
 * THE GOAL NAMED A SHAPE, AND THAT SHAPE IS ADVERTISED — SO IT IS THE PRODUCER.
 *
 * The countable-phrasing fallback below routes "how many / count / number of" to
 * shellResult before the LLM sees the goal. That is right when nothing more
 * specific fits, and wrong when the goal NAMES a shape the registry advertises:
 * the answer already has a producer, and shell can only guess at it.
 *
 * Measured 2026-08-21 across four dispatches on one capability. docs_align_tick is
 * advertised by development-vessel (present in /registry/shapes among 383). Asked
 * "report how many documents it scanned", inference appended shellResult and the
 * walk ran the SHAPE NAME as a bash command — "docs_align_tick: command not found"
 * — beside a correct resolve carrying docs_scanned=63, and the judge sank the
 * verdict over the error. Reworded to "resolve ... and return its report", it
 * inferred shellResult as PRIMARY at 0.92 and burned five cold-command
 * self-corrections guessing curl invocations, never resolving the shape at all.
 *
 * This is the monoculture the block above documents (98.5% of reached commands are
 * shellResult) reaching the one place that fix did not cover: the deterministic
 * pre-LLM route. A named, advertised shape is the strongest producer signal a goal
 * can carry, so honour it before falling back to the universal executor.
 */
/** NAMED-SHAPE BINDING's prose-collision guard (moved here from index.ts so both callers share one rule, unchanged): a token is a
 *  shape name only when it is at least 6 characters, not an excluded executor/meta token, and carries a hump, an underscore or a
 *  colon (plain words like "cluster" are prose, not shapes). */
export const NAMED_SHAPE_EXCLUDE: ReadonlySet<string> = new Set(["goal", "dispatch_id", "shell", "bash", "shellResult", "fileContent"]);
export function isNamedShapeToken(t: string): boolean {
  return t.length >= 6 && !NAMED_SHAPE_EXCLUDE.has(t) && /[A-Z_:]/.test(t);
}

/**
 * A NAMED TARGET NO VESSEL ADVERTISES (2026-10-13, openspec contained-self-development 8.14's recurring-demand half; user ruling
 * "adjust existing code"). The goal names its deliverable verbatim ("produce <shapeName> …") but no vessel advertises it. Every route
 * here used to drop it (the vocabulary filter keeps only advertised shapes) and the walk then served an advertised SUBSTITUTE
 * (typically the universal executor), which the reach judge grades unmet run after run, and nothing ever filed the missing producer.
 * Kept as the target instead, the walk's EXISTING no-pick path (index.ts, LEAF→AUTHORING ESCALATION) files it via fileCapabilityGap.
 * No new matcher: the deliverable is _namedShape's verb-object construction with produce|return|emit|generate|build in place of its
 * action verbs, and the object's leading token must pass NAMED-SHAPE BINDING's guard (isNamedShapeToken). Only deliverable objects
 * count (an identifier elsewhere in the goal never becomes a target); an advertised deliverable leaves today's behaviour untouched;
 * two or more unadvertised deliverables are ambiguous and keep nothing (no guess).
 */
export function namedUnadvertisedTarget(goal: string, knownShapes: string[]): { shape: string | null; ambiguous: string[] } {
  // _namedShape's construction (verb, optional article, object), with the object captured as ONE identifier token: a phrase capture
  // would swallow a second "… and produce Y" into the first match, and that second deliverable would never be judged.
  const DELIVER = /\b(produce|produces|return|returns|emit|emits|generate|generates|build|builds)\b\s+(?:the\s+|a\s+|an\s+)?([A-Za-z][A-Za-z0-9_]*)/gi;
  const known = new Set(knownShapes);
  const missing = new Set<string>();
  for (const m of goal.matchAll(DELIVER)) {
    const tok = m[2] ?? "";
    if (!tok || !isNamedShapeToken(tok)) continue;
    if (known.has(tok)) return { shape: null, ambiguous: [] }; // an advertised deliverable: today's routes decide
    missing.add(tok);
  }
  if (missing.size === 1) return { shape: [...missing][0]!, ambiguous: [] };
  return { shape: null, ambiguous: missing.size > 1 ? [...missing] : [] };
}

function namedAdvertisedShape(goal: string, knownShapes: string[]): GoalTargetDecision | null {
  if (!goal || knownShapes.length === 0) return null;
  // Longest first: "docs_align_tick" must win over a substring like "docs_align".
  const named = knownShapes
    .filter((s) => /^[a-z][a-z0-9_]{4,}$/i.test(s))
    .filter((s) => new RegExp(`(^|[^a-z0-9_])${s}([^a-z0-9_]|$)`, "i").test(goal))
    .sort((a, b) => b.length - a.length);
  if (named.length === 0) return null;
  const primary = named[0];
  if (!primary || primary === "shellResult") return null;
  return { shapes: [primary], confidence: 0.9, alternatives: named.slice(1, 3).map((s) => [s]) };
}

// Code-origin investigation predicate (2026-08-27). Shared by the pre-LLM CODE-INVESTIGATION route
// (below) AND the walk's satisfier-suppression in index.ts, so both key off the SAME goal shape: a
// goal whose deliverable is an EXPLANATION/root-cause of where something originates in the SOURCE,
// not a value/count/edit. index.ts uses this to pre-suppress the raw shellResult satisfier for such
// goals so they fall to the grounded FLOOR (which greps as a TOOL and synthesizes) instead of the
// satisfier terminating on a raw grep or the hollow-retry widening to web search.
const _CODE_INVESTIGATE = /\bsearch\s+(?:the\s+|through\s+)?(?:code\s?base|source(?:\s+code)?|repo(?:sitory)?)\b|\b(?:find|locate|identify|trace|determine|figure\s+out)\b[^.]{0,70}?\b(?:what|which|where|how)\b[^.]{0,70}?\b(?:creat\w*|produc\w*|emit\w*|writ\w*|configur\w*|generat\w*|dispatch\w*|instantiat\w*|declar\w*|defin\w*)\b|\bwhere\b[^.]{0,55}?\b(?:defined|declared|configured|set|created|produced|emitted|instantiated|comes?\s+from)\b|\broot[-\s]?cause\b|\b(?:what|which)\s+(?:code|function|module|file|resolver|class|part)\b[^.]{0,60}?\b(?:creat\w*|produc\w*|emit\w*|writ\w*|configur\w*|generat\w*|dispatch\w*|defin\w*)\b/i;
const _CODE_TARGET = /\b(?:code\s?base|source(?:\s+code)?|\bcode\b|module|function|resolver|class|symbol|identifier|the\s+source|which\s+file|what\s+file|\.ts\b|\.tsx\b|\.js\b|repos?\/)\b/i;
const _NOT_CODE = /\b(?:how many|number of|\bcount\b|how much|implement|\bfix\b|\bedit\b|patch|refactor|rewrite|explain|describe|\bwhat\s+is\b|summar\w*|registered\s+vessels?|how many vessels)\b/i;
export function isCodeInvestigationGoal(goal: string): boolean {
  return !!goal && !_COMPOSITION_WRITE_CLAUSE.test(goal)
    && _CODE_INVESTIGATE.test(goal) && _CODE_TARGET.test(goal) && !_NOT_CODE.test(goal);
}

// Gap-investigation predicate (2026-08-28). The substrate's own gap-lifecycle loop autonomously
// dispatches goals shaped "investigate and decompose gap <gap-id>" (target shapes
// problem_detection/code_quality) to self-investigate its OWN open gaps -- confirmed live,
// running continuously, independent of any operator dispatch. isCodeInvestigationGoal does not
// match this phrasing (no "root cause"/"search codebase" wording, no code-shaped target words),
// so none of the 2026-08-27 grounding fixes applied to it -- observed live reaching HOLLOW
// (groundedOk=0, tools=0/0, finalTextLen=7812) through the un-discriminating LLM judge (measured
// 29% correct on this class of shape). Deliberately narrow and ADDITIVE-ONLY: this predicate
// gates the investigation seed in index.ts, the gap-id recovery at admission, and the reach gate's
// counted gap_id_field_missing observation; it never selects a grader (the gap-investigation oracle
// is selected by the structured decompose_gap_id, and the citation oracle is not asked). It must NOT be
// wired into routing or satisfier-suppression -- these goals target problem_detection/
// code_quality, which the gap-lifecycle loop consumes downstream, and that autonomous loop is
// already confirmed working; rerouting its target shapes risks breaking it.
const _GAP_INVESTIGATE = /\binvestigate\b[^.]{0,40}\bgap\b|\bdecompose\b[^.]{0,40}\bgap\b/i;
export function isGapInvestigationGoal(goal: string): boolean {
  return !!goal && _GAP_INVESTIGATE.test(goal);
}

// WHICH GOALS THE CITATION ORACLE MAY GRADE (2026-10-10). The oracle in index.ts grades an answer by
// the source locations it cites. That observation exists only when the goal asked for a code-cited
// investigation — the class isCodeInvestigationGoal already names, and the SAME predicate routing and
// satisfier-suppression key off, so the oracle's scope cannot drift from the routing's. A gap-
// investigation goal ("investigate and decompose gap <slug>") asks for no citation: grading it on one
// turned every uncited gap answer into a deterministic not-reached (122 of 208 last-pick β in 24h,
// charged to the write that merely recorded the answer). Not applicable ⇒ the oracle abstains.
//
// "demanded": the goal text itself asks for citations. Only then is an UNCITED answer a deterministic
// miss of what was asked; otherwise the missing citation is a soft not-reached the symmetric β gate
// can withhold. This regex is the one new pattern here — cite/citation/file:line wording only.
const _DEMANDS_CITATION = /\bcit(?:e|es|ed|ing|ation|ations)\b|\bfile:line\b|\bline numbers?\b/i;
export function goalDemandsCitation(goal: string): boolean {
  return !!goal && _DEMANDS_CITATION.test(goal);
}
export type CitationOracleApplicability = "not-applicable" | "applicable" | "demanded";
export function citationOracleApplicability(goal: string): CitationOracleApplicability {
  if (!isCodeInvestigationGoal(goal)) return "not-applicable";
  return goalDemandsCitation(goal) ? "demanded" : "applicable";
}

// Shared symbol extraction for the investigation seed + citation oracle (index.ts). Beyond the
// camelCase/snake_case heuristic (real source-code identifiers), a gap-investigation goal's only
// grounding material is often the gap id itself -- a hyphen-joined slug (e.g.
// "systematic-failure-universal-tool-fallback-zero") that usually embeds a REAL activity/shape id
// as a contiguous sub-run (here "universal-tool-fallback"). Tried longest-span-first so a precise
// multi-word match is preferred over a shorter, noisier one. A gap id with no groundable sub-run
// correctly yields nothing here -- verifyCodeInvestigationCitation already abstains (returns null)
// on zero symbols, so this can only ADD grounding material, never force a hollow verdict.
export function extractInvestigationSymbols(goal: string): string[] {
  const camel = [...new Set((goal.match(/\b[A-Za-z][A-Za-z0-9_]{3,}\b/g) ?? [])
    .filter((t) => /[_0-9]/.test(t) || /[a-z][A-Z]/.test(t))
    .filter((t) => !/^(https?|repos|codebase|configured|investigate|execution|dispatches?|creates?)$/i.test(t)))];
  if (camel.length) return camel.slice(0, 4);
  if (!isGapInvestigationGoal(goal)) return [];
  const slug = [...(goal.match(/\b[a-z0-9]+(?:-[a-z0-9]+){2,}\b/g) ?? [])].sort((a, b) => b.length - a.length)[0];
  if (!slug) return [];
  // ALL contiguous sub-runs of length >=2, not just the longest few: the real activity/shape id
  // embedded in a gap slug is usually a SHORT meaningful phrase (e.g. "universal-tool-fallback",
  // 3 words), not the whole slug — capping to the longest spans would drop it entirely for any
  // slug of >5 words. Grep (the actual consumer) decides which span is real; this just offers
  // candidates. Bounded by construction: a gap slug rarely exceeds ~8 words, so the full
  // triangular span count stays small (<=28) and costs nothing extra to try.
  const words = slug.split("-");
  const spans: string[] = [];
  for (let len = words.length; len >= 2; len--) {
    for (let start = 0; start + len <= words.length; start++) spans.push(words.slice(start, start + len).join("-"));
  }
  return spans;
}

/**
 * Goal-target inference, with the READ RULE applied to every route's answer (CHANGE-35): a read goal
 * (read-goal.ts isReadQuestionGoal, the closed copy of the reach gate's question rule) never gets a MUTATION-shaped target. Measured
 * in RUN 0 (2026-10-16): 8 of 17 read and question goals had write targets inferred (fileEditResult,
 * activityTemplate_write, an http write, …) and hollowed as write-goal-no-artifact.
 */
export async function inferGoalTargetDecision(
  goal: string,
  knownShapes: string[],
  opts: InferGoalTargetShapesOpts = {},
): Promise<GoalTargetDecision> {
  // Only shape NAMES can be targets, whatever vocabulary the caller passes (shape-name.ts): a prose entry is never chosen.
  const vocabulary = knownShapes.filter(isShapeName);
  // The read rule first: a mutation-shaped set is never a candidate on a read goal (selecting one and dropping it
  // afterwards would empty the primary set). Then A2b-proper's learned SELECTION among the sets left, then the retry
  // exclusion, which still applies to whatever it picks.
  // I-T (i): with a catalog, the routes' LLM call is recorded (a chooser that already answered is not asked again) and
  // the routes' answer passes the validity layer before selection.
  const asked: Array<string | null> = [];
  const routeOpts: InferGoalTargetShapesOpts = opts.shapeCatalog && opts.complete
    ? { ...opts, complete: async (p: string) => { const t = await opts.complete!(p); asked.push(t); return t; } }
    : opts;
  const routedRaw = withoutMutationTargetsForReadGoal(goal, await inferGoalTargetDecisionRoutes(goal, vocabulary, routeOpts));
  const routed = opts.shapeCatalog ? await describedProducerStage(goal, vocabulary, routedRaw, opts, asked) : routedRaw;
  // J4: the posterior's rows plus, when the caller supplies them (observe mode only), the goal's failure rows.
  const rows = [...(opts.targetPosterior ?? []), ...(opts.failureRows ?? [])];
  const selected = rows.length > 0 ? selectTargetSet(routed, rows) : null;
  if (selected && selected.candidates.some((c) => c.s + c.f > 0)) {
    console.log(`[goal-target-inference] target selection ${JSON.stringify({ goal_hash: goalHashOf(goal), changed: selected.changed, candidates: selected.candidates.map((c) => ({ shapes: c.shapes, s: c.s, f: c.f, draw: Number(c.draw.toFixed(4)) })), chosen: selected.decision.shapes })}`);
  }
  // GUARD: A RETRY NEVER DROPS A TARGET THE GOAL'S OWN WORDS DEMAND. A miss on such a target means its producer failed, not
  // that the target is wrong, so it is never excluded (and never the reason the routes are re-asked):
  //   - a gap investigation's only oracle-graded product, its decomposition (deterministicGapDecompositionRoute);
  //   - a verbatim read's fileContent (deterministicVerbatimReadRoute): the oracle and the walk read the same parse, so
  //     any other target could only disagree with both;
  //   - a mutation target of a goal that demands an artifact (goalDemandsArtifact): the reach gate counts only a write on
  //     one of the goal's own targets (artifactWrites), so a retry without it can never reach.
  const fixedRoutes = [deterministicGapDecompositionRoute(goal, vocabulary), deterministicVerbatimReadRoute(goal, vocabulary)];
  const demandsArtifact = goalDemandsArtifact(goal);
  const demanded = (t: string): boolean => fixedRoutes.some((r) => !!r && r.shapes.includes(t)) || (demandsArtifact && isMutationShape(t));
  const kept = (opts.excludeTargets ?? []).filter(demanded);
  if (kept.length > 0) console.log(`[goal-target-inference] retry: guard held — [${kept.join(", ")}] the goal's own words demand; not excluded`);
  const excluded = (opts.excludeTargets ?? []).filter((t) => !demanded(t));
  let picked = selected ? selected.decision : routed;
  let candidates = selected ? selected.candidates : null;
  let filtered = withoutFailedTargets(picked, excluded);
  let reasked = false;
  // NO ALTERNATIVE SURVIVED THE EXCLUSION (withoutFailedTargets kept today's choice, the same object): the routes had
  // proposed one set and the retry had nothing to change course to. Ask them ONCE more, told not to propose the excluded
  // targets (the memo and the fixed shortcuts bypassed), and offer what they propose as candidates.
  if (excluded.length > 0 && filtered === picked && picked.shapes.some((x) => excluded.includes(x))) {
    if (opts.complete || opts.llmEndpoint) {
      reasked = true;
      const reAsked: Array<string | null> = [];
      const reOpts: InferGoalTargetShapesOpts = { ...routeOpts, doNotPropose: excluded, ...(opts.shapeCatalog && opts.complete ? { complete: async (p: string) => { const t = await opts.complete!(p); reAsked.push(t); return t; } } : {}) };
      const reRaw = withoutMutationTargetsForReadGoal(goal, await inferGoalTargetDecisionRoutes(goal, vocabulary, reOpts));
      const re = opts.shapeCatalog ? await describedProducerStage(goal, vocabulary, reRaw, opts, reAsked) : reRaw;
      const added = [re.shapes, ...re.alternatives].filter((a) => a.length > 0 && !a.every((x) => excluded.includes(x)));
      console.log(`[goal-target-inference] retry: excluded the last failed target(s) [${excluded.join(", ")}] had no alternative — re-asked the routes once: ${added.length > 0 ? added.map((a) => `[${a.join(", ")}]`).join(" ") : "nothing new"}`);
      if (added.length > 0) {
        const merged: GoalTargetDecision = { ...picked, alternatives: [...picked.alternatives, ...added] };
        const reSelected = rows.length > 0 ? selectTargetSet(merged, rows) : null;
        if (reSelected) candidates = reSelected.candidates;
        else candidates = [merged.shapes, ...merged.alternatives].map((shapes) => ({ shapes, s: 0, f: 0, draw: 0 }));
        picked = reSelected ? reSelected.decision : merged;
        filtered = withoutFailedTargets(picked, excluded);
      }
    }
  }
  // J2b: NOVEL survives only while nothing was chosen (a recorded reaching path the posterior selects is not novel).
  const unrecorded = routed.novel && filtered.shapes.length === 0 && !filtered.novel ? { ...filtered, novel: routed.novel } : filtered;
  // The selection's decision-time record, carried to the dispatch record (law 12's counterfactual, readable per run).
  const final: GoalTargetDecision = rows.length > 0 || (opts.excludeTargets?.length ?? 0) > 0
    ? { ...unrecorded, target_selection: { candidates: (candidates ?? [routed.shapes, ...routed.alternatives].filter((a) => a.length > 0).map((shapes) => ({ shapes, s: 0, f: 0 }))).map((c) => ({ shapes: c.shapes, s: c.s, f: c.f })), chosen: unrecorded.shapes, excluded, kept, reasked } }
    : unrecorded;
  // The routes memoise their UNFILTERED answer (decisionCache), so a retry re-filters it against the new exclusions.
  // What a reader must see is the decision actually returned: kept under its own key (CHANGE-35 A2b-min repair).
  // An empty decision CLEARS the key: a previous attempt's decision must not be read as this one's.
  if (opts.finalDecisionCache) {
    const fc = opts.finalDecisionCache;
    if (final.shapes.length > 0 || final.alternatives.length > 0) {
      if (fc.size >= INFER_CACHE_MAX) { const first = fc.keys().next().value; if (first !== undefined) fc.delete(first); }
      fc.set(goalHashOf(goal), final);
    } else fc.delete(goalHashOf(goal));
  }
  return final;
}

/**
 * A RETRIED GOAL DOES NOT CHOOSE AGAIN THE TARGET IT JUST FAILED ON (CHANGE-35 / A2b-minimal; user ruling 2026-10-16
 * ~09:51Z). RUN 0: with learning on, both attempts of the same goals chose the same targets and failed the same way
 * ("no artifact on target X"). The caller passes the targets of the goal's latest such failure (goal-host's failure
 * memory); they are removed from the decision AFTER every route and the vocabulary filter, falling back to the best
 * alternative. If nothing would be left, today's choice stands ("no alternative"): an empty target set is worse.
 */
export function withoutFailedTargets(d: GoalTargetDecision, exclude: readonly string[] | undefined): GoalTargetDecision {
  if (!exclude || exclude.length === 0) return d;
  const bad = new Set(exclude);
  if (!d.shapes.some((s) => bad.has(s))) return d;
  const keep = (a: string[]) => a.filter((s) => !bad.has(s));
  const alternatives = d.alternatives.map(keep).filter((a) => a.length > 0);
  const shapes = keep(d.shapes);
  if (shapes.length > 0) {
    console.log(`[goal-target-inference] retry: excluded the last failed target(s) [${[...bad].join(", ")}] -> [${shapes.join(", ")}]`);
    return { ...d, shapes, alternatives };
  }
  if (alternatives.length > 0) {
    console.log(`[goal-target-inference] retry: excluded the last failed target(s) [${[...bad].join(", ")}] -> alternative [${alternatives[0]!.join(", ")}]`);
    return { ...d, shapes: alternatives[0]!, alternatives: alternatives.slice(1), confidence: Math.min(d.confidence, 0.5) };
  }
  console.log(`[goal-target-inference] retry: the last failed target(s) [${[...bad].join(", ")}] have no alternative — keeping [${d.shapes.join(", ")}]`);
  return d;
}

/** One recorded path of a goal class: the target set it ran under and its reach counters (goal_execution_paths). */
export interface TargetPathRow { expected_output_shapes?: readonly string[] | null; successful_executions?: number | null; failed_executions?: number | null }
/**
 * The rows selection may count (activity-api migration 224): ONLY a path's ORG-SCOPED counters, which count the runs
 * recorded under the per-org key. A legacy row whose counters may mix orgs, and that has had no per-org run since, has
 * none and is left out: each org's selection starts cold and accrues its own record.
 */
export function orgScopedPathRows(rows: readonly Record<string, unknown>[]): TargetPathRow[] {
  const out: TargetPathRow[] = [];
  for (const r of rows) {
    const s = r["org_successful_executions"];
    const f = r["org_failed_executions"];
    if (typeof s !== "number" || typeof f !== "number") continue;
    out.push({ expected_output_shapes: Array.isArray(r["expected_output_shapes"]) ? (r["expected_output_shapes"] as string[]) : null, successful_executions: s, failed_executions: f });
  }
  return out;
}
export interface TargetCandidateScore { shapes: string[]; s: number; f: number; draw: number }
export interface TargetSelection { decision: GoalTargetDecision; candidates: TargetCandidateScore[]; changed: boolean }

/**
 * TARGET INFERENCE AS A SELECTION OVER THE POSTERIOR (A2b-proper, design approved by qa 2026-10-16 ~12:00Z).
 * Inference never learned: the routes and the LLM proposed a target set and it was dispatched whatever its record.
 * goal_execution_paths already holds, per goal class (activity-api hashGoal), each path's target set
 * (expected_output_shapes) and its reach counters, credited by recordGoalPath from the reach verdict.
 *   - Candidates: ONLY the sets the routes proposed (primary + alternatives). This re-ranks, it never introduces a set
 *     (limits effect-as-cause: a posterior over target sets favours sets that are easy to grade).
 *   - Score: a Beta(1 + s, 1 + f) draw, s/f summed over the rows whose recorded set CONTAINS the candidate (the walk only
 *     appends to or rewrites the inferred set). Stored thompson_alpha/beta are NOT summed: every row starts at (1,1).
 *   - Cold start: no candidate has a row -> the decision is returned UNCHANGED (the same object): today's choice.
 *   - The highest draw wins; the others become the alternatives in draw order. Every candidate's (s, f, draw) is
 *     returned for the decision-time log (the counterfactual law 12 asks for).
 */
export function selectTargetSet(d: GoalTargetDecision, rows: readonly TargetPathRow[], draw: (a: number, b: number) => number = betaSample): TargetSelection {
  const seen = new Set<string>();
  const sets: string[][] = [];
  for (const c of [d.shapes, ...d.alternatives]) {
    if (!c || c.length === 0) continue;
    const k = [...c].sort().join("|");
    if (seen.has(k)) continue;
    seen.add(k);
    sets.push(c);
  }
  const counted = sets.map((shapes) => {
    let s = 0;
    let f = 0;
    for (const r of rows) {
      const rec = new Set(r.expected_output_shapes ?? []);
      if (shapes.every((x) => rec.has(x))) { s += Math.max(0, Number(r.successful_executions) || 0); f += Math.max(0, Number(r.failed_executions) || 0); }
    }
    return { shapes, s, f, draw: 0 };
  });
  if (counted.length === 0 || counted.every((c) => c.s + c.f === 0)) return { decision: d, candidates: counted, changed: false };
  for (const c of counted) c.draw = draw(1 + c.s, 1 + c.f);
  const ranked = [...counted].sort((a, b) => b.draw - a.draw);
  const winner = ranked[0]!;
  if (winner.shapes === d.shapes) return { decision: d, candidates: counted, changed: false };
  return { decision: { shapes: winner.shapes, confidence: d.confidence, alternatives: ranked.slice(1).map((c) => c.shapes) }, candidates: counted, changed: true };
}

/** A read goal's decision without its mutation-shaped targets (primary and alternatives); any other goal's unchanged. */
export function withoutMutationTargetsForReadGoal(goal: string, d: GoalTargetDecision): GoalTargetDecision {
  if (!isReadQuestionGoal(goal)) return d;
  const dropped = d.shapes.filter(isMutationShape);
  const altDropped = d.alternatives.some((a) => a.some(isMutationShape));
  if (dropped.length === 0 && !altDropped) return d;
  console.log(`[goal-target-inference] read goal: mutation target(s) dropped [${dropped.join(", ")}]${altDropped ? " (and from alternatives)" : ""}`);
  return { ...d, shapes: d.shapes.filter((s) => !isMutationShape(s)), alternatives: d.alternatives.map((a) => a.filter((s) => !isMutationShape(s))).filter((a) => a.length > 0) };
}

async function inferGoalTargetDecisionRoutes(
  goal: string,
  knownShapes: string[],
  opts: InferGoalTargetShapesOpts = {},
): Promise<GoalTargetDecision> {
  // Deterministic route: time-relative news/headlines/current-events goals go to web_search before LLM/prose.
  // Conservative: requires explicit time terms for generic "what is/what's happening" queries, so definitional
  // questions stay on the prose route. Never fires if web_search is not advertised.
  {
  const lower = goal.toLowerCase();
  const newsTerms = /\b(headlines?|top stories?|breaking news|current events?|news|ongoing events?)\b/;
  const timeTerms = /\b(today|yesterday|now|currently|this (?:week|month|year)|past ?24 ?hours|last ?24 ?hours|tonight|this (?:morning|afternoon|evening)|latest|recent)\b/;
  const happening = /\bwhat'?s?\s+happening\b/;
  const shouldWebSearch = newsTerms.test(lower) && (timeTerms.test(lower) || /\bheadlines?\b/.test(lower) || /\bongoing events?\b/.test(lower) || (happening.test(lower) && timeTerms.test(lower)));
  if (shouldWebSearch && knownShapes.includes("web_search")) {
    // A news goal that is a QUESTION needs a writer step after the search. An imperative
    // "search for" or "get links" goal should only return the search results.
    const isQuestion = /^\s*(what|who|where|when|why|how|which|list|summarize|tell me|what'?s|are there)\b/i.test(goal);
    if (isQuestion) {
      const writerShape = knownShapes.includes("llm_completion")
        ? "llm_completion"
        : knownShapes.includes("llmCompletion")
        ? "llmCompletion"
        : null;
      if (writerShape) {
        return { shapes: ["web_search", writerShape], confidence: 0.66, alternatives: [] };
      }
    }
    return { shapes: ["web_search"], confidence: 0.66, alternatives: [] };
  }
  }
  const gapDecomposition = deterministicGapDecompositionRoute(goal, knownShapes);
  const verbatimRead = deterministicVerbatimReadRoute(goal, knownShapes);
  const empty: GoalTargetDecision = gapDecomposition ?? verbatimRead ?? deterministicCompositionAsk(goal, knownShapes) ?? deterministicEnvGateRoute(goal, knownShapes) ?? deterministicRegistryRoute(goal, knownShapes) ?? namedAdvertisedShape(goal, knownShapes) ?? ((!/\b(write|record|save|store|create|log|append)\b/i.test(goal) && /\b(compute|calculate|multiply|divide|sum|count|how many|number of|sort|reverse|sha-?256|hash|digest|list|report (only )?the (number|count|result|digest))\b/i.test(goal) && knownShapes.includes("shellResult")) ? { shapes: ["shellResult"], confidence: 0.4, alternatives: [] } : { shapes: [], confidence: 0, alternatives: [] });
  const llmEndpoint = opts.llmEndpoint;
  if (!goal || knownShapes.length === 0) return empty;
  if (!opts.complete && !llmEndpoint) return empty;

  // CACHE HANDLE HOISTED ABOVE THE SHORTCUTS, AND A SINGLE CACHING EXIT.
  //
  // `decisionCache` used to be declared BELOW the deterministic pre-LLM shortcuts,
  // so the six shortcut paths physically could not populate it — they returned a
  // real decision (confidence 0.6-0.7) and cached nothing. The only writer was the
  // slow LLM path at the bottom.
  //
  // The consequence is not a cache miss, it is a FICTIONAL COLUMN. Both readers
  // (`recordGoalPath` and the dispatch record) look the decision up by goal hash
  // and coalesce a miss to null, so every shortcut-routed goal persists
  // `inference_confidence: null`. Any analysis correlating inference confidence
  // with reach is therefore measuring a column that is absent exactly where the
  // decision was most confident — the deterministic paths.
  //
  // Routing every exit through `remember()` also makes this correct by
  // construction for shortcuts added later, which is the property the old shape
  // lacked: a new `return` above line ~386 silently reintroduced the bug.
  // A re-ask (doNotPropose) bypasses the memo both ways: it must not replay the memoised set, and its answer is not the
  // routes' answer to the goal.
  const reask = (opts.doNotPropose?.length ?? 0) > 0;
  const decisionCache = reask ? undefined : opts.decisionCache;
  const cacheKey = goalHashOf(goal);
  const remember = (d: GoalTargetDecision): GoalTargetDecision => {
    if (decisionCache) {
      if (decisionCache.size >= INFER_CACHE_MAX) {
        const first = decisionCache.keys().next().value;
        if (first !== undefined) decisionCache.delete(first);
      }
      decisionCache.set(cacheKey, d);
    }
    return d;
  };
  {
    const cached = decisionCache?.get(cacheKey);
    if (cached) return cached;
  }

  // A verbatim read of one named absolute path is decided by the shared parse, not by the LLM:
  // the oracle that grades it and the walk that binds its path use the same rule, so an LLM
  // answer here could only disagree with both.
  // THE RE-ASK SKIPS THE DETERMINISTIC SHORTCUTS (this block, down to the chooser's prompt): each returns one fixed set,
  // which is the set the retry was told to avoid, so asking them again could only propose it again.
  if (!reask) {
  if (gapDecomposition) return remember(gapDecomposition);
  if (verbatimRead) return remember(verbatimRead);

  // COMPOSITION GUARD for every deterministic pre-LLM shortcut below.
  //
  // A goal that BOTH computes a value AND asks to PERSIST it is a compute-then-emit
  // COMPOSITION, and only the LLM inferrer handles it — its COMPOSITION RULE returns
  // BOTH the producing shape and the matching write shape. Every shortcut below
  // returns a SINGLE shape, so letting one fire on a composition silently DROPS the
  // write clause. That is not a cosmetic loss: the plan becomes the truncated set,
  // the walk produces exactly it, and the reach gate — which grades against the plan
  // — declares the goal REACHED while the write never happened. Observed live: "Write
  // a memory note recording the count of TypeScript files in repos/goal-host-vessel/src"
  // planned ["shellResult"], produced ["shellResult"], reached:true, and NO note exists.
  // Plan-vs-observed reconciliation cannot catch this, because both sides agree — they
  // are both downstream of the same truncated plan.
  //
  // Each shortcut previously carried its own ad-hoc excluder (e.g.
  // `write\s+(?:a\s+)?(?:note|file|concept)`) which a single qualifier defeats:
  // "write a MEMORY note" slips through while "write a note" is caught — and the first
  // shortcut had no write exclusion at all. One shared, qualifier-tolerant detector
  // closes the class instead of patching the instance. Deliberately requires BOTH a
  // persist verb AND a persist target within a short window, so pure computes that
  // merely mention a file or report a number are NOT suppressed (the shortcuts exist
  // to stop confabulation, so over-suppressing them would regress that).
  const WRITE_CLAUSE = /\b(?:write|writes|writing|save|saves|saving|record|records|recording|store|stores|storing|persist|persists|persisting|append|appends|appending|capture|captures|capturing|file)\b[^.]{0,48}?\b(?:note|notes|memory|memories|concept|concepts|document|documents|gap|gaps|journal|entry|entries|obsidian|vault)\b/i;
  const isCompositionAsk = WRITE_CLAUSE.test(goal);

  // EXPLICITLY-NAMED SHAPE ROUTE (2026-08-05). The deterministic shortcuts below return
  // shellResult and RETURN EARLY — before the LLM inferrer, and therefore before the advertised
  // shape vocabulary is consulted at all. That is right for confabulation-prone aggregates, but
  // it also means a purpose-built shape can be correct, deployed, advertised, and never once
  // considered.
  //
  // EVIDENCE: "Run the test suite for repos/goal-host-vessel and report how many tests passed and
  // how many failed" inferred ["shellResult"] @0.6 with no alternatives — it matched the
  // FILE-SYSTEM AGGREGATE shortcut on "how many" + "repos/…". `test_suite` is advertised by
  // development-vessel, resolves correctly, is keyed to a landed sha, and appeared ZERO times in
  // 15 minutes of walk logs. Advertised and returning 200 proves a shape is REACHABLE, not
  // SELECTABLE. Left alone this silently caps every future purpose-built shape whose goals read
  // as imperative ("run", "execute", "trigger").
  //
  // The rule is driven by the SHAPE SET, not by a per-shape branch: derive each known shape's
  // English phrase from its name and honour it when the goal names it as the direct object of an
  // ACTION verb. Deliberately narrow — `run|execute|invoke|perform|trigger` immediately
  // governing the phrase. An AGGREGATE over a shape ("count open substrate gaps by category") is
  // fetch-then-transform and must KEEP its shellResult route, which this rule leaves untouched
  // because "count" is not an action verb here. shellResult is offered as the alternative, so a
  // named shape that cannot produce still falls back to the universal executor.
  const _namedShape = ((): string | null => {
    const ACTION = /\b(run|runs|execute|executes|invoke|invokes|perform|performs|trigger|triggers)\b\s+(?:the\s+|a\s+|an\s+)?([\w\s-]{3,40})/i;
    const m = ACTION.exec(goal);
    if (!m?.[2]) return null;
    const obj = m[2].toLowerCase();
    for (const s of knownShapes) {
      if (s === "shellResult") continue;                 // never let the executor match itself
      // shape name -> phrase: test_suite -> "test suite", memoryNote_write -> "memory note write"
      const phrase = s.replace(/[_-]+/g, " ").replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase().trim();
      if (phrase.length < 4) continue;                   // too short to be named unambiguously
      // Allow space/hyphen/underscore between the words as the goal happens to write them.
      const re = new RegExp(`\\b${phrase.split(/\s+/).map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("[\\s_-]+")}\\b`, "i");
      if (re.test(obj)) return s;
    }
    return null;
  })();
  if (_namedShape) {
    return remember({
      shapes: [_namedShape],
      confidence: 0.8,
      alternatives: knownShapes.includes("shellResult") ? [["shellResult"]] : [],
    });
  }

  // A NAMED TARGET NO VESSEL ADVERTISES (see namedUnadvertisedTarget): kept as the missing target, so the walk files it instead
  // of serving a substitute. A composition ask is left to the LLM inferrer (its COMPOSITION RULE), like every shortcut below.
  if (!isCompositionAsk) {
    const nm = namedUnadvertisedTarget(goal, knownShapes);
    if (nm.shape) {
      console.log(`[goal-target-inference] named target ${nm.shape} is advertised by no vessel: kept as the missing target (the walk files its producer), not substituted`);
      return remember({ shapes: [nm.shape], confidence: 0.85, alternatives: [] });
    }
    if (nm.ambiguous.length > 1) console.log(`[goal-target-inference] ambiguous: ${nm.ambiguous.length} unadvertised named deliverables (${nm.ambiguous.join(", ")}); none kept, no guess`);
  }

  // EXPLANATORY / CONCEPTUAL PROSE-ANSWER ROUTE (D1 floor, 2026-07-26). A plain
  // "explain / what is / define / describe / how does X work / why does" question
  // has NO bespoke producer, so the LLM target-inference below COLLIDES the goal's
  // subject word onto an internal shape sharing a token ("impulse" -> poolImpulse /
  // impulseRelevance @0.95), scatters to junk satisfiers, and hollow-greens a
  // relevance TABLE. llm_completion_dispatch IS producible + dispatchable; its result
  // lands as llm_completion_result (raw prose the reach-gate judges on content). Route
  // the question straight to it, DETERMINISTICALLY, before the colliding LLM call and
  // any stale cache hit. Tight guard: explanatory lead AND no compute/fetch/analysis/
  // edit/write signal, so the shellResult / analysis / edit-intent / persist families
  // keep their own paths.
  // Hub vocab advertises raw `llm_completion` (vessel-resolvable via :8220); the
  // local substrate advertises the dispatch wrapper `llm_completion_dispatch`.
  // Fire the deterministic prose route for EITHER, targeting whichever is actually
  // in the vocabulary — so a pure question reaches instead of falling through to
  // the LLM inferrer that confabulates obsidian:write_note onto the target set.
  const _proseTarget = knownShapes.includes("llm_completion_dispatch")
    ? "llm_completion_dispatch"
    : (knownShapes.includes("llm_completion") ? "llm_completion" : null);
  if (_proseTarget) {
    const EXPLANATORY_RE = /\b(explain|describe|define|summar\w*|what\s+(is|are|does|do)\b|what'?s\b|how\s+(do|does|did|can|would|should)\b[\s\S]*\bwork|why\s+(do|does|did|is|are)\b|tell me about|walk me through|give (me )?an overview|overview of|concept of|the (idea|notion|meaning) of)\b/i;
    // A QUESTION ABOUT THE PRESENT STATE OF THE WORLD IS NOT A PROSE QUESTION (2026-08-16).
    //
    // "What is the distance from Earth to Io right now, in astronomical units?" matched
    // EXPLANATORY_RE on "what is" and nothing in NOT_PROSE_RE, so it routed to
    // llm_completion_dispatch — "ask a model" — for 45+ dispatches. But a model cannot know a
    // time-varying physical quantity: the answer is a MEASUREMENT that must be fetched, and the
    // walk had a working trust-gated fetcher (web_resource / http_response) it never reached
    // because inference had already decided the goal was definitional.
    //
    // The tell is the temporal deixis, not the subject: "right now", "currently", "today",
    // "at the moment", "as of". "What is an ephemeris" is genuinely a prose question and still
    // routes here; "what is X right now" is a retrieval question wearing a prose lead. Also
    // added: distance/position/temperature-style measurement nouns paired with a unit
    // ("in astronomical units", "in km"), which is how a request for a NUMBER announces itself.
    const NOT_PROSE_RE = /\b(count|how many|how much|number of|sum|total|bytes?|line count|lines?|digest|sha-?\d|hash|checksum|list|report the current|running|status|analy[sz]e|review|audit|problem_detection|code_quality|refactor|implement|fix|edit|patch|write (a|the)? ?(note|file|concept)|save|store|persist|fetch|download|curl|scrape|repos\/[\w.-]+\/)\b|https?:\/\//i;
    // Temporal deixis: the answer depends on WHEN it is asked, so it cannot come from weights.
    const LIVE_MEASUREMENT_RE = /\b(right now|currently|at (the|this) moment|as of (today|now)|today'?s|at present|present(ly)?|latest|current)\b|\b(distance|position|coordinates|altitude|azimuth|magnitude|velocity|temperature|price|rate)\b[\s\S]{0,60}\bin\s+(astronomical units?|au\b|km\b|kilometres?|kilometers?|miles?|degrees?|celsius|fahrenheit)/i;
    // A COMPOSITION ASK IS NOT A PROSE QUESTION (I-T a, 2026-10-17). Every shortcut below already skips a goal that also
    // asks to persist its answer (isCompositionAsk), so the LLM inferrer's COMPOSITION RULE keeps the write; this one did
    // not, and "explain X and record a memory note of it" returned the prose shape alone, dropping the write. Named debt:
    // the guard reuses WRITE_CLAUSE's wording; it retires with the shortcut once targets are chosen from described
    // producers (I-T i), when a write need is read from the write shape's description instead of a verb list.
    if (!isCompositionAsk && EXPLANATORY_RE.test(goal) && !NOT_PROSE_RE.test(goal) && !LIVE_MEASUREMENT_RE.test(goal)) {
      return remember({ shapes: [_proseTarget], confidence: 0.7, alternatives: [] });
    }
  }

  // EXTRACT-FROM-SOURCE route (2026-07-27, everyday-task floor). EVIDENCE: a live probe
  // "Read repos/.../package.json and report the value of its name field" reached HOLLOW-GREEN
  // via satisfier:fileContent — the walk resolved the RAW file read and the reach gate greened
  // because the answer is EMBEDDED in the raw content; the extraction NEVER RAN, so there was no
  // observable derived value to grade or to attach causality to. A goal that reads a NAMED
  // file/source AND asks to REPORT / GET / EXTRACT a SPECIFIC value/field/key FROM it must
  // PRODUCE the extracted value, not terminate on the raw read. shellResult is the compute that
  // jq/greps the field: routing here forces a REAL, OBSERVABLE, gradable extraction activity
  // (correctness = choosing the right extraction; causality attaches to the file operand),
  // turning a hollow read into a threaded compute over the source. TIGHT GUARD: an extract VERB
  // + a concrete config value/field NOUN + a file operand, and NOT a summarize/explain/analyze/
  // code-quality ask (those keep their prose / analysis / detection paths).
  if (knownShapes.includes("shellResult")) {
    const EXTRACT_VERB = /\b(report|extract|get|find|show|print|tell me|give me|what(?:'s| is| are)|which)\b/i;
    const VALUE_NOUN = /\b(value|field|key|version|name|entry|entries|property|properties|attribute|setting|settings|dependenc(?:y|ies)|devdependenc\w*|script|scripts|main|license|author|homepage|repository|url|port|endpoint)\b/i;
    // Specific override: map repo-relative path to known absolute substrate path before any rewriting.
    goal = goal.replace(/\bscripts\/substrate\/vessels\.inventory\.json\b/g, "/substrate/vessels.inventory.json");
    const FILE_OPERAND = /repos\/[\w.-]+\/[\w./-]+\.\w+|\b[\w-]+\.(?:json|ts|tsx|js|jsx|md|txt|ya?ml|toml|lock|cfg|ini|sh|py|sql|env)\b/i;
    const NOT_EXTRACT = /\b(summar|explain|describe|overview|analy[sz]e|review|audit|refactor|rewrite|gist|understand|two\s+sentences?|what\s+is\s+.*\s+about|quality|problem|complexity|coverage|security|performance|architecture|conformance)\b/i;
    if (!isCompositionAsk && EXTRACT_VERB.test(goal) && VALUE_NOUN.test(goal) && FILE_OPERAND.test(goal) && !NOT_EXTRACT.test(goal)) {
      return remember({ shapes: ["shellResult"], confidence: 0.6, alternatives: [] });
    }
  }

  // REGISTRY / SYSTEM-INVENTORY COUNT route (registry-misroute, 2026-07-27). EVIDENCE: a live
  // probe "How many vessels are currently registered in the discovery registry? Report the
  // number." mis-routed to auto-bridge-source_code (produced source_code, missing shellResult)
  // — the LLM read "discovery registry" as a CODEBASE to READ rather than a LIVE system to
  // QUERY + COUNT. A COUNT/LIST over the RUNNING registry / fleet / system is answered by a real
  // curl of the discovery registry piped to a count = shellResult (the universal executor),
  // NEVER by reading source. Route DETERMINISTICALLY here (pre-LLM) so the LLM's source_code
  // guess can't win (and can't be clobbered onto the shell safety-net seed downstream). TIGHT
  // GUARD: a count/how-many ASK + a LIVE-inventory noun, and NOT an analyze/review/summarize/
  // edit/quality ask (those keep their analysis / detection / composition paths).
  if (knownShapes.includes("shellResult")) {
    const COUNT_ASK = /\b(how many|how much|number of|count|list|are there|report the (?:number|count))\b/i;
    const INVENTORY_NOUN = /\b(registr(?:y|ies|ed)|vessels?|discovery|services?|systemd|units?|containers?|processes|fleet|shapes?|resolvers?|endpoints?|ports?|advertis)\w*/i;
    const NOT_INVENTORY = /\b(analy[sz]e|review|summar|audit|refactor|edit|implement|\bfix\b|quality|problem|complexity|security|write|persist|propose|\bnote\b|concept)\b/i;
    if (!isCompositionAsk && COUNT_ASK.test(goal) && INVENTORY_NOUN.test(goal) && !NOT_INVENTORY.test(goal)) {
      return remember({ shapes: ["shellResult"], confidence: 0.6, alternatives: [] });
    }
  }

  // FILE-SYSTEM AGGREGATE route (filesystem-determinism, 2026-07-29). EVIDENCE: count/sum/
  // average/list asks over filesystem operands (files, lines, .ts/.js, repos/, src/) confabulate
  // phantom atomic shapes instead of routing to shell executors that grep/wc/find the filesystem.
  // A count/sum/average/list verb paired with a filesystem noun is deterministically answered by
  // find | wc or similar = shellResult, NEVER by source_code inference. Route here (pre-LLM) to
  // ground the executor into real filesystem queries and prevent hallucination of derived shapes.
  if (knownShapes.includes("shellResult")) {
    const FS_AGG_VERB = /\b(how many|number of|count|sum|total|average|mean|largest|biggest|smallest|longest|list|contain|containing)\b/i;
    const FS_NOUN = /\b(files?|source\s+files?|lines?|\.ts|\.js|repos\/[\w.-]+|src\/|director(?:y|ies)|folders?|codebase)\b/i;
    const NOT_FS_EDIT = /\b(implement|fix|edit|refactor|rewrite|explain|summar\w*|analy[sz]e|review|audit|propose|persist|write\s+(?:a\s+)?(?:note|file|concept))\b/i;
    if (!isCompositionAsk && FS_AGG_VERB.test(goal) && FS_NOUN.test(goal) && !NOT_FS_EDIT.test(goal)) {
      return remember({ shapes: ["shellResult"], confidence: 0.6, alternatives: [] });
    }
  }

  // SUBSTRATE-DATA AGGREGATE route (everyday-composition floor, 2026-07-29). EVIDENCE: 5/5 live
  // probes of everyday aggregates over the substrate's OWN shaped data ("count open substrateGaps
  // by category top 3", "sum failed_attempts for missing_capability gaps") CONFABULATED a phantom
  // monolithic shape (category_counts, sum_of_failed_attempts) and filed a capability gap instead
  // of THREADING the known shape through a transform. The INVENTORY_NOUN route above covers the
  // running fleet (vessels/shapes/resolvers) but EXCLUDES the substrate's DATA shapes (gaps/
  // templates/traces), so those fall through to the LLM inferrer that hallucinates an atomic
  // aggregate shape. A count/sum/group-by/rank over an advertised DATA shape is fetch-then-transform
  // = shellResult (curl the shape's read endpoint | jq the reduction) — the universal executor.
  // Route DETERMINISTICALLY here (pre-LLM) so the phantom name is never inferred; the real read
  // endpoint + jq recipe is grounded into the executor guidance (index.ts SUBSTRATE-DATA AGGREGATE).
  if (knownShapes.includes("shellResult")) {
    const AGG_VERB = /\b(count|how many|number of|sum|total|group(?:ed)? by|by category|per\s|top\s+\d|rank(?:ed)?|most\s+(?:common|frequent)|distribution|tally|average|mean)\b/i;
    const SUBSTRATE_NOUN = /\b(gaps?|substrate\s?gaps?|activity\s?templates?|activities|executions?|traces?|failed_attempts?|failure\s?modes?)\b/i;
    const NOT_AGG = /\b(implement|\bfix\b|edit|refactor|rewrite|explain|summar|analy[sz]e|review|audit|propose|persist|write\s+(?:a|the)?\s*(?:note|file|concept))\b/i;
    if (!isCompositionAsk && AGG_VERB.test(goal) && SUBSTRATE_NOUN.test(goal) && !NOT_AGG.test(goal)) {
      return remember({ shapes: ["shellResult"], confidence: 0.6, alternatives: [] });
    }
  }

  // CODE-INVESTIGATION route (2026-08-27, below-ReAct-floor repair). EVIDENCE: a goal
  // "Investigate why trace records for exec_test_1 are emitted ... search the codebase for what
  // creates it ... report the root cause" was inferred by the LLM path as [execution_trace,
  // trace_search] @0.6 — it keyed on the TRACE-STORE surface vocabulary ("trace records",
  // "execution id") and queried the trace store instead of READING SOURCE; the walk then fixated
  // on the literal URL in the goal (curled it 7x) and terminated HOLLOW. A ReAct agent would have
  // grepped the code, so this fell BELOW the execution-expectation floor, and it is why the system
  // cannot investigate its own gaps (self-investigation goes hollow). Route code-ORIGIN questions
  // (search the source, find WHERE/WHAT code creates/defines/configures/emits a symbol, root-cause
  // a symbol) to the code-search shapes DETERMINISTICALLY, pre-LLM. Placed LAST among the shortcuts
  // so every established count/registry/fs/extract/prose route wins any overlap. TIGHT GUARD: a
  // code-origin-search VERB + CODE/SOURCE context, and NOT a count/edit/explain/registry ask (those
  // keep their own routes / the LLM edit path). shellResult offered as the fallback alternative.
  if (knownShapes.includes("codeSearchResult") || knownShapes.includes("source_code") || knownShapes.includes("code_find_function")) {
    // Predicate extracted to isCodeInvestigationGoal (module scope) so index.ts keys its
    // satisfier-suppression off the SAME goal shape. (Does NOT exclude on "vessel(s)": investigation
    // goals routinely name a vessel like "goal-host-vessel"; registry/vessel-COUNT goals are excluded
    // by how-many/count and handled by the registry route above.)
    if (!isCompositionAsk && isCodeInvestigationGoal(goal)) {
      // PREFER shellResult (a `grep -rn '<symbol>' <repo-root>`) as the primary. The structured
      // codeSearchResult/code_search resolver REQUIRES path+pattern args the walk cannot synthesize
      // (observed live: "resolver rejected — path and pattern are required"; it confabulated a
      // placeholder path your_project_path/execute_functions.ts) — whereas the universal shell
      // executor already greps/finds the repo tree reliably (the file-count route proves it). This
      // is exactly what a ReAct agent does. The structured code-search shapes are kept as
      // alternatives for when a producer can bind them.
      const primary = knownShapes.includes("shellResult") ? "shellResult"
        : (knownShapes.includes("codeSearchResult") ? "codeSearchResult"
          : (knownShapes.includes("source_code") ? "source_code" : "code_find_function"));
      const alts: string[][] = [];
      for (const s of ["codeSearchResult", "source_code", "code_find_function"]) {
        if (knownShapes.includes(s) && primary !== s) alts.push([s]);
      }
      return remember({ shapes: [primary], confidence: 0.7, alternatives: alts });
    }
  }
  } // end of the deterministic shortcuts (skipped on a re-ask)

  const known = new Set(knownShapes);
  const fetchImpl = opts.fetchImpl ?? fetch;
  const model = opts.model ?? "auto";
  // EDIT RULE — the counterweight to the worked example in the prompt.
  //
  // The prompt teaches ANALYSIS by example ("find code-quality risks" ->
  // problem_detection / code_quality) and never mentions editing. With nothing
  // pulling the other way, a REPAIR goal inherits that pull. Observed live,
  // twice, with a working model: "Fix whatever writes those records..." routed
  // to a write-bridge, and "Change that source code so..." inferred
  // ["problem_detection"] — after which the walk correctly reported "no template
  // produces the inferred target shapes" and filed a capability gap. Routing was
  // not broken; the prompt had never been told that CHANGING code is a different
  // job from INSPECTING it.
  //
  // Mentioned ONLY when an edit shape is actually producible — same discipline
  // as shellRule, so the model is never steered at a shape the substrate cannot
  // serve. This is law 8 (put the load-bearing fact where it is used), not a
  // keyword shortcut: the deterministic shortcuts elsewhere in this file each
  // return a SINGLE shape and silently drop the other half of a
  // compose-then-persist goal, which is how a truncated plan gets graded
  // "reached" while the write never happened.
  const producibleEditShapes = [
    "code_modification_proposal",
    "fs_edit",
    "fileEditResult",
    "fs_write",
    "fileWriteResult",
  ].filter((s) => known.has(s));
  const editRule = producibleEditShapes.length > 0
    ? `\n\nSPECIAL RULE — CHANGING code is not ANALYSING code. If the goal asks to CHANGE, FIX, REPAIR, IMPLEMENT, EDIT or REWRITE source code, choose an edit shape (${producibleEditShapes.join(" / ")}) — NOT an analysis shape. Analysis shapes such as problem_detection and code_quality REPORT what is wrong; they never alter the code, so a repair goal routed to one yields a finding and leaves the defect in place. Choose an analysis shape ONLY when the goal asks to find, review, audit or report rather than to alter. When a goal asks BOTH to change code and to report on it, return BOTH shapes.`
    : "";

  const shellRule = known.has("shellResult")
    ? `\n\nSPECIAL RULE — the "shellResult" shape is the UNIVERSAL EXECUTOR: producing it RUNS a real shell command. If the goal is fundamentally about RUNNING a command or INSPECTING the repo / filesystem / running system — counting, listing, "how many", "report the current", checking, or running some command X — and NO more-specific analysis / write / data-processing shape in the KNOWN list fits, choose "shellResult". Do NOT choose "shellResult" for analysis / review / note-writing / data-processing / code-edit goals that have a specific matching shape (e.g. problem_detection, code_quality, a write shape) — those are not shell jobs.`
    : "";
  const prompt = `You route a substrate GOAL to the output impulse shape(s) whose PRODUCTION would satisfy it.

GOAL: ${goal}

KNOWN producible output shapes (you MUST choose ONLY from this list):
${JSON.stringify(opts.promptVocabulary && opts.promptVocabulary.length > 0 ? opts.promptVocabulary : knownShapes)}

Return the 1-6 shapes from the KNOWN list whose production best satisfies the goal. Also provide a confidence value between 0 and 1 that production of the chosen shapes would actually satisfy the goal, and up to 2 ALTERNATIVE framings, each 1-6 shapes from the KNOWN list.${editRule}${shellRule}${describedBlockFor(goal, knownShapes, opts)}${reask ? `\n\nDO NOT PROPOSE these shapes: ${JSON.stringify(opts.doNotPropose)} — the goal's previous attempts produced no artifact on them. Choose a different framing from the KNOWN list.` : ""}

COMPOSITION RULE — when the goal BOTH derives/produces a value AND asks to WRITE / SAVE / RECORD / STORE / PERSIST it somewhere (a note, a concept, a file), you MUST return BOTH shapes: the shape that PRODUCES the value AND the matching write/emit shape from the KNOWN list (e.g. "memoryNote_write" for a memory note, "concept_write" for a concept). This is a compute-then-emit COMPOSITION — never drop the write clause in favour of the compute alone. When the goal names MORE THAN ONE destination, return EVERY matching write/emit shape, not just one: a goal that asks to record a concept AND persist a memory note must return BOTH "concept_write" AND "memoryNote_write". Example: goal "count the lines in FILE and write the number to a memory note" -> {"target_shapes":["shellResult","memoryNote_write"]}. Example with two destinations: goal "produce a health report, record a concept capturing it, and persist a memory note stating it" -> {"target_shapes":["vessel_health_report","concept_write","memoryNote_write"]}.${NOVEL_OPTION}${RESIDUAL_OPTION}

Respond with ONLY JSON: {"target_shapes": [...], "confidence": 0.0, "alternatives": [[...], [...]], "residual": ""}`;

  try {
    let text: string;
    if (opts.complete) {
      const t = await opts.complete(prompt);
      if (t == null) console.warn(`[goal-target-inference] the completion callback returned ${t === null ? "null" : "undefined"} — returning an EMPTY target, which is indistinguishable downstream from "no target is inferable"`);
  if (t == null) return empty;
      text = t;
    } else {
      const r = await fetchImpl(`${llmEndpoint!.replace(/\/$/, "")}/resolve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "llm_completion", prompt, model }),
        signal: AbortSignal.timeout(opts.timeoutMs ?? 60_000),
      });
      console.warn(`[goal-target-inference] llm_completion returned ${r.status} (${r.status === 402 ? "provider out of credit" : r.status === 429 ? "rate limited" : "transport failure"}) — returning an EMPTY target, which is indistinguishable downstream from "no target is inferable" for goal_hash=${goalHashOf(goal)}`);
      if (!r.ok) return empty;
      const j = await r.json() as Record<string, unknown>;
      const body = j?.body as Record<string, unknown> | undefined;
      text = (typeof body?.content === "string" ? body.content
        : typeof body?.text === "string" ? body.text
        : typeof j?.content === "string" ? j.content
        : "") as string;
    }
    const m = String(text).match(/\{[\s\S]*\}/);
    if (!m) console.warn(`[goal-target-inference] the LLM answered but no JSON object could be parsed from ${String(text).length} char(s) — returning an EMPTY target, indistinguishable downstream from "no target is inferable"; first 120 chars: ${String(text).slice(0, 120) || "(empty response body)"}`);
if (!m) return empty;
    const parsed = JSON.parse(m[0]) as Record<string, unknown>;
    const rawShapes = Array.isArray(parsed?.target_shapes) ? parsed.target_shapes as unknown[] : [];
    const filterShape = (s: unknown): string | null => {
      const str = String(s);
      if ((str === "activity_create_variant" || str === "variant_promote") && known.has("activityVariant_write")) {
        return "activityVariant_write";
      }
      return known.has(str) ? str : null;
    };
    const filteredShapes = Array.from(
      new Set(
        rawShapes
          .map(filterShape)
          .filter((s): s is string => s !== null),
      ),
    ).slice(0, opts.maxTargetShapes ?? 3);
    // A NAMED SOURCE REQUIRES ITS PRODUCER IN THE TARGET SET.
    //
    // Binding a fact's field is useless if the step that fetches it never runs. Measured
    // 2026-08-17: with the registry command bound, dispatches where the walk SELECTED
    // shellResult answered correctly (4 of 5, no substitutions), and the one dispatch that
    // never selected it composed the note from prior findings instead and stated 12 — the
    // vessel's own advertised_shapes length — against a true 368. Same defect, reached by
    // the path the binding does not sit on.
    //
    // So when the goal asks for a quantity the registry reports, the producer is added to
    // the target set rather than left to inference, which drops it a measured fraction of
    // the time. registryFieldFor is the same rule the producer and the verifier use, so all
    // three agree on when this applies.
    const requiredProducers = registryFieldFor(goal) !== null && known.has("shellResult")
      ? ["shellResult"] : [];
    const withRequired = Array.from(new Set([...filteredShapes, ...requiredProducers.filter((r) => !filteredShapes.includes(r))]));
    const rawConf = parsed?.confidence;
    const confidence = Math.min(1, Math.max(0,
      typeof rawConf === "number" && Number.isFinite(rawConf) ? rawConf : 0.5,
    ));
    const rawAlts = Array.isArray(parsed?.alternatives) ? parsed.alternatives as unknown[] : [];
    const primaryKey = withRequired.slice().sort().join(",");
    const alternatives: string[][] = [];
    for (const alt of rawAlts) {
      if (!Array.isArray(alt)) continue;
      const filteredAlt = Array.from(
        new Set(
          (alt as unknown[])
            .map(filterShape)
            .filter((s): s is string => s !== null),
        ),
      ).slice(0, 3);
      if (filteredAlt.length === 0) continue;
      if (filteredAlt.slice().sort().join(",") === primaryKey) continue;
      alternatives.push(filteredAlt);
      if (alternatives.length >= 2) break;
    }
    // FETCH+MEASURE → shellResult (deterministic override, 2026-07-25). A goal that
    // FETCHES a source AND applies a SHELL-COMPUTABLE MEASURE ("fetch <url> and count the
    // distinct tags") is mis-routed to http_fetch — a FETCH-ONLY shape that cannot compute,
    // so the satisfier produces the raw blob and the reach-gate greens a HOLLOW answer.
    // VERIFIED live: the same goal phrased "using a shell command" infers shellResult and
    // REACHES (exact count 11); phrased "fetch" infers http_fetch and hollow-greens
    // (shellResult already sits in its alternatives). shellResult is the UNIVERSAL EXECUTOR
    // — it curls AND computes in one op. Promote it over the fetch-only terminal. Never
    // fires for prose summarize/analyze/persist goals (a shell cannot do those).
    let outShapes = withRequired;   // withRequired, not filteredShapes: the required producer must survive to the RETURN, not merely to the cache key
    // Fire whether shellResult must be PROMOTED (absent) or is already CO-PRESENT
    // alongside a fetch-only shape. The co-present case is the load-bearing one:
    // when upstream emits [http_fetch, shellResult] together, derivation-split
    // labels http_fetch an INTERMEDIATE and the walk mis-bridges it to source_code
    // (auto-bridge-source_code, universally bindable) → produces the raw shape, never
    // shellResult → hollow partial-coverage. Collapsing to [shellResult] keeps the
    // goal on the universal executor (curls AND computes in one op), as D1 proved.
    if (known.has("shellResult")) {
      const FETCH_RE = /\bhttps?:\/\/|\b(fetch|download|curl|scrape)\b/i;
      const SHELL_MEASURE_RE = /\b(count|how many|number of|distinct|unique|most (?:frequen\w*|common)|frequen\w*|occurr\w*|\bsum\b|total|bytes?\b|byte count|\blength\b|line count|longer|shorter|larger|smaller|\bcompare\b)\b/i;
      const NOT_SHELLABLE_RE = /\b(summar\w*|analy[sz]e|explain|describe|sentiment|classif\w*|translat\w*|rewrite|as a concept|store .*\bconcept\b|write .*\bnote\b)\b/i;
      const FETCH_ONLY = new Set(["http_fetch", "httpResponse", "http_response", "web_resource", "fileContent", "source_code"]);
      // LOCAL-source compute parity (ROOT A, 2026-07-26): a LOCAL-file measure goal
      // ("count the lines in file X") matches no FETCH verb, so the remote-only FETCH_RE
      // gate never fired and a confident LLM [fileContent] survived -> hollow raw read.
      // Fire ALSO when a raw local-source shape is already inferred: "wc -l <path>" is ONE
      // shell command that reads the file itself, so COLLAPSE to [shellResult] (chain=1;
      // shellResult does not consume fileContent). Same SHELL_MEASURE/!NOT_SHELLABLE guard
      // keeps pure-read and prose/write goals untouched.
      const LOCAL_SOURCE = new Set(["fileContent", "source_code"]);
      const hasLocalSource = outShapes.some((s) => LOCAL_SOURCE.has(s));
      if ((FETCH_RE.test(goal) || hasLocalSource) && SHELL_MEASURE_RE.test(goal) && !NOT_SHELLABLE_RE.test(goal) && outShapes.some((s) => FETCH_ONLY.has(s))) {
        outShapes = [...outShapes.filter((s) => !FETCH_ONLY.has(s) && s !== "shellResult"), "shellResult"];
      }
    }
    // J2b: no listed shape chosen, and the chooser said why (NOVEL with a described residual): carried, never replaced.
    const novel = outShapes.length === 0 ? parseNovel(parsed, known) : null;
    const residualText = outShapes.length > 0 ? parseResidual(parsed) : "";
    return remember({ shapes: outShapes, confidence, alternatives, ...(novel ? { novel } : {}), ...(residualText ? { residual: { text: residualText, recalled: [], added: [] } } : {}) });
  } catch {
    return empty;
  }
}

// ── INTERMEDIATE-SHAPE INFERENCE (composition, 2026-06-30) ──────────────────
// A DERIVATION goal ("analyze X THEN write the findings to note Y") is a genuine
// multi-vessel composition: an intermediate shape (analysis) must be produced
// FIRST, then its content bound into the terminal write (the note). Without this
// the walk satisfies the terminal directly from the goal text and writes a HOLLOW
// note (no real findings). This infers the intermediate shape(s) that must be
// produced BEFORE the terminal shapes, constrained to known vocabulary and
// EXCLUDING the terminals themselves.
//
// THREE REFINEMENTS over the prior (reverted) skeleton:
//   1. Bias toward `problem_detection` (real `problems[]` w/ line numbers) over
//      `code_quality` (shallow metrics the reach-gate judges hollow) for
//      analyze/review/find-problems goals.
//   2. TIGHT classifier: emit an intermediate ONLY when the goal has an explicit
//      downstream emit/write target DISTINCT from the analysis itself. A plain
//      "analyze X" (no distinct downstream sink) → [] (no composition, 1-step).
//   3. (provisioning of the real source file is handled by the existing file-path
//      arg-alias in index.ts; this module only decides the intermediate shapes.)
//
// Returns [] (no composition) on: no LLM, empty vocab, no terminals, plain
// single-step goal, parse-fail, or any error — caller falls back to the unchanged
// single-shape walk.
export interface DerivationSplit {
  /** Shapes to produce FIRST (analysis/derivation), ordered earliest-first. */
  intermediate: string[];
  /** Final emit targets to DEFER until intermediates are produced, content-bound. */
  terminal: string[];
}

// PARTITION the already-inferred target set into (intermediate-derive, terminal-emit).
// `inferGoalTargetShapes` already returns the multi-shape target for a derivation goal
// (e.g. ["problem_detection","fileWriteResult"]); the walk needs to know WHICH of those
// are the derive step (produced first) and WHICH are the terminal emit (deferred +
// content-bound from the derive output). This classifier does that split — it does NOT
// invent new shapes, only labels the ones already chosen. Empty `intermediate` (i.e.
// not a 2-stage derivation, OR only one shape) ⇒ caller does NOT defer (unchanged
// single-shape behaviour). Returns {intermediate:[], terminal:inferred} on any failure.
export async function inferDerivationSplit(
  goal: string,
  inferredTargets: string[],
  opts: InferGoalTargetShapesOpts = {},
): Promise<DerivationSplit> {
  const noSplit: DerivationSplit = { intermediate: [], terminal: inferredTargets.slice() };
  const llmEndpoint = opts.llmEndpoint;
  // A derivation needs at least 2 distinct target shapes (a derive AND an emit).
  if (!goal || inferredTargets.length < 2) return noSplit;
  // DETERMINISTIC SPLIT for the three emit terminals (2026-08-13): a recognised emit
  // sink + a distinct non-emit shape splits unambiguously (defer the write, produce the
  // source first) with no LLM. Scoped to exactly the sinks the composition route emits;
  // activityVariant_write is NOT one and falls through to its guard + the LLM path below.
  {
    const EMIT_TERMINALS = new Set(["memoryNote_write", "concept_write", "substrateGap_write"]);
    const emit = inferredTargets.filter((sh) => EMIT_TERMINALS.has(sh));
    const nonEmit = inferredTargets.filter((sh) => !EMIT_TERMINALS.has(sh));
    if (emit.length >= 1 && nonEmit.length >= 1 && !inferredTargets.includes("activityVariant_write")) return { intermediate: nonEmit, terminal: emit };
  }
  if (!opts.complete && !llmEndpoint) return noSplit;
  // SELF-CONTAINED terminal (2026-07-03): activityVariant_write is produced by the
  // template_repair resolver, which grounds its own analysis from the target's
  // failure traces INSIDE the resolver — it is NOT the emit-sink of a derive→emit
  // sequence. Deferring it behind LLM-guessed audit/test "intermediate" shapes it
  // never consumes lets a hollow intermediate satisfier short-circuit the reach
  // verdict before the real variant is minted. A repair goal is single-stage.
  if (inferredTargets.includes("activityVariant_write")) return noSplit;

  const cache = opts.cache;
  const cacheKey = `split:${goalHashOf(goal)}:${inferredTargets.slice().sort().join(",")}`;
  if (cache) {
    const cached = cache.get(cacheKey);
    // Cache stores the terminal list; reconstruct the split from it.
    if (cached) {
      const term = new Set(cached);
      return { intermediate: inferredTargets.filter((s) => !term.has(s)), terminal: cached.slice() };
    }
  }

  const known = new Set(inferredTargets);
  const fetchImpl = opts.fetchImpl ?? fetch;
  const model = opts.model ?? "auto";
  const prompt = `A substrate GOAL has been mapped to these output impulse shapes: ${JSON.stringify(inferredTargets)}.

GOAL: ${goal}

Decide whether this is a DERIVATION/SEQUENCE goal: one that first reads/derives from a SOURCE and THEN produces a DISTINCT deliverable from it. The deliverable (terminal) may be either (a) an EMIT to a downstream sink (writes the derived content to a note / file / concept), or (b) a derived/extracted/computed VALUE returned inline (e.g. a count, an extracted field, a shell-computed number). If so, split the shapes:
- "intermediate": the RAW SOURCE read or analysis shape(s) produced FIRST as the MEANS of the derivation (e.g. fileContent, source_code, codeReadResult, problem_detection, code_quality).
- "terminal": the DELIVERABLE shape(s) — the goal's actual answer, whether an emit/write sink (e.g. fileWriteResult, fs_write, concept_write) OR a derived/extracted/computed value (e.g. json_path_extract, shellResult) — whose content is the DERIVED result.

RULES:
- ONLY split when the goal genuinely has TWO distinct stages (a read/derive stage AND a separate deliverable stage). If it is a PLAIN single-step goal (just read, or just write), return an EMPTY "intermediate" array and put ALL shapes in "terminal".
- Every shape you return MUST be from the given list — do not invent shapes.
- A RAW SOURCE read (fileContent, source_code, codeReadResult) is the MEANS of a derivation, never the deliverable: put it in "intermediate" whenever any other shape is present. A shape is "terminal" if it is the write/emit sink OR the derived/computed value the goal asks for.

Respond with ONLY JSON: {"intermediate": ["..."], "terminal": ["..."]}`;

  try {
    let text: string;
    if (opts.complete) {
      const t = await opts.complete(prompt);
      if (t == null) return noSplit;
      text = t;
    } else {
      const r = await fetchImpl(`${llmEndpoint!.replace(/\/$/, "")}/resolve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "llm_completion", prompt, model }),
        signal: AbortSignal.timeout(opts.timeoutMs ?? 60_000),
      });
      if (!r.ok) return noSplit;
      const j: any = await r.json();
      text = j?.body?.content ?? j?.content ?? j?.body?.text ?? "";
    }
    const m = String(text).match(/\{[\s\S]*\}/);
    if (!m) return noSplit;
    const parsed: any = JSON.parse(m[0]);
    const onlyKnown = (arr: unknown): string[] =>
      Array.isArray(arr) ? Array.from(new Set(arr.map((s) => String(s)).filter((s) => known.has(s)))) : [];
    let intermediate = onlyKnown(parsed?.intermediate);
    let terminal = onlyKnown(parsed?.terminal);
    // A shape can't be both; intermediate wins for production order, terminal for the rest.
    terminal = terminal.filter((s) => !intermediate.includes(s));
    // Any inferred shape the LLM didn't classify defaults to terminal (safe: it's a
    // target that must be produced, just not deferred-as-derived).
    for (const s of inferredTargets) if (!intermediate.includes(s) && !terminal.includes(s)) terminal.push(s);
    // DERIVE-AND-RETURN INVERSION GUARD (2026-07-26, law 8): the prompt recognizes
    // both emit-to-sink and derived-value deliverables, but the split is a
    // NON-DETERMINISTIC LLM call that can still invert — labeling the raw source read
    // (fileContent/source_code/codeReadResult) as "terminal" and the derived answer as
    // "intermediate", so the reach gate greens on the raw input. Encode the load-bearing
    // fact deterministically: a raw-source read is the MEANS of a derivation, never its
    // deliverable, whenever any non-raw target shape exists.
    const RAW_SOURCE_SHAPES = new Set(["fileContent", "source_code", "codeReadResult"]);
    if (inferredTargets.some((s) => !RAW_SOURCE_SHAPES.has(s))) {
      const rawInTerminal = terminal.filter((s) => RAW_SOURCE_SHAPES.has(s));
      if (rawInTerminal.length > 0) {
        terminal = terminal.filter((s) => !RAW_SOURCE_SHAPES.has(s));
        for (const s of rawInTerminal) if (!intermediate.includes(s)) intermediate.push(s);
        // If demotion emptied terminal, the derived shapes the LLM buried in
        // intermediate ARE the deliverable — promote them.
        const derivedInIntermediate = intermediate.filter((s) => !RAW_SOURCE_SHAPES.has(s));
        if (terminal.length === 0 && derivedInIntermediate.length > 0) {
          terminal = derivedInIntermediate.slice();
          intermediate = intermediate.filter((s) => RAW_SOURCE_SHAPES.has(s));
        }
      }
    }
    // A valid derivation needs BOTH a non-empty intermediate AND a non-empty terminal.
    // Otherwise it's effectively single-stage → no deferral.
    if (intermediate.length === 0 || terminal.length === 0) return noSplit;
    // REFINEMENT 1: prefer problem_detection over code_quality as the analysis
    // intermediate when both are present in the target set (substance > metrics).
    if (intermediate.includes("code_quality") && known.has("problem_detection") && !intermediate.includes("problem_detection")) {
      // Only swap if problem_detection is one of the inferred targets too; else keep.
      intermediate = intermediate.map((s) => (s === "code_quality" && known.has("problem_detection") ? "problem_detection" : s));
      terminal = terminal.filter((s) => !intermediate.includes(s));
    }
    if (cache) {
      if (cache.size >= INFER_CACHE_MAX) {
        const first = cache.keys().next().value;
        if (first !== undefined) cache.delete(first);
      }
      cache.set(cacheKey, terminal);
    }
    return { intermediate, terminal };
  } catch {
    return noSplit;
  }
}


/** I-T (i): the VALID candidates' descriptions, appended to every chooser prompt when the caller supplies a catalog. */
function describedBlockFor(goal: string, knownShapes: string[], opts: InferGoalTargetShapesOpts): string {
  const catalog = opts.shapeCatalog;
  if (!catalog) return "";
  const known = new Set(knownShapes);
  // The candidates are the catalog's (recalled, bounded), never the whole vocabulary.
  const valid = Object.keys(catalog).filter((s) => validity(s, known, catalog, goal, opts.poolShapes ?? []).valid);
  return describedCandidatesBlock(valid, catalog);
}

/**
 * I-T (i)+(iii): the validity layer over whatever the routes proposed (described-producers.ts). An invalid proposal is
 * dropped and recorded with its reason. When nothing valid is left: the chooser (the LLM) is asked, shown the valid
 * candidates' descriptions, unless it already answered during the routes; when no chooser answers, the lexical
 * fallback tier picks. Then a need the chosen set left uncovered is restored.
 */
async function describedProducerStage(goal: string, knownShapes: string[], routed: GoalTargetDecision, opts: InferGoalTargetShapesOpts, asked: Array<string | null>): Promise<GoalTargetDecision> {
  const catalog = opts.shapeCatalog!;
  const known = new Set(knownShapes);
  const pool = opts.poolShapes ?? [];
  const max = opts.maxTargetShapes ?? MAX_TARGET_SHAPES;
  const judged = new Map<string, Candidate>();
  const judge = (s: string) => { if (!judged.has(s)) judged.set(s, validity(s, known, catalog, goal, pool)); return judged.get(s)!; };
  for (const s of [...routed.shapes, ...routed.alternatives.flat(), ...Object.keys(catalog)]) judge(s);
  // The candidate universe is the catalog: with recall it is the bounded recalled set, independent of the shape count.
  // A routed proposal outside it is still judged (and kept when valid), so a deterministic route is never silently lost.
  const valid = Object.keys(catalog).filter((s) => judge(s).valid);
  let shapes = routed.shapes.filter((s) => judge(s).valid);
  let tier: ChooserTier = asked.some((t) => t != null) ? "llm" : "deterministic";
  let confidence = routed.confidence;
  let novel: NovelTarget | null = shapes.length === 0 ? (routed.novel ?? null) : null;
  let stageResidual = shapes.length > 0 ? (routed.residual?.text ?? "") : "";
  if (shapes.length === 0 && !novel && !asked.some((t) => t != null) && opts.complete) {
    // A shortcut proposed only invalid targets and the chooser has not been asked: ask it, among the valid candidates.
    const prompt = `You route a substrate GOAL to the output shape(s) whose PRODUCTION would satisfy it.\n\nGOAL: ${goal}${describedCandidatesBlock(valid, catalog)}\n\nReturn 1-${max} shapes from the VALID CANDIDATES.${NOVEL_OPTION}${RESIDUAL_OPTION}\n\nRespond with ONLY JSON: {"target_shapes": [...], "confidence": 0.0, "residual": ""}`;
    const t = await opts.complete(prompt);
    asked.push(t);
    const m = t ? String(t).match(/\{[\s\S]*\}/) : null;
    let proposed: string[] = [];
    let j: Record<string, unknown> | null = null;
    try { j = m ? JSON.parse(m[0]) as Record<string, unknown> : null; proposed = Array.isArray(j?.["target_shapes"]) ? (j!["target_shapes"] as unknown[]).map(String) : []; if (typeof j?.["confidence"] === "number") confidence = j["confidence"] as number; } catch { proposed = []; j = null; }
    for (const p of proposed) judge(p);
    shapes = proposed.filter((p) => judge(p).valid).slice(0, max);
    if (shapes.length > 0) { tier = "llm"; stageResidual = parseResidual(j); }
    else novel = parseNovel(j, new Set(valid));
    if (novel) tier = "llm";
  }
  // J2b: a chooser's NOVEL answer is final: the lexical fallback never fills the target it declined.
  if (shapes.length === 0 && !novel) {
    const pick = lexicalChoice(goal, valid, catalog);
    shapes = pick ? [pick] : [];
    tier = "fallback";
  }
  // Piece 5: a need the chosen set leaves unsatisfied is recalled BY MEANING on the chooser's residual (one extra recall,
  // validity-filtered, one more choice). The lexical word-match restore that lived here is retired (deleted).
  const res = shapes.length > 0 && stageResidual && opts.recallResidual && opts.complete
    ? await residualChoice(goal, shapes, stageResidual, known, pool, max, opts)
    : null;
  const restored = res?.added ?? [];
  if (restored.length > 0) console.log(`[goal-target-inference] residual recall added [${restored.join(", ")}] beside [${shapes.join(", ")}] for: ${stageResidual.slice(0, 120)}`);
  const invalid = [...judged.values()].filter((c) => !c.valid && (routed.shapes.includes(c.shape) || routed.alternatives.flat().includes(c.shape)));
  if (invalid.length > 0) console.log(`[goal-target-inference] invalid target(s) dropped: ${invalid.map((c) => `${c.shape} (${c.reason})`).join("; ")}`);
  return {
    shapes: [...shapes, ...restored],
    confidence,
    alternatives: routed.alternatives.map((a) => a.filter((s) => judge(s).valid)).filter((a) => a.length > 0),
    candidates: [...judged.values()],
    chooser_tier: tier,
    ...(novel && shapes.length === 0 ? { novel } : {}),
    ...(stageResidual ? { residual: { text: stageResidual, recalled: res?.recalled ?? [], added: restored } }
      // No chooser answered (the degraded tier picked by fallback): whether a need was dropped is UNKNOWN, and says so.
      : tier === "fallback" && shapes.length > 0 ? { residual: { text: "residual unknown (no chooser)", recalled: [], added: [], unknown: true as const } } : {}),
  };
}

/** One recall on the residual text, then one choice among its VALID candidates not already chosen. */
async function residualChoice(goal: string, chosen: readonly string[], residual: string, known: ReadonlySet<string>, pool: readonly string[], max: number, opts: InferGoalTargetShapesOpts): Promise<{ recalled: string[]; added: string[] }> {
  const cat = await opts.recallResidual!(residual).catch(() => null);
  if (!cat) return { recalled: [], added: [] };
  const recalled = Object.keys(cat);
  const cands = recalled.filter((s) => !chosen.includes(s) && validity(s, known, cat, goal, pool).valid);
  if (cands.length === 0 || chosen.length >= max) return { recalled, added: [] };
  const prompt = `You route a substrate GOAL to the output shape(s) whose PRODUCTION would satisfy it.\n\nGOAL: ${goal}\n\nALREADY CHOSEN: ${chosen.join(", ")}\nTHE PART OF THE GOAL THEY DO NOT SATISFY: ${residual}${describedCandidatesBlock(cands, cat)}\n\nReturn the shape(s) from the VALID CANDIDATES that produce the unsatisfied part, or [] if none does. Respond with ONLY JSON: {"target_shapes": [...]}`;
  const t = await opts.complete!(prompt);
  const m = t ? String(t).match(/\{[\s\S]*\}/) : null;
  let proposed: string[] = [];
  try { const j = m ? JSON.parse(m[0]) as { target_shapes?: unknown } : null; proposed = Array.isArray(j?.target_shapes) ? (j!.target_shapes as unknown[]).map(String) : []; } catch { proposed = []; }
  return { recalled, added: proposed.filter((p) => cands.includes(p)).slice(0, Math.max(0, max - chosen.length)) };
}
