// THE must_be_called CONSTRAINT: a semantic-gate "uncalled / dead code" rejection becomes a structural
// constraint on the gap's attempt record, enforced on the next draft before verify.
//
// Live instance (10-01, gap development-vessel-in-flight-counts-only-compose-class-so-restarts-kill-live-llm-dispatches):
// its check needs an exported countsTowardInFlight in src/long-running.ts AND a call in src/index.ts. Drafts converged
// one site per attempt: five did not define it (the check failed), the 04:30 one defined it with no caller and the
// semantic gate rejected it as dead code. Every input below is injected; nothing reaches a live service.

import { describe, it, expect } from "bun:test";
import {
  mustBeCalledFromGate, activeMustBeCalled, checkMustBeCalled, liveCallSites, introducesDefinition, mustBeCalledReason,
  mustBeCalledRefusalRecord, enforcedLessons, escalateRepeatedRefusal, storedRefusalCounts, attemptEvidenceBlock,
  lessonClassMatchesStage, legacyMustBeCalled, constraintRefusalEvidence, constraintParkLine, type MustBeCalledConstraint,
} from "../../src/resolvers/retry-evidence.js";
import { composeLessonClass, composeAttemptEvidence, constraintVerify, constraintGate, type VerifyResult } from "../../src/resolvers/feature-compose.js";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SYM = "countsTowardInFlight";
const LR_PATH = "repos/development-vessel/src/long-running.ts";

// src/long-running.ts on the base, and as a draft that adds the predicate.
const LR_BASE = `export const LONG_RUNNING_TYPES: ReadonlySet<string> = new Set(["feature_compose", "patch_with_tools"]);

export function isLongRunningBody(raw: string): boolean {
  try {
    const b = JSON.parse(raw) as { pointer?: { type?: unknown } };
    return typeof b?.pointer?.type === "string" && LONG_RUNNING_TYPES.has(b.pointer.type);
  } catch {
    return false;
  }
}
`;
const LR_DRAFT = LR_BASE + `
/** Counted toward in_flight: every long-running run, and an llm call. */
export function countsTowardInFlight(raw: string): boolean {
  if (isLongRunningBody(raw)) return true;
  try {
    const b = JSON.parse(raw) as { pointer?: { type?: unknown } };
    return b?.pointer?.type === "llm_completion_dispatch";
  } catch {
    return false;
  }
}
`;
// src/index.ts on the base (counts with the drain predicate), and variants of the second edit.
const INDEX_BASE = `import { isLongRunningBody } from "./long-running.js";
let inFlightRequests = 0;
export function onRequest(raw: string): void {
  if (isLongRunningBody(raw)) {
    inFlightRequests++;
  }
}
`;
const indexWith = (body: string): string => `import { isLongRunningBody, countsTowardInFlight } from "./long-running.js";
let inFlightRequests = 0;
export function onRequest(raw: string): void {
${body}
}
`;
const INDEX_CALLS = indexWith(`  if (countsTowardInFlight(raw)) {
    inFlightRequests++;
  }
  if (isLongRunningBody(raw)) return;`);

// The 04:30 rejection: the reason verbatim from the gap's lesson; facts as the reachability loop computes them for a
// new exported function with no caller in src/ (callerCount 0, exported, isNewFunction -> unreachable).
const GATE_0430 = {
  addresses: false,
  on_live_path: false,
  reason: "The new `countsTowardInFlight` function is not called anywhere in the codebase, making it dead code that doesn't affect the in-flight count behavior.",
};
const FACTS_0430 = [
  { symbol: SYM, isNewFunction: true, callerCount: 0, isEntrypoint: true, reachable: false },
  { symbol: "isLongRunningBody", isNewFunction: false, callerCount: 2, isEntrypoint: true, reachable: true },
];
const introducedBy = (draft: Array<{ path: string; pre: string; post: string }>) => (sym: string): string | null => draft.find((d) => introducesDefinition(d.pre, d.post, sym))?.path ?? null;

const CONSTRAINT: MustBeCalledConstraint = { kind: "must_be_called", symbol: SYM, introduced_in: LR_PATH };
const LESSON_0430 = { at: "2026-10-01T04:30:52.957Z", class: "semantic_reject", stage: null, edited_spans: [], constraints: [CONSTRAINT] };

/** The vessel's src as the retry draft leaves it, plus that draft's edits (pre -> post). */
/** The retry draft's edits (pre -> post); `added` are files the draft created. Only touched files are judged. */
function retry(indexPost: string, added: Array<{ path: string; content: string }> = []) {
  const edits = [
    { path: LR_PATH, pre: LR_BASE, post: LR_DRAFT },
    ...(indexPost !== INDEX_BASE ? [{ path: "repos/development-vessel/src/index.ts", pre: INDEX_BASE, post: indexPost }] : []),
    ...added.map((a) => ({ path: a.path, pre: "", post: a.content })),
  ];
  return { edits };
}

describe("RECORD: a semantic-gate rejection naming an uncalled symbol the draft introduced", () => {
  const draft = [{ path: LR_PATH, pre: LR_BASE, post: LR_DRAFT }];

  it("records must_be_called(countsTowardInFlight) introduced in src/long-running.ts from the 04:30 rejection", () => {
    expect(mustBeCalledFromGate(GATE_0430, FACTS_0430, introducedBy(draft))).toEqual([CONSTRAINT]);
  });

  it("records from the reason alone when the reachability facts are empty (LLM judge path)", () => {
    expect(mustBeCalledFromGate(GATE_0430, [], introducedBy(draft))).toEqual([CONSTRAINT]);
  });

  it("records from unreachable_symbols alone when the reason does not say 'uncalled'", () => {
    expect(mustBeCalledFromGate({ addresses: false, reason: "edits the wrong function" }, FACTS_0430, introducedBy(draft))).toEqual([CONSTRAINT]);
  });

  it("a reason backticking an EXISTING base symbol (as uncalled) records no constraint for it", () => {
    const reason = "The new predicate is fine but `isLongRunningBody` is never called on the in-flight path; dead code.";
    expect(mustBeCalledFromGate({ addresses: false, on_live_path: false, reason }, [], introducedBy(draft))).toEqual([]);
  });

  it("records nothing for an accepted draft, nor for a symbol the draft did not introduce", () => {
    expect(mustBeCalledFromGate({ addresses: true, on_live_path: true, reason: "ok" }, FACTS_0430, introducedBy(draft))).toEqual([]);
    expect(mustBeCalledFromGate({ addresses: false, reason: "`isLongRunningBody` is never called" }, [], introducedBy(draft))).toEqual([]);
  });
});

describe("ENFORCE on the next attempt of the same gap", () => {
  const lessons = [LESSON_0430];

  it("a retry that DEFINES but does not CALL it is refused with the constraint's reason", async () => {
    const { edits } = retry(INDEX_BASE);
    const r = await checkMustBeCalled(activeMustBeCalled(lessons), edits);
    expect(r.unmet.map((u) => u.symbol)).toEqual([SYM]);
    expect(r.reason).toContain(`constraint must_be_called(${SYM}) unmet: define AND call it on the live path`);
  });

  it("a retry that DEFINES AND CALLS it on the live path passes the constraint", async () => {
    const { edits } = retry(INDEX_CALLS);
    const r = await checkMustBeCalled(activeMustBeCalled(lessons), edits);
    expect(r.unmet).toEqual([]);
    expect(r.reason).toBe("");
  });

  it("the function passed as a value (a callback) is a live use", async () => {
    const { edits } = retry(indexWith(`  inFlightRequests += [raw].filter(countsTowardInFlight).length;`));
    expect((await checkMustBeCalled([CONSTRAINT], edits)).unmet).toEqual([]);
  });

  it("a draft that does not define the symbol is not held to it (the check, not this gate, judges that draft)", async () => {
    const r = await checkMustBeCalled([CONSTRAINT], [{ path: "repos/development-vessel/src/index.ts", pre: INDEX_BASE, post: INDEX_BASE + "\n// touched\n" }]);
    expect(r.unmet).toEqual([]);
  });

  it("a lineage child (recommit / narrowed) inherits the source gap's constraint", async () => {
    const enforced = enforcedLessons({ meta: { failure_lessons: [] }, lineage_lessons: lessons });
    const { edits } = retry(INDEX_BASE);
    expect((await checkMustBeCalled(activeMustBeCalled(enforced), edits)).unmet.map((u) => u.symbol)).toEqual([SYM]);
  });
});

describe("NOT a call on the live path", () => {
  const refused = async (indexPost: string, extra: Array<{ path: string; content: string }> = []) => {
    const { edits } = retry(indexPost, extra);
    return (await checkMustBeCalled([CONSTRAINT], edits)).unmet.map((u) => u.detail).join(" ");
  };

  it("a call only in a test file (in src/ or test/)", async () => {
    const t = `import { countsTowardInFlight } from "./long-running.js";\nif (countsTowardInFlight("{}")) console.log("x");\n`;
    expect(await refused(INDEX_BASE, [{ path: "src/long-running.test.ts", content: t }, { path: "test/long-running-in-flight.test.ts", content: t }])).toContain("in a test file");
  });

  it("a call only in dead code: if (false)", async () => {
    expect(await refused(indexWith(`  if (false) {\n    if (countsTowardInFlight(raw)) inFlightRequests++;\n  }\n  if (isLongRunningBody(raw)) inFlightRequests++;`))).toContain("dead code");
  });

  it("a call only in dead code: after a return", async () => {
    expect(await refused(indexWith(`  if (isLongRunningBody(raw)) inFlightRequests++;\n  return;\n  if (countsTowardInFlight(raw)) inFlightRequests++;`))).toContain("dead code");
  });

  it("a mention only in a comment or a string", async () => {
    const d = await refused(indexWith(`  // countsTowardInFlight(raw) would count llm calls\n  console.log("countsTowardInFlight(raw)");\n  if (isLongRunningBody(raw)) inFlightRequests++;`));
    expect(d).toContain("no call site");
  });

  it("a call whose boolean result is discarded", async () => {
    expect(await refused(indexWith(`  countsTowardInFlight(raw);\n  if (isLongRunningBody(raw)) inFlightRequests++;`))).toContain("result is discarded");
  });

  it("a call only inside its own definition (recursion)", async () => {
    const selfOnly = LR_DRAFT.replace(`return b?.pointer?.type === "llm_completion_dispatch";`, `return b?.pointer?.type === "llm_completion_dispatch" || countsTowardInFlight(String(b));`);
    const r = await checkMustBeCalled([CONSTRAINT], [{ path: LR_PATH, pre: LR_BASE, post: selfOnly }]);
    expect(r.unmet.map((u) => u.detail).join(" ")).toContain("inside its own definition");
  });
});

describe("MIGRATION: a lesson written before the constraints field", () => {
  // The live 04:30 lesson's shape: class, verbatim reason, edited_spans, own_check; no constraints field.
  const LEGACY_0430 = {
    at: "2026-10-01T04:30:52.957Z", class: "semantic_reject", stage: null,
    reason: GATE_0430.reason, raw_excerpt: GATE_0430.reason,
    edited_spans: [{ path: LR_PATH, start: 60, end: 60, text_sha: "x", base: "y", unique: true }],
    own_check: { test_file: "test/long-running-in-flight.test.ts", failing: [] }, parent_cached: "miss",
  };

  it("derives must_be_called(countsTowardInFlight) from the live lesson's reason, so the very next draft is held to it", async () => {
    expect(legacyMustBeCalled(LEGACY_0430)).toEqual([{ ...CONSTRAINT, derived: true }]);
    const { edits } = retry(INDEX_BASE);
    expect((await checkMustBeCalled(activeMustBeCalled([LEGACY_0430]), edits)).unmet.map((u) => u.symbol)).toEqual([SYM]);
  });

  it("derives nothing from a semantic_reject that names no uncalled symbol, or from another class", () => {
    expect(legacyMustBeCalled({ ...LEGACY_0430, reason: "edits the wrong function", raw_excerpt: "edits the wrong function" })).toEqual([]);
    expect(legacyMustBeCalled({ ...LEGACY_0430, class: "typecheck_dangling_reference" })).toEqual([]);
  });

  it("a derived constraint naming a symbol the base already has (an existing API in the prose) is lifted, not enforced", async () => {
    const reason = "The edit leaves `isLongRunningBody` uncalled on the new path; dead code.";
    const legacy = { ...LEGACY_0430, reason, raw_excerpt: reason };
    const { edits } = retry(INDEX_BASE);
    const r = await checkMustBeCalled(activeMustBeCalled([legacy]), edits);
    expect(r.unmet).toEqual([]);
    expect(r.lifted.map((l) => l.symbol)).toEqual(["isLongRunningBody"]);
  });

  it("...even when the draft rewrites that existing, uncalled API's definition line", async () => {
    const reason = "The draft edits `legacyHelper`, which is never called; dead code.";
    const legacy = { ...LEGACY_0430, reason, raw_excerpt: reason };
    const pre = LR_BASE + "export function legacyHelper(): number { return 1; }\n";
    const post = LR_BASE + "export function legacyHelper(): number { return 2; }\n";
    const r = await checkMustBeCalled(activeMustBeCalled([legacy]), [{ path: LR_PATH, pre, post }]);
    expect(r.unmet).toEqual([]);
    expect(r.lifted.map((l) => l.symbol)).toEqual(["legacyHelper"]);
  });

  it("a later lift ends a derived constraint too", () => {
    expect(activeMustBeCalled([LEGACY_0430, { at: "z", constraints_lifted: [{ symbol: SYM, why: "met" }] }])).toEqual([]);
  });
});

describe("ONE-HOP LIVENESS: the caller must itself be live", () => {
  const withHelper = (helper: string, body: string) => indexWith(`${body}`).replace("export function onRequest", `${helper}\nexport function onRequest`);
  const hopCheck = async (indexPost: string) => {
    const { edits } = retry(indexPost);
    return checkMustBeCalled([CONSTRAINT], edits);
  };
  const WRAP = `function wrap(raw: string): boolean {\n  return countsTowardInFlight(raw);\n}`;

  it("called only from a NEW helper nothing calls: refused", async () => {
    const r = await hopCheck(withHelper(WRAP, `  if (isLongRunningBody(raw)) inFlightRequests++;`));
    expect(r.unmet.map((u) => u.symbol)).toEqual([SYM]);
    expect(r.unmet[0]!.detail).toContain("called only from wrap");
  });

  it("called from a function the base already has (onRequest): passes", async () => {
    expect((await hopCheck(INDEX_CALLS)).unmet).toEqual([]);
  });

  it("called from a NEW helper that a pre-existing function calls (depth 2): passes", async () => {
    expect((await hopCheck(withHelper(WRAP, `  if (wrap(raw)) inFlightRequests++;`))).unmet).toEqual([]);
  });

  it("a same-named function in a DIFFERENT base file does not count as existing", async () => {
    // wrap() is new in src/index.ts; another file's base happens to define a wrap() too. Name alone must not pass it.
    const { edits } = retry(withHelper(WRAP, `  if (isLongRunningBody(raw)) inFlightRequests++;`));
    const other = { path: "repos/development-vessel/src/util.ts", pre: "export function wrap(x: string): string {\n  return x;\n}\n", post: "export function wrap(x: string): string {\n  return x.trim();\n}\n" };
    const r = await checkMustBeCalled([CONSTRAINT], [...edits, other]);
    expect(r.unmet.map((u) => u.symbol)).toEqual([SYM]);
  });

  it("two new helpers deep (depth 3): refused", async () => {
    const two = `${WRAP}\nfunction wrap2(raw: string): boolean {\n  return wrap(raw);\n}`;
    expect((await hopCheck(withHelper(two, `  if (wrap2(raw)) inFlightRequests++;`))).unmet.map((u) => u.symbol)).toEqual([SYM]);
  });
});

describe("COULD NOT RUN is an environment failure", () => {
  const vesselDir = () => {
    const root = mkdtempSync(join(tmpdir(), "mbc-unrun-"));
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src", "long-running.ts"), LR_DRAFT);
    writeFileSync(join(root, "src", "index.ts"), INDEX_BASE);
    return root;
  };
  // The draft names a file that cannot be read: the check cannot run.
  const unreadable = (root: string) => [{ abs: join(root, "src", "gone.ts"), rel: "repos/development-vessel/src/gone.ts", pre: "" }];
  const GREEN: VerifyResult = { vessel: "development-vessel", errors: 0, exit_code: 0, ok: true, output: "TC_EXIT=0", stage: null };
  const RED: VerifyResult = { vessel: "development-vessel", errors: "verify", exit_code: 2, ok: false, output: "src/x.ts(1,1): error TS1005: ';' expected.\nTC_EXIT=2", stage: "typecheck" };

  it("fails closed on an otherwise-green draft, classed environment, never constraint_unmet", async () => {
    const root = vesselDir();
    try {
      const cv = await constraintVerify("development-vessel", root, [CONSTRAINT], unreadable(root), "g1");
      expect(cv.refusal).toBeNull();
      const r = await constraintGate(cv, async () => GREEN);
      expect(r.ok).toBe(false);
      expect(r.constraint_unmet).toBeUndefined();
      expect(composeLessonClass(null, null, [{ ok: true }], [r], "")).toBe("env_constraint_unrunnable");
      expect(lessonClassMatchesStage("env_constraint_unrunnable", "constraint")).toBe(true);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("a draft that fails verify on its own keeps its own failure (the check did not mask it)", async () => {
    const root = vesselDir();
    try {
      const cv = await constraintVerify("development-vessel", root, [CONSTRAINT], unreadable(root), "g1");
      expect(await constraintGate(cv, async () => RED)).toBe(RED);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("a file the parser rejects is could-not-run too", async () => {
    const root = vesselDir();
    try {
      // A file the draft TOUCHED that mentions the symbol and does not parse.
      writeFileSync(join(root, "src", "index.ts"), INDEX_CALLS + "\nexport function broken( {\n");
      const cv = await constraintVerify("development-vessel", root, [CONSTRAINT], [{ abs: join(root, "src", "long-running.ts"), rel: LR_PATH, pre: LR_BASE }, { abs: join(root, "src", "index.ts"), rel: "repos/development-vessel/src/index.ts", pre: INDEX_BASE }], "g1");
      expect(cv.unrunnable?.constraint_unrunnable).toContain("could not parse");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("an unparseable UNTOUCHED file mentioning the symbol does not affect the verdict", async () => {
    const root = vesselDir();
    try {
      writeFileSync(join(root, "src", "index.ts"), INDEX_CALLS);
      writeFileSync(join(root, "src", "stale.ts"), `// ${SYM}\nexport function broken( {\n`);
      const draft = [{ abs: join(root, "src", "long-running.ts"), rel: LR_PATH, pre: LR_BASE }, { abs: join(root, "src", "index.ts"), rel: "repos/development-vessel/src/index.ts", pre: INDEX_BASE }];
      const cv = await constraintVerify("development-vessel", root, [CONSTRAINT], draft, "g1");
      expect(cv.unrunnable).toBeUndefined();
      expect(cv.refusal).toBeNull();
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("could-not-run twice does not escalate", async () => {
    const root = vesselDir();
    const calls: string[] = [];
    const esc = async (_g: Record<string, unknown>, why: string) => { calls.push(why); return "decomposed"; };
    try {
      const lessons: Array<Record<string, unknown>> = [];
      for (let i = 0; i < 2; i++) {
        const cv = await constraintVerify("development-vessel", root, [CONSTRAINT], unreadable(root), "g1");
        const verify = [await constraintGate(cv, async () => GREEN)];
        const ce = await constraintRefusalEvidence(verify, { id: "g1" }, lessons, esc);
        expect(ce.escalation).toBeUndefined();
        lessons.push({ ...composeAttemptEvidence([{ ok: true }], [], verify, false, null).record, refusals: ce.refusals, class: composeLessonClass(null, null, [{ ok: true }], verify, "") });
      }
      expect(calls).toEqual([]);
      expect(lessons.map((l) => l.class)).toEqual(["env_constraint_unrunnable", "env_constraint_unrunnable"]);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("CONTROL: an unmet constraint refused twice DOES escalate, once", async () => {
    const root = vesselDir();
    const calls: string[] = [];
    const esc = async (_g: Record<string, unknown>, why: string) => { calls.push(why); return "decomposed"; };
    try {
      const lessons: Array<Record<string, unknown>> = [];
      const outcomes: unknown[] = [];
      for (let i = 0; i < 3; i++) {
        const cv = await constraintVerify("development-vessel", root, [CONSTRAINT], [{ abs: join(root, "src", "long-running.ts"), rel: LR_PATH, pre: LR_BASE }], "g1");
        const verify = [await constraintGate(cv, async () => GREEN)];
        const ce = await constraintRefusalEvidence(verify, { id: "g1" }, lessons, esc);
        outcomes.push(ce.escalation?.outcome);
        lessons.push({ refusals: ce.refusals, ...(ce.escalation ? { escalation: ce.escalation } : {}) });
      }
      expect(outcomes).toEqual([undefined, "decomposed", undefined]);
      expect(calls.length).toBe(1);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

describe("an unrelated gap is not constrained", () => {
  it("another gap's lessons carry no constraint, so the same uncalled definition passes this gate", async () => {
    const other = [{ at: "2026-10-01T01:00:00Z", class: "typecheck_dangling_reference", stage: "typecheck", edited_spans: [] }];
    expect(activeMustBeCalled(other)).toEqual([]);
    const { edits } = retry(INDEX_BASE);
    expect((await checkMustBeCalled(activeMustBeCalled(other), edits)).unmet).toEqual([]);
  });
});

describe("LIFT: a constraint never blocks forever", () => {
  it("a later lesson lifting the symbol (the gate judged it reachable) ends it", () => {
    const lifted = [LESSON_0430, { at: "2026-10-01T06:00:00Z", class: "verify_failed", stage: "tests", edited_spans: [], constraints_lifted: [{ symbol: SYM, why: "the semantic gate judged it reachable" }] }];
    expect(activeMustBeCalled(lifted)).toEqual([]);
    // A NEW rejection after the lift imposes it again.
    expect(activeMustBeCalled([...lifted, LESSON_0430]).map((c) => c.symbol)).toEqual([SYM]);
  });

  it("a closed or superseded gap enforces nothing", () => {
    expect(activeMustBeCalled([LESSON_0430], "closed")).toEqual([]);
    expect(activeMustBeCalled([LESSON_0430], "superseded")).toEqual([]);
  });

  it("after it landed (the base defines and calls it), a draft that does not redefine it is not refused", async () => {
    const r = await checkMustBeCalled([CONSTRAINT], [{ path: "repos/development-vessel/src/other.ts", pre: "", post: "export const x = 1;\n" }]);
    expect(r.unmet).toEqual([]);
  });

  it("a DERIVED constraint is lifted when its defining file's base (read from disk, untouched by the draft) defines it", async () => {
    const legacy = legacyMustBeCalled({ class: "semantic_reject", reason: GATE_0430.reason, edited_spans: [{ path: LR_PATH }] });
    const reads: string[] = [];
    const readBase = (p: string): string | null => { reads.push(p); return p === LR_PATH ? LR_DRAFT : null; };
    const r = await checkMustBeCalled(activeMustBeCalled([{ class: "semantic_reject", reason: GATE_0430.reason, edited_spans: [{ path: LR_PATH }] }]), [{ path: "repos/development-vessel/src/other.ts", pre: "", post: "export const x = 1;\n" }], readBase);
    expect(legacy.map((c) => c.derived)).toEqual([true]);
    expect(reads).toEqual([LR_PATH]);
    expect(r.lifted.map((l) => l.symbol)).toEqual([SYM]);
  });
});

describe("the record carries the constraint to the next prompt and to the escalation", () => {
  it("the prior-attempt block shows the active constraint as data", () => {
    expect(attemptEvidenceBlock([LESSON_0430])).toContain(`CONSTRAINT must_be_called(${SYM}) (introduced in ${LR_PATH})`);
    expect(attemptEvidenceBlock([LESSON_0430, { at: "x", stage: "tests", edited_spans: [], constraints_lifted: [{ symbol: SYM, why: "met" }] }])).not.toContain("CONSTRAINT must_be_called");
  });

  it("a refusal repeated on one constraint escalates once, through the injected decompose path", async () => {
    const rec = mustBeCalledRefusalRecord(CONSTRAINT);
    const calls: string[] = [];
    const esc = async (_g: Record<string, unknown>, why: string) => { calls.push(why); return "decomposed"; };
    const gap = { id: "g1" };
    expect(await escalateRepeatedRefusal(gap, [LESSON_0430], [rec], esc)).toBeUndefined();
    const first = await escalateRepeatedRefusal(gap, [{ ...LESSON_0430, refusals: [rec] }], [rec], esc);
    expect(first?.region).toBe(`must_be_called:${SYM}`);
    expect(await escalateRepeatedRefusal(gap, [{ ...LESSON_0430, refusals: [rec], escalation: first }], [rec], esc)).toBeUndefined();
    expect(calls.length).toBe(1);
  });

  it("a constraint refusal is classed constraint_unmet at stage constraint, and is not counted as a no-effect refusal", () => {
    expect(composeLessonClass(null, null, [{ ok: true }], [{ ok: false, output: `== constraint == | CONSTRAINT UNMET: ${mustBeCalledReason(SYM)}`, stage: "constraint" }], "")).toBe("constraint_unmet");
    expect(lessonClassMatchesStage("constraint_unmet", "constraint")).toBe(true);
    expect(lessonClassMatchesStage("semantic_reject", "constraint")).toBe(false);
    const at = new Date().toISOString();
    const counts = storedRefusalCounts([{ id: "g1", classification_metadata: { failure_lessons: [{ at, refusals: [mustBeCalledRefusalRecord(CONSTRAINT)] }] } }], 0);
    expect(counts.get("g1")?.n).toBe(0);
  });
});

describe("liveCallSites", () => {
  it("liveCallSites reports where each rejected use is", async () => {
    const r = await liveCallSites(SYM, [{ path: "src/long-running.ts", content: LR_DRAFT }, { path: "src/x.test.ts", content: `${SYM}("{}") ? 1 : 0;` }]);
    expect(r.live).toEqual([]);
    expect(r.returns_value).toBe(true);
    expect(r.rejected).toEqual([{ path: "src/x.test.ts", line: 1, why: "in a test file" }]);
  });
});

describe("the compose call site: the applied draft on disk, before the suite runs", () => {
  const vessel = (index: string) => {
    const root = mkdtempSync(join(tmpdir(), "mbc-vessel-"));
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src", "long-running.ts"), LR_DRAFT);
    writeFileSync(join(root, "src", "index.ts"), index);
    return root;
  };
  const draftOf = (root: string) => [{ abs: join(root, "src", "long-running.ts"), rel: LR_PATH, pre: LR_BASE }, { abs: join(root, "src", "index.ts"), rel: "repos/development-vessel/src/index.ts", pre: INDEX_BASE }];

  it("refuses the define-only retry as a failed verify at stage constraint, and the lesson says so", async () => {
    const root = vessel(INDEX_BASE);
    try {
      const cv = await constraintVerify("development-vessel", root, activeMustBeCalled([LESSON_0430]), draftOf(root), "g1");
      expect(cv.refusal?.ok).toBe(false);
      expect(cv.refusal?.stage).toBe("constraint");
      expect(cv.refusal?.output).toContain(`constraint must_be_called(${SYM}) unmet: define AND call it on the live path`);
      expect(cv.refusal?.constraint_unmet).toEqual([CONSTRAINT]);
      const verify = [cv.refusal!];
      expect(composeAttemptEvidence([{ ok: true }], [], verify, false, null).record.stage).toBe("constraint");
      expect(composeLessonClass(null, null, [{ ok: true }], verify, "")).toBe("constraint_unmet");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("lets the define-and-call retry through to verify", async () => {
    const root = vessel(INDEX_CALLS);
    try {
      expect((await constraintVerify("development-vessel", root, activeMustBeCalled([LESSON_0430]), draftOf(root), "g1")).refusal).toBeNull();
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

describe("PARK GUARD: the constraint check could not run on consecutive attempts", () => {
  const U = { class: "env_constraint_unrunnable", stage: "constraint" };
  const OTHER = { class: "verify_failed", stage: "tests" };
  const lineFor = (prior: unknown[]) => constraintParkLine("g1", prior, "env_constraint_unrunnable", "constraint check could not parse src/x.ts");

  it("two consecutive could-not-run attempts emit the PARKED line once, naming the count", () => {
    const emitted: string[] = [];
    const lessons: unknown[] = [];
    for (let i = 0; i < 2; i++) { const l = lineFor(lessons); if (l) emitted.push(l); lessons.push(U); }
    expect(emitted).toEqual(["[fc-constraint] PARKED gap=g1: constraint check could not run on 2 consecutive attempts (constraint check could not parse src/x.ts)"]);
    expect(new RegExp(String.raw`^\[fc-constraint\] PARKED gap=`).test(emitted[0]!)).toBe(true);
  });

  it("non-consecutive (another failure between) does not", () => {
    expect(lineFor([U, OTHER])).toBeNull();
    expect(lineFor([])).toBeNull();
  });

  it("a separately written no_effect_region lesson is not an attempt and does not break the run", () => {
    expect(lineFor([U, { class: "no_effect_region" }])).toContain("on 2 consecutive attempts");
  });

  it("another class this attempt: no line", () => {
    expect(constraintParkLine("g1", [U, U], "constraint_unmet", "x")).toBeNull();
  });
});
