// The semantic gate: does a drafted patch address the gap it names, and the refusal when the gate's own infrastructure could not judge. Lifted as-is from feature-compose.ts.
import { regionFromProposalText } from "../lib/region-literal.js";
import { type SemanticGateVerdict, contractNarrowingRefusal } from "./contract-narrowing.js";
import { regionContainmentVerdict, detectNewCapabilityStub, detectArchitectureViolation, diffIsCreateHeavy, stripCommentsAndStrings } from "./patch-gates.js";

export type Json = Record<string, unknown>;

export function parseJsonObject(raw: string): Json | null {
  const cleaned = raw.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim();
  const start = cleaned.indexOf("{");
  if (start < 0) return null;
  let depth = 0, inStr = false, escape = false;
  for (let i = start; i < cleaned.length; i++) {
    const ch = cleaned[i]!;
    if (escape) { escape = false; continue; }
    if (inStr) { if (ch === "\\") escape = true; else if (ch === "\"") inStr = false; continue; }
    if (ch === "\"") { inStr = true; continue; }
    if (ch === "{") depth++;
    else if (ch === "}") { depth--; if (depth === 0) { try { return JSON.parse(cleaned.slice(start, i + 1)); } catch { return null; } } }
  }
  return null;
}

// ───────────────────────────── SEMANTIC CUTOVER-VERIFICATION GATE ─────────────────────────────
// (2026-06-25, lever 5) The orthogonal analogue of goal-host's reach-gate
// (`verifyGoalReached`): typecheck-clean ≠ gap-fixed, exactly as status=completed ≠
// goal-reached. After the typecheck/shape-dispatch verify PASSES and BEFORE the
// FAVORABLE/stage decision, judge whether the applied diff GENUINELY addresses the
// gap on a path that actually EXECUTES. A net-new `recordOutcome`/`isNoOpBody` with
// zero callers compiles fine yet changes nothing — that hollow landing is what this
// gate exists to reject. Two filters: (1) a deterministic, cheap reachability
// hard-fail (no LLM) when EVERY changed symbol is dead code, (2) an LLM semantic
// judge for the rest.

// NO SWITCH. The gate below runs on every FAVORABLE compose. It was guarded by an env-read module constant
// (SEMANTIC_CUTOVER_GATE, "0" = off) that turned the shape-vocabulary, CJS, endpoint, inert-literal, stub /
// reachability and dissent checks off together: frozen at process start, invisible to traces (law 1).
// test/resolvers/feature-compose-semantic-gate-unconditional.test.ts holds it off with the variable set to "0".

export interface ReachabilityFact {
  symbol: string;
  isNewFunction: boolean;     // function/const added by this diff (a `+` definition line)
  callerCount: number;        // call-sites in the touched vessel's src/, excluding the definition
  isEntrypoint: boolean;      // exported entrypoint / route handler / resolver dispatch case / lifecycle hook
  reachable: boolean;         // callerCount > 0 OR isEntrypoint
  /**
   * The top-level symbol enclosing each counted caller line (enclosingTopLevelSymbol), or null when the line sits at
   * module scope or could not be placed. Optional: absent, the fact is read as before. Present, draftReachability
   * discounts every caller enclosed by the symbol itself or by another symbol this draft added that is not live.
   */
  callerScopes?: Array<string | null>;
}

/** A semantic-gate refusal that is infrastructure (the judge could not judge), not a judgment of the patch. */
export function semanticGateInfraRefusal(g: SemanticGateVerdict | null | undefined): boolean {
  return !!g && g.addresses === false && g.judge_unavailable === true && g.hard_fail !== true;
}

/**
 * ZERO-BEHAVIOR-DELTA detector (2026-07-31). `detectNewCapabilityStub` above is
 * create-heavy-scoped, so a SURGICAL no-op edit is out of its reach: a comment-only
 * insert, or an empty-bodied control block added below an identical live guard (a
 * SHADOWED no-op — e.g. `if (discoveredVia === "peer") { /* ... *\/ }` that executes
 * nothing) passes every gate. This flags an added diff whose executable content is
 * inert. Two conservative signals, both computed on the ADDED lines only, with
 * comments/strings blanked via `stripCommentsAndStrings` so a doc-comment or log never
 * masks real code:
 *  (a) nothing survives the strip -> the insert is comment/whitespace-only;
 *  (b) an empty-bodied control block (`if|else if|else|for|while (...) {}`) is present
 *      AND the added code carries NO behaviour token anywhere (call, assignment,
 *      return/throw/await/yield, break/continue, ++/--, new, import/export, `=>`).
 * The empty-control-block precondition in (b) is what makes the behaviour-token test
 * safe: an added object/enum/interface member (`retries: 3,`) or a `case` label carries
 * no such token yet is never an empty control block, so it is never flagged. Biased
 * toward NOT firing (any behaviour token anywhere clears it), so a genuine surgical
 * edit that also happens to contain an empty guard is left to the LLM judge.
 */
export function detectZeroBehaviorDelta(diff: string): { isInert: boolean; reason: string } {
  const added: string[] = [];
  for (const raw of diff.split("\n")) {
    if (/^###\s+(?:NEW FILE\s+)?/.test(raw)) continue;
    if (raw.startsWith("+++")) continue;
    if (raw.startsWith("+")) added.push(raw.slice(1));
  }
  if (added.length === 0) return { isInert: false, reason: "no added lines" };
  const removed: string[] = [];
  for (const raw of diff.split("\n")) {
    if (raw.startsWith("---")) continue;
    if (raw.startsWith("-")) removed.push(raw.slice(1));
  }
  const removedCode = stripCommentsAndStrings(removed.join("\n")).replace(/\s+/g, "");
  const code = stripCommentsAndStrings(added.join("\n"));
  if (code.replace(/\s+/g, "") === "") {
    // A comment/whitespace-only ADD is only inert when nothing real was REMOVED —
    // a deletion (e.g. drop a call, add "// handled upstream") IS the behaviour delta.
    if (removedCode !== "") return { isInert: false, reason: "behaviour delta via deletion" };
    return { isInert: true, reason: "added lines are comment/whitespace-only — zero behaviour delta" };
  }
  const hasEmptyControlBlock = /\b(?:if|else\s+if|else|for|while)\b[^{};]*\{\s*\}/.test(code);
  if (hasEmptyControlBlock) {
    const noCtrlHeaders = code.replace(/\b(?:if|for|while|switch|catch)\s*\([^)]*\)/g, " ");
    const behaviourToken =
      /\b(?:return|throw|await|yield|break|continue|delete|new|import|export)\b/.test(code) ||
      /\+\+|--/.test(code) ||
      /(?<![=!<>])=(?!=)/.test(code) ||
      /[A-Za-z_$][\w$]*\s*\(/.test(noCtrlHeaders);
    if (!behaviourToken) {
      return { isInert: true, reason: "added code is an empty-bodied control block that performs no work (no-op / shadowed guard) — zero behaviour delta" };
    }
  }
  // Tautological self-test (the 8eff84d signature): a NEW *.test.ts that imports NO real
  // vessel module via a relative path only exercises inline-defined logic — it lands green
  // yet validates nothing real. A test carries behaviour tokens (expect(...)), so it clears
  // the checks above; this is a distinct SEMANTIC inertness. Fires ONLY for a create of a
  // *.test.ts; edits to existing tests and every non-test file are unaffected. A real test
  // imports the module under test via a relative path (./x or ../src/x) that is not itself
  // a test file; only bun:test / node builtins → tautological.
  const newTest = diff.match(/^###\s+NEW FILE\s+(\S*\.test\.tsx?)\b/m);
  if (newTest) {
    const relImports = [...added.join("\n").matchAll(/\bfrom\s+["'](\.[^"']*)["']/g)].map((m) => m[1] ?? "");
    const importsRealModule = relImports.some((p) => !/\.test(\.tsx?)?$/.test(p));
    if (!importsRealModule) {
      return { isInert: true, reason: "new *.test.ts imports no real vessel module (relative import) — tautological self-test that validates only inline-defined logic" };
    }
  }
  return { isInert: false, reason: "added code performs work" };
}

/**
 * Decide the reachability hard-fail purely from the facts. HARD-FAIL (UNFAVORABLE,
 * no LLM) iff there is ≥1 changed symbol AND every changed symbol is unreachable
 * (callerCount===0 AND !isEntrypoint) — i.e. the patch only touches dead code. When
 * we could not extract any symbol from the diff, we do NOT hard-fail (the change may
 * be data/string/wiring the symbol extractor doesn't model); the LLM judge handles it.
 */
/**
 * True iff the diff touches at least one file and EVERY file it touches is a test file.
 * Used to waive the reachability hard-fail, which cannot measure a test file: nothing
 * imports a test, so callerCount is 0 for everything in it by construction.
 *
 * Reads the `### <path>` headers the diff builder emits (and `### NEW FILE <path>`).
 * Fails CLOSED: no parseable header means "not test-only", so an unrecognised diff shape
 * keeps the full check rather than silently waiving it.
 */
export function changesAreTestOnly(diff: string): boolean {
  const paths = String(diff ?? "")
    .split("\n")
    .filter((l) => l.startsWith("### "))
    .map((l) => l.replace(/^###\s+(NEW FILE\s+)?/, "").trim())
    .filter((p) => p.length > 0);
  if (paths.length === 0) return false;
  return paths.every((p) => /\.(test|spec|stories)\.tsx?$|\.(stories|test|spec)\.(js|jsx|ts|tsx)$/.test(p));
}

/**
 * Reachability of the symbols a draft added, with the draft's own references taken out.
 *
 * The callers grep strips definition lines only, so a recursive call inside a function's body counted as its caller,
 * and a symbol called only by another added symbol nobody calls counted as live. 81c9d93e landed that way: parse /
 * command / oracle added together, command and oracle called by nothing, parse called only by itself, so the gate saw
 * one reachable symbol, did not hard-fail, and the LLM judge's addresses:true admitted dead code.
 *
 * For each added fact carrying callerScopes: a caller enclosed by the symbol itself, or by another added symbol, is not
 * a caller unless that symbol is live. Live = at least one caller outside the draft's added symbols, then the fixpoint
 * through added callers. Every other fact is returned unchanged. Recomputed from callerCount and callerScopes, never
 * from the incoming `reachable`, so applying it twice gives the same facts.
 */
export function draftReachability(facts: ReachabilityFact[]): ReachabilityFact[] {
  const added = new Set(facts.filter((f) => f.isNewFunction && Array.isArray(f.callerScopes)).map((f) => f.symbol));
  if (added.size === 0) return facts;
  const live = new Set<string>();
  const external = (f: ReachabilityFact): boolean => {
    const scopes = f.callerScopes ?? [];
    if (f.callerCount > scopes.length) return true;
    return scopes.some((s) => s === null || !added.has(s));
  };
  for (const f of facts) if (added.has(f.symbol) && external(f)) live.add(f.symbol);
  for (let changed = true; changed;) {
    changed = false;
    for (const f of facts) {
      if (!added.has(f.symbol) || live.has(f.symbol)) continue;
      if ((f.callerScopes ?? []).some((s) => s !== null && s !== f.symbol && live.has(s))) { live.add(f.symbol); changed = true; }
    }
  }
  return facts.map((f) => (added.has(f.symbol) ? { ...f, reachable: live.has(f.symbol) } : f));
}

export function reachabilityHardFail(rawFacts: ReachabilityFact[]): { hardFail: boolean; reason: string } {
  const facts = draftReachability(rawFacts);
  if (facts.length === 0) return { hardFail: false, reason: "no changed symbols extracted from diff (not a hard-fail)" };
  const reachable = facts.filter((f) => f.reachable);
  if (reachable.length === 0 || facts.some((f) => f.isNewFunction && f.callerCount === 0 && !f.isEntrypoint)) {
    const newlyAddedFunctions = facts.filter((f) => f.isNewFunction && f.callerCount === 0 && !f.isEntrypoint);
    if (newlyAddedFunctions.length > 0) {
      return { hardFail: true, reason: `compose adds top-level function ${newlyAddedFunctions.map((f) => f.symbol).join(', ')} with zero readers, not exported and not wired — a write-only hollow addition; wire it, export it for a real consumer, or drop it` };
    }

    const names = facts.map((f) => f.symbol).join(", ");
    const selfOnly = facts.filter((f) => f.callerCount > 0).map((f) => f.symbol);
    return {
      hardFail: true,
      reason: `dead-code-only patch: every changed symbol (${names}) has zero callers and is not an entrypoint — the change cannot execute`
        + (selfOnly.length > 0 ? `; ${selfOnly.join(", ")} is referenced only from its own body or from another symbol this patch added, and a self-reference is not a caller` : ""),
    };
  }
  return { hardFail: false, reason: `${reachable.length}/${facts.length} changed symbols reachable` };
}

export interface DataFlowFact {
  symbol: string;
  file: string;
  kind: "consumed_never_populated" | "imported_never_called";
}

function semanticJudgePrompt(
  gapSummary: string,
  gapMeta: Record<string, unknown> | undefined,
  diff: string,
  facts: ReachabilityFact[],
  dataFlow: DataFlowFact[],
  codeContext: string,
  archViolations: Array<{ law: string; detail: string; snippet: string }> = [],
  /** Deterministic location check, phrased as a fact to weigh — never a verdict. */
  containmentNote = "",
): string {
  const metaStr = gapMeta ? `\n\nGap detector evidence:\n${JSON.stringify(gapMeta, null, 2)}` : "";
  const createHeavy = diffIsCreateHeavy(diff);
  const completenessClause = createHeavy
    ? `\n\nTHIS IS A CREATE-HEAVY CHANGE (it introduces a NEW file / endpoint / handler). For these, "addresses" is NOT satisfied merely because the new code exists and is wired (called/routed/exported). You MUST judge whether the NEW code FUNCTIONALLY IMPLEMENTS the gap's intent. For a responsibility MOVE (e.g. "move logic X out of vessel A into a new endpoint on vessel B"): does the new endpoint actually CONTAIN the moved logic (the real computation/transformation/persistence), or is it a placeholder that calls nothing, returns a stub/empty/null, re-dispatches without doing the work, or just echoes its input? addresses=true ONLY if the new capability is GENUINELY FUNCTIONAL — the moved/new logic is really present in the new code, not a shell. If the new handler/endpoint is wired but its body does not do the work the gap describes, set addresses=false and say "wired stub, not a functional implementation" in reason.`
    : "";
  // A HUMAN COMPLAINT IS JUDGED BY THE COMPLAINANT, NOT BY "DID SOMETHING CHANGE".
  //
  // Twice today this judge approved a UI patch that plainly changed the named behaviour
  // and plainly did not do what the person asked. The second is the clearer specimen:
  // the complaint was "the elapsed column keeps counting after a run has finished", the
  // patch was `text: running ? elapsed : '0s'`, and the judge returned addresses:true
  // with the reason "changes the behavior of the elapsed column to display '0s' when
  // the run has finished" — an accurate description of a change that DISCARDS the
  // duration the human wanted preserved. Every settled row would have read 0s.
  //
  // The judge answered "does this change the behaviour the gap names?" — which is what
  // it was asked. That is a different question from "would the person who wrote this
  // consider it fixed", and only the second one matters for a complaint. Where the gap
  // carries the human's own words, put those words in front of the judge and ask the
  // second question explicitly.
  //
  // Named failure shapes rather than a vague instruction, because both real failures
  // were of one kind: satisfying the letter of the complaint by REMOVING the thing
  // complained about instead of correcting it.
  const proseText = typeof gapMeta?.["prose"] === "string" ? String(gapMeta["prose"]).trim() : "";
  const humanIntentClause = proseText
    ? `

THIS GAP CAME FROM A HUMAN, IN THEIR OWN WORDS:
"${proseText}"

Judge against THAT SENTENCE, not against whether the diff altered the named code. The question is whether the person who wrote it would consider it fixed. A change that touches the right place and still fails their intent is addresses:false — say so and put what they actually wanted in reason.

Reject in particular the shape where the complaint is satisfied by DESTROYING what they complained about rather than correcting it: blanking, zeroing, hiding, emptying, or removing a value they wanted made correct or readable. "Stop showing it" is almost never what someone means by "this is wrong" — if they say a number keeps changing they want the RIGHT number held still, not a placeholder. Ask what the surface should read AFTER the fix, and if the diff does not produce that, reject it.`
    : "";
  const archClause =
    archViolations.length > 0
      ? `\n\nARCHITECTURE-CONFORMANCE NOTES (deterministic scan of the ADDED lines against the substrate's OWN standing laws — the system must define its architecture BY ITS USE, so a patch that "fixes" the gap by VIOLATING a law is NOT a clean fix):\n${archViolations
          .map((v) => `- [${v.law}] ${v.detail}\n    added: ${v.snippet}`)
          .join("\n")}\n\nWeigh these. If the patch ADDRESSES the gap only BY the violating line (the behaviour is env-gated, or the LLM call is inlined where an llm-prompt resolver belongs), set addresses:false and name the CONFORMANT location (a shaped impulse read at use time, or the llm-prompt resolver dispatched from an activity) in suspected_real_location. If the violation is incidental and the gap is genuinely fixed the conformant way elsewhere in the diff, you MAY still pass but MUST name the violation in reason.`
      : "";
  return `You verify whether a self-authored CODE PATCH GENUINELY addresses a substrate gap, on a path that ACTUALLY EXECUTES. typecheck=clean does NOT mean the gap is fixed — many patches "compile" by adding dead code (a net-new function with zero callers), by editing a path that never runs (hollow patch), or by adding a wired-but-empty new endpoint/handler (a stub). This is the code analogue of hollow goal-completion.

GAP: ${gapSummary}${metaStr}${humanIntentClause}${completenessClause}

Reachability facts (deterministic, computed by grepping the touched vessel src/):
${JSON.stringify(facts, null, 2)}

Relevant existing code context (the symbol the gap names, and — if reachability found call-sites elsewhere — the live path):
${codeContext || "(none extracted)"}

Unified diff that was applied (and typechecked clean):
${diff.slice(0, 8000)}

${dataFlow.length > 0 ? `\nData-flow facts (deterministic):\n${JSON.stringify(dataFlow, null, 2)}\n\nA consumed-but-never-populated collection or an imported-but-never-called symbol is presumptively a DROPPED EDIT: unless the diff itself shows the population/call site, return addresses:false and name the missing site in suspected_real_location.\n` : ''}${archClause}${containmentNote ? containmentNote + '\n\n' : ''}Judge strictly. The patch ADDRESSES the gap only if it changes the behavior the gap describes AND that changed code is on a path that executes (called, routed, dispatched, or a lifecycle/entrypoint). If the patch edits a DIFFERENT symbol than the one the gap's real fix lives in (e.g. it adds \`recordOutcome\` when the live β-penalty path is \`penaliseHollowTemplate\`), report the right one in suspected_real_location.

Respond with ONLY JSON: {"addresses": boolean, "reason": "<1 sentence>", "on_live_path": boolean, "suspected_real_location": "<symbol or file:symbol the real fix belongs in, or empty>"}`;
}

/**
 * The semantic gate. Pure of I/O except for the injected `llm` call, so it is unit
 * testable. Computes the reachability hard-fail first (no LLM); if it survives,
 * consults the LLM judge. `llm` returns the raw model text; we JSON-extract it with
 * the same `{...}` slice goal-host uses. Any LLM failure is treated as a NON-block
 * (fail-open on the JUDGE only — the deterministic hard-fail already ran) so a flaky
 * haiku call cannot wedge the loop; the deterministic dead-code filter is the floor.
 */
// EFFECT-LESS HARD-FAIL detector (2026-07-25). A diff can pass reachability (the touched
// handler IS live) yet change NOTHING observable. The substrate's "compose-report" mitosis
// cutovers repeatedly landed a single unread `c.header("x-...-probe", "1")` as the WHOLE edit
// — claiming to compose a report while doing nothing (5 confirmed via a self-authored-code
// audit). Detect deterministically: if EVERY substantive added line is a response-header
// emission (c.header / res.setHeader / reply.header / ctx.set), the patch is pure observability
// with no query/body/branch change — effect-less regardless of the route being reachable.
export function detectEffectlessHeaderOnlyDiff(diff: string): { isEffectless: boolean; headers: string[] } {
  const added = diff.split("\n").filter((l) => l.startsWith("+") && !l.startsWith("+++"));
  const substantive = added
    .map((l) => l.slice(1).trim())
    .filter((l) => l.length > 0 && !l.startsWith("//") && !l.startsWith("/*") && !l.startsWith("*") && l !== "{" && l !== "}");
  if (substantive.length === 0) return { isEffectless: false, headers: [] };
  const headerRe = /^(?:c\.header|res\.setHeader|reply\.header|ctx\.set)\s*\(\s*['"]([^'"]+)['"]/;
  const headers: string[] = [];
  for (const line of substantive) {
    const m = line.match(headerRe);
    if (!m) return { isEffectless: false, headers: [] }; // a non-header substantive line → real change
    headers.push(m[1]!);
  }
  return { isEffectless: headers.length > 0, headers };
}

export async function verifyPatchAddressesGap(args: {
  gapSummary: string;
  gapMeta?: Record<string, unknown>;
  diff: string;
  reachability: ReachabilityFact[];
  data_flow?: DataFlowFact[];
  // handled via `args.data_flow ?? []` at call sites
  codeContext?: string;
  /**
   * Post-apply text of the touched files, concatenated. Used ONLY by the
   * region-containment gate's one-hop data-flow widening, to find lines bearing the
   * gap's region literal and check whether the patch defines anything consumed there.
   * Safe to read post-apply: that branch only runs when no touched line contains the
   * region, so region-bearing lines are unchanged by the patch by construction.
   */
  fileText?: string;
  llm: (prompt: string) => Promise<string>;
  /**
   * Run the LLM "does this diff address the gap?" judge. TRUE only when a real gap
   * context was supplied. For a FREE-TEXT spec (no gap) there is nothing gap-relative
   * to judge — the resolver's own doc-contract says: "Absent (e.g. a free-text spec) →
   * no gap-relative judge, only the reachability hard-fail still applies." Comparing a
   * free-text diff against a spec-derived (or, worse, stale/unrelated) gap summary made
   * the judge return addresses=false and sink correct edits. When false, only the
   * deterministic floors (reachability + stub) apply; a diff that clears them PASSES
   * without an LLM gap-comparison. (Default true preserves the gap-driven path.)
   */
  runSemanticJudge?: boolean;
  /**
   * Each edited source file's pre-image and post-image, for the documented-contract floor (contractNarrowingRefusal):
   * the contract is read from the pre-image's own comments. Absent -> the floor does not run.
   */
  contractFiles?: Array<{ path: string; pre: string; post: string }>;
  /** The test lines the change ADDED (contractAddedTestText): the only evidence a narrowing was meant. */
  checkText?: string;
  /**
   * The compose's mode and, in test_writing mode, verify's test-writing judgement (judgeTestWritingCheck) and every path
   * the compose wrote. Absent, or any other mode -> the fix standard below, as before.
   */
  testWriting?: { compose_mode: unknown; gap_id: unknown; judgement: import("../resolvers/check-supply-admission.js").TestWritingJudgement | null | undefined; written_paths: readonly string[] };
}): Promise<SemanticGateVerdict> {
  // A TEST-WRITING COMPOSE IS JUDGED BY THE TEST-WRITING CONTRACT, NOT THE FIX STANDARD. Its job is to add a check that
  // is red at the parent and change no behaviour, so "does this patch change behaviour / address the gap?" refuses it
  // by construction (measured: a passed test-writing check refused by the judge with "Patch only adds a test"). The
  // contract is judged deterministically first: the only paths written are the gap's check (the floor's own predicate,
  // testWritingDiffOutsideTests) and the check is the same assertion red at the parent each run (judgeTestWritingCheck,
  // at verify). When both hold the fix-standard judge is not consulted, but the ADVERSARIAL lens still is, with the
  // test-writing question: does this check fail BECAUSE of the gap's defect? A red for an unrelated reason is a gamed
  // check (measured: one was admitted with only the refuter dissenting, its 1/2 split overruled below), so here ONE
  // specific refutation refuses the compose. An unavailable or unparseable refuter fails closed, as infrastructure.
  // Otherwise the fix standard below runs, as before.
  if (args.testWriting) {
    const csa = await import("../resolvers/check-supply-admission.js");
    const tw = args.testWriting;
    const j = tw.judgement;
    if (tw.compose_mode === csa.CHECK_SUPPLY_COMPOSE_MODE && j?.ok === true && tw.written_paths.length > 0 && csa.testWritingDiffOutsideTests(tw.compose_mode, [...tw.written_paths], tw.gap_id).length === 0) {
      type Refutation = { refuted?: unknown; confidence?: unknown; reason?: unknown };
      let rp: Refutation | null = null;
      try {
        const rraw = await args.llm(testWritingRefutationPrompt(args.gapSummary, args.diff, j));
        const rm = rraw.match(/\{[\s\S]*\}/g);
        rp = rm ? (parseJsonObject(rm[0]) as Refutation | null) : null;
      } catch (e) {
        return { addresses: false, reason: `test-writing refuter unavailable (${(e as Error).message}); the check was not examined, so it does not pass (fail closed)`, on_live_path: true, llm_consulted: true, verified: false, judge_unavailable: true };
      }
      if (!rp || typeof rp.refuted !== "boolean") {
        return { addresses: false, reason: "test-writing refuter answered without a parseable verdict (no JSON object with a boolean `refuted`); the check was not examined, so it does not pass (fail closed)", on_live_path: true, llm_consulted: true, verified: false, judge_unavailable: true };
      }
      // The same specificity bar the fix-standard refuter is held to (confidence >= 0.8, a reason of substance).
      const rReason = typeof rp.reason === "string" ? rp.reason.trim() : "";
      if (rp.refuted === true && typeof rp.confidence === "number" && rp.confidence >= 0.8 && rReason.length >= 20) {
        console.log(`[fc-semantic-gate] test_writing REFUTED (conf ${rp.confidence.toFixed(2)}): the check does not fail because of the gap's defect: ${rReason.slice(0, 200)}`);
        return { addresses: false, reason: `test_writing refuted (conf ${rp.confidence.toFixed(2)}): the check ${j.check_file} is red, but not because of the gap's defect: ${rReason}`, on_live_path: true, llm_consulted: true, verified: true };
      }
      console.log(`[fc-semantic-gate] skipped test_writing: judged by the test-writing contract (check ${j.check_file}, ${j.runs.length} red run(s) at the parent) and not refuted, not by the fix standard`);
      return {
        addresses: true,
        reason: `test_writing compose: judged by the test-writing contract, not the fix standard: it writes only the gap's check (${j.check_file}), that check is red at the parent (${j.runs.length} run(s), the same assertion red), and the adversarial lens did not refute that it fails because of the gap's defect`,
        on_live_path: true,
        llm_consulted: true,
        verified: true,   // a deterministic judgement that ran (the check, red at the parent), examined by the refuter
        skipped: "test_writing",
        test_writing: { check_file: j.check_file, edit_site: j.edit_site, runs: j.runs.length },
      };
    }
  }
  const { hardFail, reason } = reachabilityHardFail(args.reachability);
  // A TEST FILE HAS NO CALLERS BY CONSTRUCTION — callerCount IS NOT A SIGNAL THERE.
  //
  // reachabilityHardFail rejects a patch when every changed symbol has zero callers and
  // is not an entrypoint. Test bodies are invoked by the RUNNER via describe/it; nothing
  // imports them. So a correct test-only patch is always "dead code" by that measure, and
  // the substrate cannot repair its own suite.
  //
  // The attributed symbol is usually wrong as well. Measured 2026-08-29 on
  // orphaned-capability-scan.test.ts: the drafter edited exactly the specified assertion
  // lines (compose report records ops at 64-65, 66, 78, 96-98, all inside the describe
  // block) and the gate refused with "every changed symbol (TEMPLATES) has zero callers".
  // TEMPLATES is a top-level const at line 42 that the patch never touched — the extractor
  // credits a changed line to the nearest PRECEDING top-level declaration, which in a test
  // file is some fixture const with no callers.
  //
  // Scale of the block: 3 of 783 substrate-authored commits over 60 days touched only test
  // files (0.4%). Not impossible — a diff yielding no extracted symbol skips the hard-fail
  // via the facts.length===0 branch — but far too unreliable to fix a red suite, and a red
  // suite is what forces every cutover to diff newly-failing against a baseline.
  //
  // Scoped deliberately: the exemption applies ONLY when EVERY file in the diff is a test
  // file. A patch touching src/ alongside a test still faces the full check, so production
  // dead code cannot be smuggled in beside a test edit. Fails CLOSED — a diff with no
  // parseable file headers is not treated as test-only.
  if (hardFail && !changesAreTestOnly(args.diff)) {
    return { addresses: false, reason, on_live_path: false, hard_fail: true, llm_consulted: false };
  }
  // FUNCTIONAL-COMPLETENESS HARD-FAIL (2026-06-29). A create-heavy change can pass
  // reachability (the new endpoint IS wired) yet be a STUB body — wired but does
  // nothing. Reject deterministically BEFORE the LLM judge, scoped to create-heavy
  // diffs so surgical edits are unaffected. on_live_path stays true (it IS reachable)
  // but addresses=false: the capability exists on a live path but is not functional.
  // REGION-CONTAINMENT HARD-FAIL (2026-08-07). A ui-feedback gap names the exact
  // panel region it is about — `classification_metadata.region` is the literal CSS
  // class the renderer passes to createDiv. If the diff does not touch that region,
  // the patch cannot be addressing the complaint, whatever it says about itself.
  //
  // Learned by shipping it. A human complaint about `sub-card sub-card--fleet`
  // produced a patch editing `sub-step-shadowline` — a different region in the same
  // file — and the LLM judge returned addresses:true with the reasoning that it
  // "directly addresses the request to boldface the content section of the
  // sub-card--fleet panel region". That sentence NAMES THE CORRECT REGION WHILE
  // APPROVING AN EDIT TO A DIFFERENT ONE. Every structural check passed because the
  // FILE was right; location was judged by prose, and prose is what the drafter is
  // best at. It landed (ad706ce) and had to be reverted (1812ee7).
  //
  // A judge asked "does this address the request?" will accept a plausible rationale,
  // because the model that wrote the patch finds its own justification convincing.
  // Containment is not a matter of opinion, so check it deterministically and BEFORE
  // the judge, exactly as reachability and stub-detection already are.
  //
  // Scoped to gaps that actually name a region, so every other change is unaffected.
  // ONE-HOP DATA-FLOW WIDENING (2026-08-07). Literal containment is the ZERO-hop
  // case of the invariant this gate actually enforces: the patch must be causally
  // connected to the named region. It is not the whole invariant, and demanding it
  // rejected the one correct patch this gap ever produced.
  //
  //   1743   const elapsed = started ? fmtRel(Date.now() - started) : '';   <- correct fix
  //   1752   row.createSpan({ cls: 'sub-fleet-elapsed', text: elapsed });   <- region literal
  //
  // The complaint ("the elapsed column keeps counting after a run finished") is about
  // the VALUE, so the fix belongs at the definition; the region line only renders it.
  // Zero-hop containment cannot see that edge and hard-failed a correct patch twice.
  //
  // The widening is exactly one hop, and deliberately NOT proximity or enclosing
  // scope: `renderFleetRow` renders sub-fleet-status, sub-fleet-goal,
  // sub-fleet-elapsed and sub-verdict, so any distance- or function-scoped rule
  // readmits the ad706ce class (right file, wrong region) that this gate exists to
  // stop. A define->use edge does not: the sub-step-shadowline patch defined nothing
  // consumed on a sub-card--fleet line.
  //
  // Safe to read the mirror for the use-site scan: this branch only runs when no
  // touched line contains the region, so region-bearing lines are identical pre- and
  // post-apply by construction.
  // Take the region from metadata when the gap-to-feature pick path threaded it, and
  // otherwise recover it from the summary text. NOT belt-and-braces: the goal-host
  // /run-goal edit-intent path synthesizes its gap pointer from goal TEXT and never
  // populates classification_metadata, so this gate was fully INERT on the busiest
  // route into compose — the same route that escalates on failure. Verified by
  // replaying the exact rejected op through regionContainmentVerdict: it returns
  // contained:false, while production logged hard_fail:false, which can only mean the
  // check never ran. The region was present the whole time, in the summary.
  let containmentNote = "";
  const gapRegion = String((args.gapMeta ?? {})["region"] ?? "").trim()
    || regionFromProposalText(args.gapSummary ?? "");
  if (gapRegion) {
    const touchedLines = args.diff.split("\n").filter((l) => /^[+-]/.test(l) && !/^[+-][+-]/.test(l)).map((l) => l.slice(1));
    const contained = regionContainmentVerdict(touchedLines, gapRegion, args.fileText ?? "");
    if (!contained.contained) {
      // INFORM THE JUDGE; DO NOT VETO (2026-08-07). This started as a hard-fail and
      // its record as a veto is 3 false rejections against 1 real catch — and the
      // real catch (ad706ce, right file wrong region) was approved by the LLM judge
      // anyway, so vetoing never actually prevented it alone.
      //
      // The three it killed were all correct patches whose relationship to the region
      // is real but not textual:
      //   - the fix at the DEFINITION of the value the region renders
      //   - a fix INSERTED ADJACENT to the region statement (add a line after
      //     `record.status = seek.status;` and no changed line contains the region)
      //   - a patch on a gap whose region was a human label, not a locator
      // Each cost the gap a selection cycle, and landability decays per failure, so a
      // false veto does not merely delay a fix — it spends the gap's remaining
      // chances to be chosen at all.
      //
      // Containment is a good SIGNAL and a bad VETO. Keep the deterministic
      // computation and hand it to the judge as a stated fact, which is strictly more
      // information than the judge had when it approved ad706ce with nothing.
      containmentNote = `\n\nDETERMINISTIC LOCATION CHECK (not a verdict — weigh it):\n${contained.reason}\nA patch can still be right when this fires: the fix may belong at the DEFINITION of a value the region renders, or on a line INSERTED ADJACENT to the region rather than on it. Ask whether this change can plausibly affect what the region shows. If it edits an unrelated part of the file — a different region, a different symbol — say addresses:false and name the region in suspected_real_location.`;
      console.log(`[fc-containment] advisory (not a veto) for region "${gapRegion}": ${contained.reason.slice(0, 200)}`);
    }
  }
  const stub = detectNewCapabilityStub(args.diff);
  if (stub.isStub) {
    return {
      addresses: false,
      reason: `new capability is a stub, not a functional implementation — ${stub.reason}`,
      on_live_path: true,
      hard_fail: true,
      llm_consulted: false,
      ...(stub.symbol ? { suspected_real_location: stub.symbol } : {}),
    };
  }
  // ZERO-BEHAVIOR-DELTA HARD-FAIL (2026-07-31). detectNewCapabilityStub above is
  // create-heavy-scoped, so a SURGICAL no-op — a comment-only insert or an empty-bodied
  // shadowed control block — passed every gate. Reject it deterministically on ALL paths
  // (create-heavy and surgical, gap-driven and free-text): inert added code closes no gap.
  const inert = detectZeroBehaviorDelta(args.diff);
  if (inert.isInert) {
    return { addresses: false, reason: `zero behaviour delta — ${inert.reason}`, on_live_path: false, hard_fail: true, llm_consulted: false };
  }
  // DOCUMENTED-CONTRACT FLOOR: a change that narrows what its file documents (a lowered maximum, an omitted optional
  // input now refused, a default replaced, a documented parameter dropped) needs a test of the omission or the
  // boundary in its check, or it does not address anything (d4b09d0, ddf9b46). Deterministic, before the judge.
  if (args.contractFiles && args.contractFiles.length > 0) {
    const narrowed = contractNarrowingRefusal(args.contractFiles, args.checkText ?? "");
    if (narrowed) return narrowed;
  }
  // NO-GAP (free-text spec) → the deterministic floors are the ONLY gate. There is no
  // gap to judge the diff against, so we do NOT run the LLM gap-relative judge (which
  // would otherwise compare the diff to a spec-derived or stale/unrelated gap and
  // wrongly return addresses=false). Having cleared reachability + stub, PASS.
  if (args.runSemanticJudge === false) {
    return { addresses: false, reason: "no gap context (free-text spec) — failed semantic gate", on_live_path: true, llm_consulted: false };
  }
  // Deterministic EFFECT-LESS floor (gap-driven path only — free-text already returned above).
  // A gap that says "compose a report" is NOT closed by adding an unread response header; reject
  // before spending an LLM judge call. Scoped to gap edits, so a legit "add a header" free-text
  // goal is unaffected.
  const effectless = detectEffectlessHeaderOnlyDiff(args.diff);
  if (effectless.isEffectless) {
    return {
      addresses: false,
      reason: `effect-less patch: the only substantive change is response-header emission (${effectless.headers.join(", ")}) — nothing observable (query/body/branch) is composed for the gap`,
      on_live_path: true,
      hard_fail: true,
      llm_consulted: false,
    };
  }
  let raw = "";
  try {
    const archViolations = detectArchitectureViolation(args.diff);
    raw = await args.llm(semanticJudgePrompt(args.gapSummary, args.gapMeta, args.diff, args.reachability, args.data_flow ?? [], args.codeContext ?? "", archViolations, containmentNote));
  } catch (e) {
    // FAIL CLOSED. An unjudged patch does not pass: an unreachable judge is not a verdict, and passing it
    // (as this did) let every judge outage land whatever cleared the deterministic floors, stamped as if
    // judged. Not a hard_fail: an outage names no defect in the patch, so a draft that turned its gap's
    // armed check red->green still lands under dissent (landed_unverified) by semanticGateDisposition.
    return { addresses: false, reason: `semantic judge unavailable (${(e as Error).message}); the patch was not judged, so it does not pass (fail closed)`, on_live_path: true, llm_consulted: false, verified: false, judge_unavailable: true };
  }
  const m = raw.match(/\{[\s\S]*\}/g);
  const parsed = m ? (parseJsonObject(m[0]) as Partial<SemanticGateVerdict> | null) : null;
  if (!parsed || parsed === null || typeof parsed.addresses !== "boolean") {
    // FAIL CLOSED, as above: an answer with no parseable verdict is not a verdict.
    return { addresses: false, reason: "semantic judge answered without a parseable verdict (no JSON object with a boolean `addresses`); the patch was not judged, so it does not pass (fail closed)", on_live_path: true, llm_consulted: true, verified: false, judge_unavailable: true };
  }
  const sus = typeof parsed.suspected_real_location === "string" && parsed.suspected_real_location.trim()
    ? parsed.suspected_real_location.trim()
    : undefined;
  let addresses = parsed.addresses;
  let verdictReason = String(parsed.reason ?? "");
  // §12.6 step 6 (diversity / adversarial-verify quorum): when the first judge PASSES, consult an
  // INDEPENDENT refuter with a DIVERSE (adversarial) lens and flip to addresses:false ONLY on a
  // HIGH-CONFIDENCE, SPECIFIC refutation. Calibrated to catch clear false-passes (inert rename,
  // stub, dead code) without over-rejecting borderline fixes, and fail-open on any refuter
  // error/parse-fail (a flaky second lens must never wedge landing — the first judge stands).
  // SPEC-EXACT SHORT-CIRCUIT: when every changed diff line appears verbatim in the gap text,
  // the gap author already dictated the bytes; the spec is the oracle and a refuter that
  // "disagrees" with it can only be confabulating (measured 2026-09-24 05:26Z, regex escaping).
  const _specExact = (() => {
    // SUBSTANTIVE lines only: a bare brace, a lone `);` or a short keyword line is quoted by
    // accident in almost any gap text, so `includes` on it proves nothing. Require an
    // identifier-bearing line of some length, and require EVERY such line to be quoted.
    const changed = args.diff.split("\n").filter((l) => /^[+-](?![+-])/.test(l)).map((l) => l.slice(1).trim()).filter((l) => l.replace(/\s+/g, "").length >= 12 && /[A-Za-z_$][\w$]{2,}/.test(l));
    return changed.length > 0 && changed.every((l) => args.gapSummary.includes(l));
  })();
  if (_specExact) console.log(`[feature-compose] spec-exact patch: refuters not consulted (the spec is the oracle)`);
  if (addresses === true && !_specExact) {
    try {
      // A QUORUM OF ONE IS NOT A QUORUM.
      //
      // This block calls itself an "adversarial-verify quorum" and then let a SINGLE refuter
      // overturn a passing judge. The only guard on "specific" was reason.length >= 20 —
      // string length standing in for specificity, which it does not measure.
      //
      // MEASURED 2026-08-18, twice on the same file, in opposite directions. Given a vague
      // spec the drafter edited the WRONG regex (the field-name list, not the counting-trigger
      // alternation) and the refuter caught it — correctly, at conf 1.00, citing the exact
      // confusion. Given a spec that named the target regex explicitly, the drafter produced
      // the RIGHT one-line change and the refuter rejected it anyway at conf 0.90 with
      // "only adds 'quantity of' to the regex in line 54, but it does not address the
      // underlying logic of the regex match within the context of the gap" — 110 characters of
      // generality that cleared a 20-character bar. A correct minimal patch was rolled back.
      //
      // A FALSE REJECTION IS WORSE THAN A FALSE PASS HERE: it discards a correct change, and it
      // is the failure mode that makes the substrate unteachable by goal — the operator writes
      // a precise instruction, the drafter follows it, and the gate throws the result away.
      //
      // So require what the comment always claimed: two INDEPENDENT refutations before
      // overturning a judge that passed. Each is sampled separately, so a single adversarial
      // lens having a bad draw can no longer sink a clean patch, while a genuine false-pass
      // (inert rename, stub, dead code) still refutes consistently and is still caught. The
      // second call is paid ONLY when the first judge passed AND the first refuter refuted,
      // which is the rare branch.
      const refute = async (): Promise<{ refuted: boolean; confidence: number; reason: string } | null> => {
        const rraw = await args.llm(refutationPrompt(args.gapSummary, args.diff));
        const rm = rraw.match(/\{[\s\S]*\}/g);
        const rp = rm ? (parseJsonObject(rm[0]) as { refuted?: boolean; confidence?: number; reason?: string } | null) : null;
        if (!rp || rp.refuted !== true || typeof rp.confidence !== "number" || rp.confidence < 0.8) return null;
        if (typeof rp.reason !== "string" || rp.reason.trim().length < 20) return null;
        return { refuted: true, confidence: rp.confidence, reason: rp.reason.trim() };
      };
      const first = await refute();
      if (first) {
        const second = await refute();
        if (second) {
          addresses = false;
          verdictReason = `adversarial refuters agreed 2/2 (conf ${first.confidence.toFixed(2)}, ${second.confidence.toFixed(2)}): ${first.reason} [second lens: ${second.reason}] [first judge had passed: ${verdictReason}]`;
        } else {
          // One lens refuted and the other did not. That is a SPLIT, not a refutation, and the
          // judge that examined the patch on its merits already passed it. Say so in the log so
          // a split is visible rather than silently resolved.
          console.error(`[feature-compose] refuter SPLIT 1/2 — keeping the first judge's PASS. Dissent: ${first.reason.slice(0, 200)}`);
        }
      }
    } catch (e) {
      // FAIL CLOSED, and infrastructure (a non-attempt), like the judge's own outage above: the adversarial lens is part
      // of the verdict whenever the first judge passed, so a pass it could not examine is not a pass.
      return { addresses: false, reason: `adversarial refuter unavailable (${(e as Error).message}); the first judge's pass was not examined, so the patch does not pass (fail closed)`, on_live_path: true, llm_consulted: true, verified: false, judge_unavailable: true };
    }
  }
  return {
    addresses,
    reason: verdictReason,
    on_live_path: parsed.on_live_path !== false,
    ...(sus ? { suspected_real_location: sus } : {}),
    llm_consulted: true,
    verified: true,
  };
}

// Adversarial refutation — the DIVERSE second lens of the close-verdict quorum (§12.6 step 6).
// A single judge shares the drafter's frame and misses inert/surface/stub passes; an independent
// reviewer prompted to REFUTE catches what redundancy cannot. Returns a specific, high-confidence
// refutation or nothing. Deliberately narrow: refute ONLY on a concrete, defensible flaw, never on
// vibes, so the quorum catches clear false-passes without over-rejecting borderline fixes.
function refutationPrompt(gapSummary: string, diff: string): string {
  return `You are an ADVERSARIAL reviewer. A first reviewer judged that this patch ADDRESSES the gap. Your job is to REFUTE that — find CONCRETE evidence the patch does NOT genuinely close the gap on an executing path.

Look specifically for:
- SURFACE-ONLY change: a rename, comment, whitespace, or reordering that leaves the gap's condition STILL TRUE (e.g. renaming a variable while the env-gate / hardcode / defect it names is untouched).
- DEAD CODE / STUB: a net-new function/handler with zero callers, an edit to a path that never runs, or a wired-but-empty endpoint.
- DESTROY-TO-SATISFY: blanking, zeroing, hiding, or removing the value the gap wanted made correct.
- FABRICATE-TO-SATISFY: creating, at runtime, the very thing the gap's check looks for (an empty directory, placeholder file, stub record or default value at the checked path) so an existence or presence check passes while the real source of the divergence is untouched. (A real case: a gap 'no live authoring tree for obsidian-vessel' was "fixed" by mkdir -p /vessels/<vessel>/src inside an unrelated resolver.)
- SATISFY-STALE-TEST: changing working production code only so a failing test passes, when the test is the stale side: the change contradicts a comment or stated rationale beside the edited line, or disables or short-circuits a documented production path (a discovery fallback, a retry, a timeout budget) that the test does not exercise. (Real cases: a resolve timeout lowered from 30000 to 10000 beneath a comment explaining why 30 s is required; an environment guard added that turned off discovery-first resolution in production.) When the test is stale, the fix is the test.
- VIOLATING-LINE-ONLY: the gap is "addressed" only by the offending line (env-gated behaviour kept as env, or an LLM call left inlined) rather than the conformant fix (a shaped impulse read at use time / an llm-prompt resolver).

Cite the EXACT lines. Refute ONLY on a specific, defensible flaw — NEVER on vibes or style. If the patch genuinely closes the gap on a live path, do not refute.

GAP: ${gapSummary}

DIFF:
${diff}

Output ONLY this JSON object, nothing else: {"refuted": <boolean>, "confidence": <number 0..1>, "reason": "<the specific flaw, citing lines>"}`;
}

/** The adversarial lens on a test-writing compose: not "does the patch fix the gap" (it must not), but "is the check red
 *  BECAUSE of the gap's defect". Same output contract as refutationPrompt. */
function testWritingRefutationPrompt(gapSummary: string, diff: string, j: import("../resolvers/check-supply-admission.js").TestWritingJudgement): string {
  const red = [...new Set(j.runs.flatMap((r) => r.red))].slice(0, 8);
  return `You are an ADVERSARIAL reviewer of a FAILING CHECK. This patch adds ONE test (${j.check_file}) that is meant to fail on the current tree BECAUSE of the gap's defect, so the fix can be composed against it. It is NOT meant to change behaviour; do not judge it as a fix. It was run ${j.runs.length} time(s) at the parent and the same assertion failed each time${red.length > 0 ? ` (${red.join("; ")})` : ""}. Your job is to REFUTE that the failure is the gap's defect.

Refute when the check fails for a reason UNRELATED to the defect the gap names, for example:
- it asserts something the gap does not describe, or a value the code was never meant to have;
- it fails on its own fixture, mock or setup (a stub that throws, a wrong path, a missing export it invented) rather than on the code under test;
- it would fail on every tree, whether or not the defect is fixed (expect(1).toBe(2) in disguise, an impossible expectation);
- it exercises a different function or path than the gap's edit site${j.edit_site ? ` (${j.edit_site})` : ""}.

Cite the EXACT lines. Refute ONLY on a specific, defensible flaw. If the check fails because of the defect the gap names, do not refute.

GAP: ${gapSummary}

DIFF:
${diff}

Output ONLY this JSON object, nothing else: {"refuted": <boolean>, "confidence": <number 0..1>, "reason": "<why the failure is not the gap's defect, citing lines>"}`;
}
