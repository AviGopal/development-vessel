// RETRY EVIDENCE (intervention 2, 09-30): a retry is held to what the previous failed attempt measured.
//
// The drain gap's 9 drafts landed at 7 wrong sites because each retry got test NAMES without Expected/Received,
// a lesson from ANOTHER gap's test (the full-suite head), a typecheck class from a PASSING test's name, no record
// that the draft changed nothing vs the parent, a window that ignored "~l.249-264", and (on the edit-intent route)
// no store metadata at all. Each behaviour below is pinned against injected inputs; the bun output fixtures are
// real captures (bun 1.3.14, env -i, not a TTY) with the path rewritten.

import { describe, it, expect, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  refusalJournalLine, refusalJournalCounts, storedRefusalCounts, refusalsNotRecorded, REFUSAL_JOURNAL_GREP,
  noEffectOverlapRefusal, baseSpanOfOp, spanRecord, parseOwnCheckFailures, sameOwnCheckFailures,
  hydrateComposeGap, parentCheckBlock, enforcedLessons, checkOpNoEffect, locateSpan, repeatedRefusalRegion, escalateRepeatedRefusal, gateCallSites, type RefusalRecord, explicitLineHint, measureRetryEvidence, type GapRowReader,
} from "../../src/resolvers/retry-evidence.js";
import { composeLessonClass, composeAttemptEvidence, focusedSlice, priorAttemptFeedbackBlock, type VerifyResult } from "../../src/resolvers/feature-compose.js";
import { specFromGap } from "../../src/resolvers/gap-to-feature.js";
import { useUngatedRowsSource } from "../helpers/ungated-rows-source.js";
// These tests exercise the ungated rows path (origin/dev); a gated node reads the gate-fed copy instead.
useUngatedRowsSource();

// The gap's own check, run alone (bun test ./test/own.test.ts).
const OWN_RAW = `bun test v1.3.14 (0d9b296a)

own.test.ts:
1 | import { describe, it, expect } from "bun:test";
2 | describe("drain", () => {
3 |   it("redispatches the parked gap", () => { expect(2).toBe(3); });
                                                          ^
error: expect(received).toBe(expected)

Expected: 3
Received: 2

      at <anonymous> (/w/repos/development-vessel/test/own.test.ts:3:55)
(fail) drain > redispatches the parked gap [0.14ms]
(pass) drain > keeps TS2304 baseline stays delta-excused [0.02ms]
1 | import { describe, it, expect } from "bun:test";
2 | describe("drain", () => {
3 |   it("redispatches the parked gap", () => { expect(2).toBe(3); });
4 |   it("keeps TS2304 baseline stays delta-excused", () => { expect(1).toBe(1); });
5 |   it("carries the record", () => { expect({ a: 1, b: "x" }).toEqual({ a: 1, b: "y" }); });
                                                                ^
error: expect(received).toEqual(expected)

  {
    "a": 1,
-   "b": "y",
+   "b": "x",
  }

- Expected  - 1
+ Received  + 1

      at <anonymous> (/w/repos/development-vessel/test/own.test.ts:5:61)
(fail) drain > carries the record [0.11ms]
1 | import { describe, it, expect } from "bun:test";
2 | describe("drain", () => {
3 |   it("redispatches the parked gap", () => { expect(2).toBe(3); });
4 |   it("keeps TS2304 baseline stays delta-excused", () => { expect(1).toBe(1); });
5 |   it("carries the record", () => { expect({ a: 1, b: "x" }).toEqual({ a: 1, b: "y" }); });
6 |   it("counts", () => { expect([1,2]).toHaveLength(3); });
                                         ^
error: expect(received).toHaveLength(expected)

Expected length: 3
Received length: 2

      at <anonymous> (/w/repos/development-vessel/test/own.test.ts:6:38)
(fail) drain > counts [0.05ms]

 1 pass
 3 fail
 4 expect() calls
Ran 4 tests across 1 file. [9.00ms]
`;

// The FULL suite: another gap's check fails FIRST (other.test.ts), then the own file.
const SUITE_RAW = `bun test v1.3.14 (0d9b296a)

other.test.ts:
1 | import { it, expect } from "bun:test";
2 | it("in-flight counting keeps one slot per gap", () => { expect(7).toBe(1); });
                                                                      ^
error: expect(received).toBe(expected)

Expected: 1
Received: 7

      at <anonymous> (/w/repos/development-vessel/test/other.test.ts:2:67)
(fail) in-flight counting keeps one slot per gap [0.19ms]

own.test.ts:
1 | import { describe, it, expect } from "bun:test";
2 | describe("drain", () => {
3 |   it("redispatches the parked gap", () => { expect(2).toBe(3); });
                                                          ^
error: expect(received).toBe(expected)

Expected: 3
Received: 2

      at <anonymous> (/w/repos/development-vessel/test/own.test.ts:3:55)
(fail) drain > redispatches the parked gap [0.06ms]
(pass) drain > keeps TS2304 baseline stays delta-excused [0.02ms]
1 | import { describe, it, expect } from "bun:test";
2 | describe("drain", () => {
3 |   it("redispatches the parked gap", () => { expect(2).toBe(3); });
4 |   it("keeps TS2304 baseline stays delta-excused", () => { expect(1).toBe(1); });
5 |   it("carries the record", () => { expect({ a: 1, b: "x" }).toEqual({ a: 1, b: "y" }); });
                                                                ^
error: expect(received).toEqual(expected)

  {
    "a": 1,
-   "b": "y",
+   "b": "x",
  }

- Expected  - 1
+ Received  + 1

      at <anonymous> (/w/repos/development-vessel/test/own.test.ts:5:61)
(fail) drain > carries the record [0.11ms]
1 | import { describe, it, expect } from "bun:test";
2 | describe("drain", () => {
3 |   it("redispatches the parked gap", () => { expect(2).toBe(3); });
4 |   it("keeps TS2304 baseline stays delta-excused", () => { expect(1).toBe(1); });
5 |   it("carries the record", () => { expect({ a: 1, b: "x" }).toEqual({ a: 1, b: "y" }); });
6 |   it("counts", () => { expect([1,2]).toHaveLength(3); });
                                         ^
error: expect(received).toHaveLength(expected)

Expected length: 3
Received length: 2

      at <anonymous> (/w/repos/development-vessel/test/own.test.ts:6:38)
(fail) drain > counts [0.07ms]

 1 pass
 4 fail
 5 expect() calls
Ran 5 tests across 2 files. [11.00ms]
`;

// A compose verify log whose typecheck PASSED, with the full suite in its tests section.
const VERIFY_LOG_TC0 = "== install ==\n== resolve ==\nDRYRUN_EXIT=0\n== typecheck ==\n$ tsc --noEmit\nTC_EXIT=0\n== shape-dispatch ==\nSD_EXIT=0\n== tests ==\n" + SUITE_RAW;

const FILE = "repos/development-vessel/src/resolvers/gap-drain.ts";
const BASE = Array.from({ length: 400 }, (_, i) => `const line${i + 1} = ${i + 1};`).join("\n");

function noEffectLesson(start: number, end: number, noEffect = true) {
  return { at: "2026-09-30T20:00:00.000Z", class: "verify_failed", stage: "own_check", no_effect_vs_parent: noEffect, edited_spans: [spanRecord(FILE, BASE, start, end)], own_check: { test_file: "test/own.test.ts", failing: parseOwnCheckFailures(OWN_RAW, ["redispatches the parked gap"]) } };
}

describe("a retry may not re-edit a region a prior attempt edited with no effect", () => {
  it("refuses an edit whose base span overlaps a no-effect span, and the refusal is its own lesson class", () => {
    const lessons = [noEffectLesson(120, 130)];
    const op = { kind: "edit", old_string: "const line125 = 125;\nconst line126 = 126;" };
    const span = baseSpanOfOp(BASE, op);
    expect(span).toEqual({ start: 125, end: 126 });
    const refusal = noEffectOverlapRefusal(FILE, BASE, span, lessons);
    expect(refusal).toContain("NO-EFFECT REGION REFUSED");
    expect(refusal).toContain(`${FILE}:120-130`);
    expect(composeLessonClass(null, null, [{ ok: false, detail: refusal! }], [], "")).toBe("no_effect_region");
  });

  it("still refuses after the file moved: the region is found again by its text", () => {
    const lessons = [noEffectLesson(120, 130)];
    const moved = "// inserted\n// by another landing\n" + BASE;
    expect(noEffectOverlapRefusal(FILE, moved, { start: 124, end: 124 }, lessons)).toContain(`${FILE}:122-132`);
  });

  it("allows an edit that does not overlap, an edit to another file, and an overlap with a region that DID have an effect", () => {
    const lessons = [noEffectLesson(120, 130)];
    expect(noEffectOverlapRefusal(FILE, BASE, { start: 131, end: 140 }, lessons)).toBeNull();
    expect(noEffectOverlapRefusal("repos/development-vessel/src/other.ts", BASE, { start: 125, end: 125 }, lessons)).toBeNull();
    expect(noEffectOverlapRefusal(FILE, BASE, { start: 125, end: 125 }, [noEffectLesson(120, 130, false)])).toBeNull();
  });
});

describe("an explicit ~l.NNN in the gap sets the window", () => {
  const BIG = Array.from({ length: 2000 }, (_, i) => `export const v${i + 1} = "value number ${i + 1}";`).join("\n");

  it("focusedSlice centres on the hinted lines ahead of a probe that matches elsewhere", () => {
    expect(explicitLineHint("the drain miscounts (~l.1500-1510 of gap-drain.ts)")).toEqual({ start: 1500, end: 1510 });
    const { slice } = focusedSlice(BIG, 26_000, [], ["export const v10 ="], explicitLineHint("see ~l.1500-1510"));
    expect(slice).toContain("export const v1500 =");
    expect(slice).toContain("export const v1510 =");
    expect(slice).not.toContain("export const v10 =");
  });

  let dir = "";
  const prev = process.env["MITOSIS_RUNTIME_DIR"];
  afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); dir = ""; if (prev === undefined) delete process.env["MITOSIS_RUNTIME_DIR"]; else process.env["MITOSIS_RUNTIME_DIR"] = prev; });

  it("specFromGap grounds at the hinted line, not at the first matching symbol", () => {
    dir = mkdtempSync(join(tmpdir(), "retry-evidence-"));
    mkdirSync(join(dir, "development-vessel", "src"), { recursive: true });
    const src = Array.from({ length: 300 }, (_, i) => (i === 9 ? "function redispatchParked() {}" : `const filler${i + 1} = ${i + 1};`)).join("\n");
    writeFileSync(join(dir, "development-vessel", "src", "drain.ts"), src);
    process.env["MITOSIS_RUNTIME_DIR"] = dir;
    const gap = { id: "g", summary: "redispatchParked double-counts in-flight gaps (~l.257-264)", classification_metadata: { edit_site: "repos/development-vessel/src/drain.ts" } };
    const spec = specFromGap(gap, [{ file: "repos/development-vessel/src/drain.ts", description: "" }]);
    expect(spec).toContain("excerpt_start_line=243");
    expect(spec).toContain("const filler257 = 257;");
  });
});

describe("Expected/Received come from the gap's own check, not the full suite", () => {
  it("parses the own run's Expected/Received per failing test, restricted to the gap's named tests", () => {
    const f = parseOwnCheckFailures(OWN_RAW, ["redispatches the parked gap", "carries the record"]);
    expect(f.map((x) => x.name)).toEqual(["drain > redispatches the parked gap", "drain > carries the record"]);
    expect(f[0]!.expected).toBe("Expected: 3");
    expect(f[0]!.received).toBe("Received: 2");
    expect(f[1]!.diff).toContain('-   "b": "y",');
    expect(f[1]!.diff).toContain('+   "b": "x",');
  });

  it("the lesson record and reason carry the own check's lines; another gap's (fail) in the full suite is ignored", () => {
    const own = parseOwnCheckFailures(OWN_RAW, ["redispatches the parked gap"]);
    const v: VerifyResult = { vessel: "development-vessel", errors: "verify", exit_code: 0, ok: false, output: VERIFY_LOG_TC0, stage: "own_check", own: { test_file: "test/own.test.ts", failing: own, no_effect_vs_parent: true, parent_cached: "hit" } };
    const { record, ownReason } = composeAttemptEvidence([{ ok: true, base_span: spanRecord(FILE, BASE, 5, 6) }], [], [v], false, null);
    expect(ownReason).toContain("Expected: 3");
    expect(ownReason).toContain("Received: 2");
    expect(ownReason).not.toContain("in-flight counting");
    expect(ownReason).not.toContain("Received: 7");
    expect(record.stage).toBe("own_check");
    expect(record.no_effect_vs_parent).toBe(true);
    expect(record.parent_cached).toBe("hit");
    expect(record.edited_spans.map((s) => [s.start, s.end])).toEqual([[5, 6]]);
    expect(JSON.stringify(record.own_check)).not.toContain("in-flight counting");
  });

  it("an unchanged parent failure reads as no effect; a different Received does not", () => {
    const draft = parseOwnCheckFailures(OWN_RAW, ["redispatches the parked gap"]);
    expect(sameOwnCheckFailures(draft, parseOwnCheckFailures(OWN_RAW, ["redispatches the parked gap"]))).toBe(true);
    expect(sameOwnCheckFailures(draft, parseOwnCheckFailures(OWN_RAW.replace("Received: 2", "Received: 5"), ["redispatches the parked gap"]))).toBe(false);
  });
});

describe("the lesson class comes from the failing stage", () => {
  it("a TC_EXIT=0 run whose tests section names TS2304 in a passing test is not classed typecheck", () => {
    expect(VERIFY_LOG_TC0).toContain("(pass) drain > keeps TS2304 baseline stays delta-excused");
    expect(composeLessonClass(null, null, [{ ok: true }], [{ ok: false, output: VERIFY_LOG_TC0 }], "")).toBe("verify_failed");
  });

  it("a TS2304 inside a failed typecheck section is still classed typecheck", () => {
    const log = "== install ==\n== resolve ==\nDRYRUN_EXIT=0\n== typecheck ==\nsrc/x.ts(3,1): error TS2304: Cannot find name 'q'.\nTC_EXIT=2\n== shape-dispatch ==\nSKIPPED_TYPECHECK_FAILED\n== tests ==\nSKIPPED_TYPECHECK_FAILED";
    expect(composeLessonClass(null, null, [{ ok: true }], [{ ok: false, output: log }], "")).toBe("typecheck_dangling_reference");
  });

  it("a readable scope withhold is scope_refused, not the semantic_reject fallthrough", () => {
    expect(composeLessonClass(null, null, [{ ok: true }], [{ ok: true, output: "TC_EXIT=0" }], "", true)).toBe("scope_refused");
    expect(composeLessonClass(null, null, [{ ok: true }], [{ ok: true, output: "TC_EXIT=0" }], "", false)).toBe("semantic_reject");
  });
});

describe("the store is read before the prompt", () => {
  const storeRow = { id: "gap-drain", status: "open", summary: "drain miscounts (~l.249-264)", classification_metadata: { edit_site: FILE, evidence_resolve: { shape: "test_suite", input: { vessel: "development-vessel", test_file: "test/own.test.ts" } }, failure_lessons: [noEffectLesson(120, 130)] } };

  it("an edit-intent caller carrying only {edit_site} gets the store's lessons, Expected/Received and refused regions in the prompt block", async () => {
    const reads: string[] = [];
    const readGap: GapRowReader = async (id) => { reads.push(id); return id === "gap-drain" ? [storeRow] : []; };
    const h = await hydrateComposeGap({ id: "gap-drain", classification_metadata: { edit_site: FILE } }, readGap);
    expect(reads).toEqual(["gap-drain"]);
    expect(h.source).toBe("store");
    expect(h.summary).toContain("~l.249-264");
    const prompt = priorAttemptFeedbackBlock(h.meta);
    expect(prompt).toContain("PRIOR ATTEMPT RECORD");
    expect(prompt).toContain("(fail) drain > redispatches the parked gap");
    expect(prompt).toContain("Expected: 3");
    expect(prompt).toContain("Received: 2");
    expect(prompt).toContain(`REFUSED REGIONS (an edit op overlapping one of these is refused before it is written): ${FILE}:120-130`);
    // The caller's copy alone carries none of it.
    expect(priorAttemptFeedbackBlock({ edit_site: FILE })).toBe("");
  });

  it("an unreadable store is said, not read as an empty gap", async () => {
    const h = await hydrateComposeGap({ id: "gap-drain", classification_metadata: { edit_site: FILE } }, async () => { throw new Error("503"); });
    expect(h.source).toBe("store_unreadable");
  });
});

describe("decomposed steps carry the parent's check", () => {
  it("a step resolves its parent's check fields and failing lines by parent_gap_id", async () => {
    const parent = { id: "gap-drain", status: "open", classification_metadata: { evidence_resolve: { shape: "test_suite", input: { vessel: "development-vessel", test_file: "test/own.test.ts", only_tests: ["redispatches the parked gap"] } }, failure_lessons: [noEffectLesson(120, 130)] } };
    const step = { id: "gap-drain-step-1", status: "open", classification_metadata: { edit_site: FILE, parent_gap_id: "gap-drain", expected_literal: "inFlightByGap", literal_reader: "redispatch" } };
    const rows: Record<string, unknown[]> = { "gap-drain": [parent], "gap-drain-step-1": [step] };
    const h = await hydrateComposeGap({ id: "gap-drain-step-1" }, async (id) => (rows[id] ?? []) as Array<Record<string, unknown>>);
    expect(h.parent_check?.gap_id).toBe("gap-drain");
    expect(h.parent_check?.check.evidence_resolve).toEqual(parent.classification_metadata.evidence_resolve);
    const line = parentCheckBlock(h.parent_check);
    expect(line).toContain("parent gap gap-drain");
    expect(line).toContain("test/own.test.ts");
    expect(line).toContain("Expected: 3");
    // The step's own check is untouched: the parent's is carried beside it, not in place of it.
    expect(h.meta.expected_literal).toBe("inFlightByGap");
    expect(h.meta.evidence_resolve).toBeUndefined();
  });
});

describe("a recommit child inherits its source's no-effect regions", () => {
  it("a child linked by source_gap_id is refused its source's no-effect span; a decomposed step is not", async () => {
    const source = { id: "gap-drain", status: "open", classification_metadata: { edit_site: FILE, failure_lessons: [noEffectLesson(120, 130)] } };
    const recommit = { id: "recommit-gap-drain-verify_failed", status: "open", classification_metadata: { re_commit: true, source_gap_id: "gap-drain", edit_site: FILE } };
    const step = { id: "gap-drain-step-1", status: "open", classification_metadata: { parent_gap_id: "gap-drain", predicate_source: "decompose", edit_site: FILE } };
    const rows: Record<string, unknown[]> = { "gap-drain": [source], [recommit.id]: [recommit], [step.id]: [step] };
    const read: GapRowReader = async (id) => (rows[id] ?? []) as Array<Record<string, unknown>>;
    const rc = await hydrateComposeGap({ id: recommit.id }, read);
    expect(noEffectOverlapRefusal(FILE, BASE, { start: 125, end: 125 }, enforcedLessons(rc))).toContain("NO-EFFECT REGION REFUSED");
    const st = await hydrateComposeGap({ id: step.id }, read);
    expect(st.lineage_lessons).toEqual([]);
    expect(noEffectOverlapRefusal(FILE, BASE, { start: 125, end: 125 }, enforcedLessons(st))).toBeNull();
  });
});

describe("the standing measurement", () => {
  it("counts a retry overlapping a no-effect span and a class that contradicts its stage; ignores lessons before the window", () => {
    const retry = { at: "2026-09-30T21:00:00.000Z", class: "typecheck_dangling_reference", stage: "own_check", edited_spans: [spanRecord(FILE, BASE, 125, 125)] };
    const m = measureRetryEvidence([{ id: "gap-drain", classification_metadata: { failure_lessons: [noEffectLesson(120, 130), retry] } }]);
    expect(m.retries_with_spans).toBe(1);
    expect(m.retries_overlapping_no_effect).toBe(1);
    expect(m.lessons_with_stage).toBe(2);
    expect(m.lessons_class_matching_stage).toBe(1);
    const late = measureRetryEvidence([{ id: "gap-drain", classification_metadata: { failure_lessons: [noEffectLesson(120, 130), retry] } }], Date.parse("2026-09-30T22:00:00.000Z"));
    expect(late.retries_with_spans).toBe(0);
    const clean = measureRetryEvidence([{ id: "g", classification_metadata: { failure_lessons: [noEffectLesson(120, 130), { ...retry, class: "verify_failed", edited_spans: [spanRecord(FILE, BASE, 200, 201)] }] } }]);
    expect(clean.retries_overlapping_no_effect).toBe(0);
    expect(clean.lessons_class_matching_stage).toBe(clean.lessons_with_stage);
  });
});

describe("the one per-op gate", () => {
  it("checkOpNoEffect refuses an edit op and a replace_lines op over a locked region, and returns the region it hit", () => {
    const lessons = [noEffectLesson(120, 130)];
    const edit = checkOpNoEffect({ path: FILE, kind: "edit", old_string: "const line128 = 128;" }, BASE, lessons);
    expect(edit?.detail).toContain("NO-EFFECT REGION REFUSED");
    expect([edit?.region_start, edit?.region_end, edit?.start, edit?.end]).toEqual([120, 130, 128, 128]);
    expect(edit?.region_sha).toBe(spanRecord(FILE, BASE, 120, 130).text_sha);
    expect(checkOpNoEffect({ path: FILE, kind: "replace_lines", start_line: 110, end_line: 121 }, BASE, lessons)).not.toBeNull();
  });

  it("checkOpNoEffect allows a disjoint op, an op on another file, and any op when no lock exists", () => {
    const lessons = [noEffectLesson(120, 130)];
    expect(checkOpNoEffect({ path: FILE, kind: "edit", old_string: "const line131 = 131;" }, BASE, lessons)).toBeNull();
    expect(checkOpNoEffect({ path: "repos/development-vessel/src/other.ts", kind: "replace_lines", start_line: 125, end_line: 125 }, BASE, lessons)).toBeNull();
    expect(checkOpNoEffect({ path: FILE, kind: "edit", old_string: "const line125 = 125;" }, BASE, [])).toBeNull();
  });
});

describe("a lock is scoped to its region's text", () => {
  it("lifts when a commit edits the region", () => {
    const lock = spanRecord(FILE, BASE, 120, 130);
    const edited = BASE.replace("const line125 = 125;", "const line125 = 999;");
    expect(locateSpan(lock, edited)).toBeNull();
    expect(checkOpNoEffect({ path: FILE, kind: "edit", old_string: "const line126 = 126;" }, edited, [noEffectLesson(120, 130)])).toBeNull();
  });

  it("follows unique text that moved, but an edited region whose text also exists elsewhere lifts instead of relocating", () => {
    const moved = "// a\n// b\n" + BASE;
    expect(locateSpan(spanRecord(FILE, BASE, 120, 130), moved)).toEqual({ start: 122, end: 132 });
    const dupBase = BASE + "\nconst line120 = 120;";
    const dupLock = spanRecord(FILE, dupBase, 120, 120);
    expect(dupLock.unique).toBe(false);
    const dupEdited = dupBase.replace("const line120 = 120;\nconst line121", "const line120 = 0;\nconst line121");
    expect(locateSpan(dupLock, dupEdited)).toBeNull();
  });
});

describe("a repeated refusal escalates; it never loops silently", () => {
  const lock = spanRecord(FILE, BASE, 120, 130);
  const refusal: RefusalRecord = { path: FILE, start: 125, end: 125, region_sha: lock.text_sha, region_start: 120, region_end: 130 };

  it("the first refusal of a region does not escalate; the second calls the existing escalation and is recorded", async () => {
    const calls: string[] = [];
    const escalate = async (g: Record<string, unknown>, why: string) => { calls.push(`${String(g.id)}|${why}`); return "dispatched: decomposition, then investigation"; };
    expect(repeatedRefusalRegion([], [refusal])).toBeNull();
    expect(await escalateRepeatedRefusal({ id: "gap-drain" }, [], [refusal], escalate)).toBeUndefined();
    expect(calls).toEqual([]);
    const prior = [{ class: "no_effect_region", stage: "apply", edited_spans: [], refusals: [refusal] }];
    const e = await escalateRepeatedRefusal({ id: "gap-drain" }, prior, [refusal], escalate);
    expect(calls).toEqual([`gap-drain|no-effect region ${lock.text_sha} refused again`]);
    expect(e?.region).toBe(lock.text_sha);
    expect(e?.outcome).toBe("dispatched: decomposition, then investigation");
  });

  it("escalates once per region: a 3rd refusal on an already-escalated region does not escalate again", async () => {
    let calls = 0;
    const escalate = async () => { calls++; return "dispatched: decomposition, then investigation"; };
    const prior = [
      { class: "no_effect_region", stage: "apply", edited_spans: [], refusals: [refusal] },
      { class: "no_effect_region", stage: "apply", edited_spans: [], refusals: [refusal], escalation: { at: "2026-09-30T21:00:00.000Z", region: lock.text_sha, outcome: "dispatched: decomposition, then investigation" } },
    ];
    expect(await escalateRepeatedRefusal({ id: "gap-drain" }, prior, [refusal], escalate)).toBeUndefined();
    expect(calls).toBe(0);
    // A different region on the same gap still escalates on its own repeat.
    const other = spanRecord(FILE, BASE, 300, 310);
    const ref2: RefusalRecord = { path: FILE, start: 305, end: 305, region_sha: other.text_sha, region_start: 300, region_end: 310 };
    expect((await escalateRepeatedRefusal({ id: "gap-drain" }, [...prior, { class: "no_effect_region", refusals: [ref2] }], [ref2], escalate))?.region).toBe(other.text_sha);
    expect(calls).toBe(1);
  });

  it("a held escalation is recorded with its reason, not dropped", async () => {
    const e = await escalateRepeatedRefusal({ id: "gap-drain" }, [], [refusal, refusal], async () => "not dispatched: autonomous_pick lease held by op");
    expect(e?.outcome).toBe("not dispatched: autonomous_pick lease held by op");
  });
});

describe("the standing measurement, extended", () => {
  it("counts gaps stuck on refusals, and whether each was escalated", () => {
    const lock = spanRecord(FILE, BASE, 120, 130);
    const ref: RefusalRecord = { path: FILE, start: 125, end: 125, region_sha: lock.text_sha, region_start: 120, region_end: 130 };
    const stuck = { id: "a", classification_metadata: { failure_lessons: [{ class: "no_effect_region", stage: "apply", refusals: [ref] }, { class: "no_effect_region", stage: "apply", refusals: [ref] }] } };
    const handled = { id: "b", classification_metadata: { failure_lessons: [{ class: "no_effect_region", stage: "apply", refusals: [ref] }, { class: "no_effect_region", stage: "apply", refusals: [ref], escalation: { at: "x", region: lock.text_sha, outcome: "dispatched" } }] } };
    const once = { id: "c", classification_metadata: { failure_lessons: [{ class: "no_effect_region", stage: "apply", refusals: [ref] }] } };
    const m = measureRetryEvidence([stuck, handled, once]);
    expect(m.gaps_stuck_on_refusals).toBe(2);
    expect(m.gaps_stuck_unescalated).toBe(1);
  });

  it("gate call sites count only calls whose result is branched on", () => {
    const src = ["const a = checkOpNoEffect(op, b, l);", "if (a) return;", "const c = x ? checkOpNoEffect(op, b, l) : null;", "let r = c", "  ? 1 : 2;", "const d = checkOpNoEffect(op, b, l);", "write(d?.detail ?? \"\");"].join("\n");
    expect(gateCallSites(src)).toEqual({ calls: 3, consumed: 2, unconsumed_lines: [6] });
  });
});

describe("journaled refusals must be stored", () => {
  const lock = spanRecord(FILE, BASE, 120, 130);
  const ref: RefusalRecord = { path: FILE, start: 125, end: 125, region_sha: lock.text_sha, region_start: 120, region_end: 130 };
  const now = new Date().toISOString();
  it("counts compose's own journal lines per gap and flags a gap with more journaled than stored refusals", () => {
    const line = refusalJournalLine("op", "gap-a", "NO-EFFECT REGION REFUSED: x");
    expect(new RegExp(REFUSAL_JOURNAL_GREP).test(line)).toBe(true);
    expect(new RegExp(REFUSAL_JOURNAL_GREP).test("[fc-no-effect] ESCALATION gap=gap-a region=r: refused on this gap before")).toBe(false);
    const j = refusalJournalCounts([line, line, refusalJournalLine("fc-repair edit", "gap-b", "NO-EFFECT REGION REFUSED: y")]);
    const stored = storedRefusalCounts([
      { id: "gap-a", classification_metadata: { failure_lessons: [{ at: now, class: "no_effect_region", refusals: [ref] }] } },
      { id: "gap-b", classification_metadata: { failure_lessons: [{ at: now, class: "no_effect_region", refusals: [ref] }] } },
    ], Date.now() - 3600_000);
    expect(refusalsNotRecorded(j, stored)).toEqual({ gaps: ["gap-a"], unjudged: 0 });
  });
  it("a gap whose lesson list is full is not judged (eviction may have removed its refusals)", () => {
    const full = Array.from({ length: 8 }, () => ({ at: now, class: "verify_failed" }));
    const stored = storedRefusalCounts([{ id: "gap-a", classification_metadata: { failure_lessons: full } }], Date.now() - 3600_000);
    expect(refusalsNotRecorded(new Map([["gap-a", 3]]), stored)).toEqual({ gaps: [], unjudged: 1 });
  });
});

describe("the retry_evidence row in self_fact_reconcile (rows are data, read from origin/dev)", () => {
  const keep = { sr: process.env["SUPER_REPO_ROOT"], pe: process.env["PROFILE_EFFECTIVE"], pc: process.env["MITOSIS_PUSH_CLONE_DIR"] };
  const dirs: string[] = [];
  // The store path substrate-gap froze at its first import (another suite may have won that race); restored after.
  let gapsFile = "";
  let gapsBefore: string | null = null;
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
    if (gapsFile) { if (gapsBefore === null) rmSync(gapsFile, { force: true }); else writeFileSync(gapsFile, gapsBefore); }
    gapsFile = ""; gapsBefore = null;
    for (const [k, v] of [["SUPER_REPO_ROOT", keep.sr], ["PROFILE_EFFECTIVE", keep.pe], ["MITOSIS_PUSH_CLONE_DIR", keep.pc]] as const) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  });
  const gitIn = (cwd: string, args: string[]) => { const p = Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd }); if (p.exitCode !== 0) throw new Error(new TextDecoder().decode(p.stderr)); };
  const repoWith = (files: Record<string, string>): string => {
    const d = mkdtempSync(join(tmpdir(), "re-row-"));
    dirs.push(d);
    for (const [f, c] of Object.entries(files)) { mkdirSync(join(d, f, ".."), { recursive: true }); writeFileSync(join(d, f), c); }
    gitIn(d, ["init", "-q"]); gitIn(d, ["add", "-A"]); gitIn(d, ["commit", "-qm", "x"]); gitIn(d, ["update-ref", "refs/remotes/origin/dev", "HEAD"]);
    return d;
  };
  // The push clone's origin/dev holds THIS tree's feature-compose.ts, so a mutation of the gate's call sites in the
  // working tree flows through the instrument exactly as a landed commit would.
  let journalLines: string[] = [];
  const run = async (gaps: unknown[] = []) => {
    process.env["SUPER_REPO_ROOT"] = repoWith({ "scripts/substrate/self-facts.json": JSON.stringify({ rows: [{ id: "retry_evidence", instrument: "retry_evidence", profiles: ["standalone", "hub"], edit_site: "repos/development-vessel/src/resolvers/feature-compose.ts", must_fail: "see row", window_hours: 24, repo: "development-vessel", site_file: "src/resolvers/feature-compose.ts", min_sites: 4 }] }) });
    const clones = mkdtempSync(join(tmpdir(), "re-clones-"));
    dirs.push(clones);
    const fc = await Bun.file(new URL("../../src/resolvers/feature-compose.ts", import.meta.url)).text();
    const dv = repoWith({ "src/resolvers/feature-compose.ts": fc });
    Bun.spawnSync(["mv", dv, join(clones, "development-vessel")]);
    process.env["MITOSIS_PUSH_CLONE_DIR"] = clones;
    process.env["PROFILE_EFFECTIVE"] = "standalone";
    const { gapStoreRootForTest } = await import("../../src/resolvers/substrate-gap.js");
    const root = gapStoreRootForTest();
    // Never write a store outside a temp dir: a real store must not receive test rows.
    if (!root.startsWith(tmpdir()) && !root.startsWith("/tmp/")) throw new Error(`gap store root ${root} is not a temp dir; refusing to write test rows`);
    gapsFile = join(root, "gaps", "gaps.json");
    try { gapsBefore = readFileSync(gapsFile, "utf8"); } catch { gapsBefore = null; }
    mkdirSync(join(gapsFile, ".."), { recursive: true });
    writeFileSync(gapsFile, JSON.stringify(gaps));
    const sfr = await import("../../src/resolvers/self-fact-reconcile.js");
    const realRead = sfr.journal.read;
    sfr.journal.read = async () => ({ lines: journalLines });
    try {
      return (await sfr.resolveSelfFactReconcile({ type: "self_fact_reconcile", facts: ["retry_evidence"], file_gaps: false })).body as Record<string, unknown>;
    } finally { sfr.journal.read = realRead; journalLines = []; }
  };

  it("observes, finds its canary, counts every gate call site, and reports no enforcement divergence on this tree", async () => {
    const body = await run();
    expect(body.canary_found).toBe(true);
    expect(body.observed).toBe(true);
    const keys = (body.divergences as Array<{ key: string }>).map((d) => d.key);
    expect(keys).not.toContain("enforcement-not-refusing");
    expect(keys).not.toContain("gate-call-sites");
  });

  it("reports refusals-not-recorded when compose journaled a refusal the gap's lessons do not hold", async () => {
    const now = new Date().toISOString();
    journalLines = [refusalJournalLine("op", "g2", "NO-EFFECT REGION REFUSED: x")];
    const body = await run([{ id: "g2", status: "open", category: "x", summary: "s", detected_at: now, classification_metadata: { failure_lessons: [{ at: now, class: "verify_failed", stage: "own_check", edited_spans: [spanRecord(FILE, BASE, 1, 2)] }] } }]);
    expect(body.observed).toBe(true);
    expect((body.divergences as Array<{ key: string }>).map((d) => d.key)).toContain("refusals-not-recorded");
  });

  it("reads UNOBSERVED, not healthy, when retries got past apply but no edited spans were recorded", async () => {
    const now = new Date().toISOString();
    const body = await run([{ id: "g1", status: "open", category: "x", summary: "s", detected_at: now, classification_metadata: { failure_lessons: [{ at: now, class: "verify_failed", stage: "own_check", edited_spans: [] }, { at: now, class: "verify_failed", stage: "own_check", edited_spans: [] }] } }]);
    expect(body.observed).toBe(false);
    expect(body.divergence_count).toBeNull();
    expect(JSON.stringify(body.facts_checked)).toContain("UNOBSERVED");
  });
});
