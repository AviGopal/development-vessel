import { describe, it, expect } from "bun:test";
import {
  detectUnadvertisedShapeLiteral,
  loadFleetShapeVocabulary,
  unadvertisedShapeRefusalReason,
  shapeVocabularyRefusal,
} from "../../src/resolvers/feature-compose";

// The EXECUTING shape-vocabulary gate (2026-09-01). Every other compose gate READS the
// diff; this one RESOLVES a name against the advertised vocabulary. It exists because the
// substrate authored `evidence_resolve: { shape: <the resolver's own internal return-shape
// name> }` and landed it twice (05458f4, 6b6068e) through typecheck, the semantic gate, two
// adversarial refuters and the mitosis FAVORABLE verdict — a string literal typechecks no
// matter what it says, so only resolving it can tell a correct name from a plausible one.
//
// These tests pin, in order: the exact failing case, the corrected case, the untouched
// case, the pre-existing-content carve-out, the fail-open rule, and the two log lines.

// A vocabulary that is plausible enough for the gate to agree to judge at all
// (configs_read >= 5 and >= 50 names) — see the fail-open rule in the gate.
const REAL_SHAPES = ["trace_failure_pattern_report", "substrateGap", "activity_template", "concept"];
const vocab = (extra: string[] = []): { shapes: Set<string>; configs_read: number } => ({
  shapes: new Set([
    ...REAL_SHAPES,
    ...extra,
    ...Array.from({ length: 60 }, (_, i) => `filler_shape_${i}`),
  ]),
  configs_read: 9,
});

const diffOf = (addedLines: string[], contextLines: string[] = []): string =>
  [
    "--- a/repos/development-vessel/src/resolvers/trace-failure-pattern-report.ts",
    "+++ b/repos/development-vessel/src/resolvers/trace-failure-pattern-report.ts",
    "@@ -190,3 +190,12 @@",
    ...contextLines.map((l) => " " + l),
    ...addedLines.map((l) => "+" + l),
  ].join("\n");

// Captures console.log for the duration of fn. The gate MUST speak on both outcomes —
// a silent confirming case is indistinguishable from a gate that never ran.
const withCapturedLog = <T>(fn: () => T): { result: T; logs: string[] } => {
  const logs: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]): void => { logs.push(args.map(String).join(" ")); };
  try {
    return { result: fn(), logs };
  } finally {
    console.log = original;
  }
};

describe("detectUnadvertisedShapeLiteral — the measured defect", () => {
  it("REFUSES a diff that adds an unadvertised shape in evidence_resolve (the exact 05458f4/6b6068e case)", () => {
    const f = detectUnadvertisedShapeLiteral(
      diffOf([
        "              evidence_resolve: {",
        '                shape: "failurePatternReport",',
        "                input: { template_id: p.template_id },",
        '                nonzero_field: "occurrence_count"',
        "              },",
      ]),
      vocab(),
    );
    expect(f.length).toBe(1);
    expect(f[0]!.shape).toBe("failurePatternReport");
    expect(f[0]!.position).toBe("evidence_resolve.shape");
    // The refusal reason is persisted onto the gap and re-injected into the next draft,
    // so it has to NAME the bad value — the drafter guessed twice for want of feedback.
    expect(unadvertisedShapeRefusalReason(f)).toContain("failurePatternReport");
    expect(unadvertisedShapeRefusalReason(f)).toContain("discovery.shapes");
  });

  it("PASSES the corrected diff naming the ADVERTISED shape", () => {
    const f = detectUnadvertisedShapeLiteral(
      diffOf([
        "              evidence_resolve: {",
        '                shape: "trace_failure_pattern_report",',
        "                input: { template_id: p.template_id },",
        '                nonzero_field: "occurrence_count"',
        "              },",
      ]),
      vocab(),
    );
    expect(f).toEqual([]);
  });

  it("REFUSES the verify_shape string shorthand when the name is unadvertised, and PASSES when it is", () => {
    const bad = detectUnadvertisedShapeLiteral(diffOf(['  verify_shape: "failurePatternReport",']), vocab());
    expect(bad.length).toBe(1);
    expect(bad[0]!.position).toBe("verify_shape");
    const good = detectUnadvertisedShapeLiteral(diffOf(['  verify_shape: "trace_failure_pattern_report",']), vocab());
    expect(good).toEqual([]);
  });
});

describe("detectUnadvertisedShapeLiteral — no false positives", () => {
  it("passes a diff that adds no shape literal at all, untouched", () => {
    const f = detectUnadvertisedShapeLiteral(
      diffOf(["  const seen = new Set<string>();", "  for (const x of items) seen.add(x.id);"]),
      vocab(),
    );
    expect(f).toEqual([]);
  });

  it("does NOT judge a pre-existing unadvertised name that the diff merely has as CONTEXT", () => {
    // The target files run to thousands of lines. Failing a compose for content it did not
    // introduce would make every edit to a large file un-landable.
    const f = detectUnadvertisedShapeLiteral(
      diffOf(
        ["                nonzero_field: \"occurrence_count\","],
        ["              evidence_resolve: {", '                shape: "somePreExistingName",'],
      ),
      vocab(),
    );
    expect(f).toEqual([]);
  });

  it("does NOT let an UNCHANGED context opener judge an added shape: in a different object", () => {
    // Review finding 2, reproduced against the production vocabulary. The first cut let a
    // pre-existing `evidence_resolve:` context line open the window, so ANY edit landing a
    // couple of lines below an existing predicate — in an entirely unrelated object — was
    // judged. Both the opener AND the key must now be added lines.
    const f = detectUnadvertisedShapeLiteral(
      diffOf(
        ["  const other = {", '    shape: "myInternalReturnShape",', "  };"],
        ["              evidence_resolve: {", '                shape: "trace_failure_pattern_report",', "              },"],
      ),
      vocab(),
    );
    expect(f).toEqual([]);
  });

  it("does NOT flag a shape name that appears only in an added COMMENT", () => {
    // The corrected predicate site and the gate itself both name the bad shape in prose to
    // explain the defect. A gate that flagged its own documentation refutes itself.
    const f = detectUnadvertisedShapeLiteral(
      diffOf([
        "              // WHY: the drafter wrote shape: \"failurePatternReport\" here, which is the",
        "              // resolver's internal return-shape name and is not advertised anywhere.",
        "              evidence_resolve: {",
        '                shape: "trace_failure_pattern_report",',
        "              },",
      ]),
      vocab(),
    );
    expect(f).toEqual([]);
  });

  it("does NOT let an opener's window leak across a file/hunk boundary", () => {
    // The caller concatenates one diff per edited file into a single string. An opener in
    // the last lines of file A's hunk must not judge an unrelated `shape:` in file B.
    const multiFile = [
      "### /vessels/development-vessel/src/resolvers/a.ts",
      "--- a/repos/development-vessel/src/resolvers/a.ts",
      "+++ b/repos/development-vessel/src/resolvers/a.ts",
      "@@ -1,1 +1,3 @@",
      "+              evidence_resolve: {",
      '+                shape: "trace_failure_pattern_report",',
      "+              },",
      "",
      "### /vessels/development-vessel/src/resolvers/b.ts",
      "--- a/repos/development-vessel/src/resolvers/b.ts",
      "+++ b/repos/development-vessel/src/resolvers/b.ts",
      "@@ -1,1 +1,2 @@",
      '+  return { shape: "someInternalReturnShape", body };',
    ].join("\n");
    expect(detectUnadvertisedShapeLiteral(multiFile, vocab())).toEqual([]);
  });

  it("does NOT flag a `shape:` literal that is not under an evidence_resolve/verify_shape opener", () => {
    // Scope is deliberately the two positions that are DEFINITIONALLY resolved through
    // discovery later. Every other string in a diff is not this gate's business.
    const f = detectUnadvertisedShapeLiteral(
      diffOf(['  const impulse = { shape: "someInternalReturnShape", body };']),
      vocab(),
    );
    expect(f).toEqual([]);
  });

  // HONEST TITLE (was "flags NOTHING when the committed tree's ... is fed in as if wholly
  // added", which on a host with no fleet layout only ever exercised the FAIL-OPEN branch —
  // configs_read=0 — while reading as a corpus check. Review called it vacuous; it was.)
  // The real corpus check is not expressible as a unit test, because it needs the fleet's
  // config.ts files on disk. It is run against the live container instead; see the commit
  // message. What IS pinned here: the real loader, and — only where the layout exists —
  // that the real vocabulary genuinely discriminates.
  it("uses the REAL loader: where a fleet layout exists it discriminates; where it does not it fails open", () => {
    // `${import.meta.dir}/../../..` is repos/ in a checkout; absent elsewhere.
    const real = loadFleetShapeVocabulary([`${import.meta.dir}/../../..`]);
    const good = diffOf(["  evidence_resolve: {", '    shape: "trace_failure_pattern_report",', "  },"]);
    const bad = diffOf(["  evidence_resolve: {", '    shape: "failurePatternReport",', "  },"]);
    expect(detectUnadvertisedShapeLiteral(good, real)).toEqual([]);
    if (real.configs_read >= 5 && real.shapes.size >= 50) {
      // The layout is present, so this assertion is real: the advertised name is in the
      // vocabulary and the internal return-shape name is not.
      expect(real.shapes.has("trace_failure_pattern_report")).toBe(true);
      expect(real.shapes.has("failurePatternReport")).toBe(false);
      expect(detectUnadvertisedShapeLiteral(bad, real).map((f) => f.shape)).toEqual(["failurePatternReport"]);
    } else {
      // No layout → the gate must abstain, and say so.
      expect(detectUnadvertisedShapeLiteral(bad, real)).toEqual([]);
    }
  });
});

describe("detectUnadvertisedShapeLiteral — nested strings are not uses (review finding 1)", () => {
  // b5bed65 REFUSED ITS OWN DIFF on 4 findings, every one a shape name inside a nested
  // string literal on an added line — a test fixture, a doc example. Substrate-authored
  // cutovers demonstrably touch test/ (7 in the last 600 commits), so this was
  // production-reachable and would have halted a lane that lands ~2 changes/day.
  const nestedInSrc = [
    "### /vessels/development-vessel/src/resolvers/z.ts",
    "--- a/repos/development-vessel/src/resolvers/z.ts",
    "@@ -1,1 +1,4 @@",
    `+  const bad = detect(diffOf(['  verify_shape: ${'"'}failurePatternReport${'"'},']), vocab());`,
    `+  const also = { evidence_resolve: { note: 'shape: ${'"'}failurePatternReport${'"'}' } };`,
    '+  const impulse = { shape: "someInternalReturnShape", body };',
  ].join("\n");

  it("does NOT flag an opener or a shape key quoted inside another string — even in a SRC file", () => {
    // Deliberately a src path, so this proves the ANCHORING guard, not the test-file carve-out.
    expect(detectUnadvertisedShapeLiteral(nestedInSrc, vocab())).toEqual([]);
  });

  it("still REFUSES the same name when it is a real key at the start of its own line", () => {
    // The other half of the guard: anchoring must not have neutered the gate.
    const real = [
      "### /vessels/development-vessel/src/resolvers/w.ts",
      "--- a/repos/development-vessel/src/resolvers/w.ts",
      "@@ -1,1 +1,3 @@",
      "+            evidence_resolve: {",
      '+              shape: "failurePatternReport",',
      "+            },",
    ].join("\n");
    expect(detectUnadvertisedShapeLiteral(real, vocab()).map((f) => f.shape)).toEqual(["failurePatternReport"]);
  });

  it("REFUSES the one-line object form", () => {
    const oneLine = [
      "### /vessels/development-vessel/src/resolvers/v.ts",
      "--- a/repos/development-vessel/src/resolvers/v.ts",
      "@@ -1,1 +1,2 @@",
      '+  evidence_resolve: { shape: "failurePatternReport", nonzero_field: "occurrence_count" },',
    ].join("\n");
    expect(detectUnadvertisedShapeLiteral(oneLine, vocab()).map((f) => f.position)).toEqual(["evidence_resolve.shape"]);
  });
});

describe("detectUnadvertisedShapeLiteral — per-file test scoping (review finding 1a)", () => {
  const predicateIn = (path: string): string =>
    [`### /vessels/development-vessel/${path}`, `--- a/repos/development-vessel/${path}`, "@@ -1,1 +1,3 @@",
      "+  evidence_resolve: {", '+    shape: "failurePatternReport",', "+  },"].join("\n");

  it("does NOT judge a predicate inside a .test.ts file", () => {
    expect(detectUnadvertisedShapeLiteral(predicateIn("test/resolvers/q.test.ts"), vocab())).toEqual([]);
  });

  it("does NOT judge a .spec.tsx file either", () => {
    expect(detectUnadvertisedShapeLiteral(predicateIn("test/q.spec.tsx"), vocab())).toEqual([]);
  });

  it("STILL judges the src half of a change that mixes src and test", () => {
    // `changesAreTestOnly` is the wrong predicate: it requires EVERY path to be a test, and a
    // realistic change (b5bed65 itself) mixes the two. Scoping must be per file, both ways.
    const mixed = predicateIn("test/resolvers/q.test.ts") + "\n" + predicateIn("src/resolvers/q.ts");
    expect(detectUnadvertisedShapeLiteral(mixed, vocab()).map((f) => f.shape)).toEqual(["failurePatternReport"]);
  });

  it("keeps the file scope across the @@ hunk line", () => {
    // Regression pin. The first cut recomputed the scope on EVERY header-ish line, including
    // `@@ -1,1 +1,3 @@` — which names no file — so the scope was reset to false on the line
    // right after every header and invariant 4 was completely inert. The acceptance diff
    // still passed (on the anchoring guard alone), so only a negative control exposed it.
    expect(detectUnadvertisedShapeLiteral(predicateIn("test/resolvers/q.test.ts"), vocab())).toEqual([]);
  });
});

describe("detectUnadvertisedShapeLiteral — same-diff advertisement (review finding 3)", () => {
  it("PASSES a change that advertises a shape in config.ts and uses it in the SAME diff", () => {
    // An isolated compose edits a worktree under COMPOSE_WS_DIR that no fleet root scans, so
    // the vocabulary would be the ORIGIN view and a correct self-consistent change would be
    // refused for naming a shape that IS advertised by the time the sweep runs. Two defences:
    // the worktree roots threaded from `ws.rootFor(vessel)`, and — layout-independently —
    // harvesting the diff's own config.ts additions, which is what this pins.
    const sameDiff = [
      "### /vessels/development-vessel/src/config.ts",
      "--- a/repos/development-vessel/src/config.ts",
      "@@ -70,2 +70,3 @@",
      '     "learningMode",',
      '+    "brand_new_shape_advertised_here",',
      "",
      "### /vessels/development-vessel/src/resolvers/y.ts",
      "--- a/repos/development-vessel/src/resolvers/y.ts",
      "@@ -10,1 +10,4 @@",
      "+    evidence_resolve: {",
      '+      shape: "brand_new_shape_advertised_here",',
      "+    },",
    ].join("\n");
    expect(detectUnadvertisedShapeLiteral(sameDiff, vocab())).toEqual([]);
  });

  it("does NOT let a config.ts addition launder an unrelated unadvertised name", () => {
    const laundered = [
      "### /vessels/development-vessel/src/config.ts",
      "--- a/repos/development-vessel/src/config.ts",
      "@@ -70,1 +70,2 @@",
      '+    "some_other_new_shape",',
      "",
      "### /vessels/development-vessel/src/resolvers/y.ts",
      "--- a/repos/development-vessel/src/resolvers/y.ts",
      "@@ -10,1 +10,4 @@",
      "+    evidence_resolve: {",
      '+      shape: "failurePatternReport",',
      "+    },",
    ].join("\n");
    expect(detectUnadvertisedShapeLiteral(laundered, vocab()).map((f) => f.shape)).toEqual(["failurePatternReport"]);
  });
});

describe("shapeVocabularyRefusal — the REAL call site entry point", () => {
  // `resolveFeatureCompose` invokes exactly this function (`semantic_gate = shapeVocabularyRefusal(...)
  // ?? await verifyPatchAddressesGap(...)`), so these tests exercise the production path —
  // vocabulary load, fail-open rule, detector, and the SemanticGateVerdict the downstream
  // `!addresses` branch consumes — rather than a helper with an injected fixture.
  const badDiff = [
    "### /vessels/development-vessel/src/resolvers/w.ts",
    "--- a/repos/development-vessel/src/resolvers/w.ts",
    "@@ -1,1 +1,3 @@",
    "+  evidence_resolve: {",
    '+    shape: "failurePatternReport",',
    "+  },",
  ].join("\n");

  it("returns a hard-fail UNFAVORABLE verdict shaped for the existing semantic-gate plumbing", () => {
    const v = shapeVocabularyRefusal(badDiff, { vocabulary: vocab() });
    expect(v).not.toBeNull();
    expect(v!.addresses).toBe(false);          // this is what flips the verdict + rolls back
    expect(v!.on_live_path).toBe(true);        // not a reachability rejection
    expect(v!.hard_fail).toBe(true);
    expect(v!.llm_consulted).toBe(false);      // the judge call is skipped entirely
    expect(v!.verified).toBe(true);
    // The reason is persisted as `semantic_gate_reason` and re-injected into the next draft.
    expect(v!.reason).toContain("failurePatternReport");
    expect(v!.reason).toContain("discovery.shapes");
  });

  it("returns null (admit) for a clean diff", () => {
    const clean = badDiff.replace("failurePatternReport", "trace_failure_pattern_report");
    expect(shapeVocabularyRefusal(clean, { vocabulary: vocab() })).toBeNull();
  });

  it("returns null (admit) when the vocabulary cannot be evaluated", () => {
    expect(shapeVocabularyRefusal(badDiff, { vocabulary: { shapes: new Set(), configs_read: 0 } })).toBeNull();
  });

  it("returns null (admit) when it must load the vocabulary itself and the layout is absent", () => {
    // No injected vocabulary → the real loader runs. On a host without the fleet layout the
    // fail-open rule applies; on one with it, the diff is genuinely bad and would refuse.
    const v = shapeVocabularyRefusal(badDiff, { vesselRoots: ["/nonexistent-vessel-root"] });
    const real = loadFleetShapeVocabulary();
    if (real.configs_read < 5 || real.shapes.size < 50) expect(v).toBeNull();
    else expect(v).not.toBeNull();
  });
});

describe("detectUnadvertisedShapeLiteral — fail open", () => {
  const badCase = diffOf(['  verify_shape: "failurePatternReport",']);

  it("PASSES when the vocabulary cannot be read at all", () => {
    const { result, logs } = withCapturedLog(() =>
      detectUnadvertisedShapeLiteral(badCase, { shapes: new Set<string>(), configs_read: 0 }),
    );
    expect(result).toEqual([]);
    expect(logs.some((l) => l.includes("[fc-shape-vocab] FAIL-OPEN"))).toBe(true);
  });

  it("PASSES when the sibling-config scan did not demonstrably work (configs_read too low)", () => {
    const partial = { shapes: vocab().shapes, configs_read: 1 };
    expect(detectUnadvertisedShapeLiteral(badCase, partial)).toEqual([]);
  });

  it("PASSES when the vocabulary loaded but is implausibly small", () => {
    const tiny = { shapes: new Set(REAL_SHAPES), configs_read: 9 };
    expect(detectUnadvertisedShapeLiteral(badCase, tiny)).toEqual([]);
  });

  it("PASSES when the diff is garbage rather than a parseable unified diff", () => {
    expect(detectUnadvertisedShapeLiteral("  not a diff at all {{{", vocab())).toEqual([]);
    expect(detectUnadvertisedShapeLiteral("", vocab())).toEqual([]);
  });

  it("PASSES when the vocabulary object itself is malformed (throws inside the gate)", () => {
    const malformed = { shapes: null, configs_read: 9 } as unknown as { shapes: Set<string>; configs_read: number };
    expect(detectUnadvertisedShapeLiteral(badCase, malformed)).toEqual([]);
  });
});

describe("detectUnadvertisedShapeLiteral — both log lines fire", () => {
  it("logs a PASS line on the confirming case", () => {
    const { result, logs } = withCapturedLog(() =>
      detectUnadvertisedShapeLiteral(diffOf(['  verify_shape: "trace_failure_pattern_report",']), vocab()),
    );
    expect(result).toEqual([]);
    expect(logs.some((l) => l.startsWith("[fc-shape-vocab] PASS:"))).toBe(true);
  });

  it("logs a REFUSED line naming the shape on the refusing case", () => {
    const { result, logs } = withCapturedLog(() =>
      detectUnadvertisedShapeLiteral(diffOf(['  verify_shape: "failurePatternReport",']), vocab()),
    );
    expect(result.length).toBe(1);
    const refused = logs.find((l) => l.startsWith("[fc-shape-vocab] REFUSED:"));
    expect(refused).toBeDefined();
    expect(refused!).toContain("failurePatternReport");
  });
});

describe("loadFleetShapeVocabulary", () => {
  it("always contains this vessel's own advertised shapes and never throws on a missing root", () => {
    const v = loadFleetShapeVocabulary(["/nonexistent-root-for-this-test"]);
    expect(v.configs_read).toBe(0);
    expect(v.shapes.has("trace_failure_pattern_report")).toBe(true);
    // configs_read=0 means the sibling scan did not work → the gate must abstain.
    expect(detectUnadvertisedShapeLiteral(diffOf(['  verify_shape: "failurePatternReport",']), v)).toEqual([]);
  });
});

// ─── QUOTED AND EMBEDDED EXAMPLES (2026-09-01, adversarial re-review) ───────────────────
//
// The anchored patterns carried a leading `["'`]?` to admit a JSON-style quoted key. That
// same optional quote swallowed the OPENING QUOTE OF A STRING LITERAL, so a quoted EXAMPLE
// beginning its own trimmed line read as an anchored key. Five src-path reproductions were
// confirmed in-container against the production vocabulary — including two introduced by
// SAME_LINE_SHAPE, which did not exist before the previous fix.
//
// These are FALSE REFUSALS on a lane that lands ~2 changes/day, which is strictly worse
// than the hollow commit the gate exists to prevent. Every case below must PASS.
describe("shape gate — a quoted or embedded EXAMPLE is not code", () => {
  const V = vocab();

  it("KNOWN LIMIT: a template-literal example IS refused, and cannot be fixed by anchoring", () => {
    // NOT a passing behaviour — a pin on the one false-refusal this design cannot remove.
    // Interior lines of a template literal carry NO quote, so `evidence_resolve: {` at the
    // start of a trimmed line is byte-identical to code. Anchoring has no parsing state
    // (deliberately — quote-parity was rejected because every miscount fails toward a
    // FALSE REFUSAL), so it cannot tell a heredoc example from the real thing.
    //
    // Accepted because a whole-fleet scan finds exactly ONE anchored opener in non-test
    // src, a genuine use: zero instances of this class exist today. If one is ever
    // authored, this test names the cost and the reason, and the fix is a real parser
    // rather than a wider regex.
    const d = diffOf([
      "const LESSON = `",
      "Write the predicate like this:",
      "evidence_resolve: {",
      '  shape: "failurePatternReport",',
      "}",
      "`;",
    ]);
    expect(detectUnadvertisedShapeLiteral(d, V)).toHaveLength(1);
  });

  it("does not refuse a quoted array fixture", () => {
    expect(detectUnadvertisedShapeLiteral(diffOf([
      "const FIXTURE = [",
      "  'evidence_resolve: {',",
      "  '  shape: \"failurePatternReport\",',",
      "];",
    ]), V)).toEqual([]);
  });

  it("does not refuse a quoted ONE-LINE object — the SAME_LINE_SHAPE regression", () => {
    expect(detectUnadvertisedShapeLiteral(diffOf([
      "'evidence_resolve: { shape: \"failurePatternReport\" },',",
    ]), V)).toEqual([]);
  });

  it("does not refuse a quoted verify_shape shorthand", () => {
    expect(detectUnadvertisedShapeLiteral(diffOf([
      "'verify_shape: \"failurePatternReport\",',",
    ]), V)).toEqual([]);
  });

  it("STILL REFUSES the real thing — the fix must not buy safety with the gate's purpose", () => {
    // The negative control for this whole block. If dropping the leading optional-quote
    // also stopped catching a genuine bare-key predicate, the gate would be decorative.
    const f = detectUnadvertisedShapeLiteral(diffOf([
      "evidence_resolve: {",
      '  shape: "failurePatternReport",',
      "},",
    ]), V);
    expect(f).toHaveLength(1);
    expect(f[0]!.shape).toBe("failurePatternReport");
  });
});

// ─── HEADER COLLISION (2026-09-01, re-review findings 2 and 3) ──────────────────────────
//
// `startsWith("---")` also matches a REMOVED line whose own content begins "--" (a CLI
// flag, a SQL comment), and `startsWith("+++")` an ADDED line beginning "++". Both are
// ordinary content in the caller's `diff -u` output. The collision silently cleared the
// file-scope flags for the REST of the file, killing the same-diff config harvest and
// invariant 4 mid-stream — each in the false-refusal direction.
describe("shape gate — content lines that look like headers", () => {
  const V = vocab();
  const NEW = "brand_new_shape_xyz";

  const advertiseThenUse = (noise: string[]): string => [
    "--- a/repos/development-vessel/src/config.ts",
    "+++ b/repos/development-vessel/src/config.ts",
    "@@ -1,1 +1,3 @@",
    ...noise,
    `+      "${NEW}",`,
    "--- a/repos/development-vessel/src/resolvers/x.ts",
    "+++ b/repos/development-vessel/src/resolvers/x.ts",
    "@@ -1,1 +1,3 @@",
    "+            evidence_resolve: {",
    `+              shape: "${NEW}",`,
    "+            },",
  ].join("\n");

  it("harvests the same-diff advertisement despite a REMOVED line starting with --", () => {
    expect(detectUnadvertisedShapeLiteral(advertiseThenUse(["---dry-run flag removed"]), V)).toEqual([]);
  });

  it("harvests it despite an ADDED line starting with ++", () => {
    expect(detectUnadvertisedShapeLiteral(advertiseThenUse(["+++counter;"]), V)).toEqual([]);
  });

  it("keeps invariant 4 alive across a -- content line inside a test file", () => {
    expect(detectUnadvertisedShapeLiteral([
      "--- a/repos/development-vessel/test/resolvers/q.test.ts",
      "+++ b/repos/development-vessel/test/resolvers/q.test.ts",
      "@@ -1,1 +1,5 @@",
      "---legacy-peer-deps was removed",
      "+            evidence_resolve: {",
      '+              shape: "failurePatternReport",',
      "+            },",
    ].join("\n"), V)).toEqual([]);
  });

  it("still treats a REAL --- / +++ header pair as a header", () => {
    // The guard requires whitespace after the marker; a genuine header always has it.
    // If this broke, file attribution would collapse and invariant 4 would judge src.
    const f = detectUnadvertisedShapeLiteral([
      "--- a/repos/development-vessel/src/resolvers/x.ts",
      "+++ b/repos/development-vessel/src/resolvers/x.ts",
      "@@ -1,1 +1,3 @@",
      "+            evidence_resolve: {",
      '+              shape: "failurePatternReport",',
      "+            },",
    ].join("\n"), V);
    expect(f).toHaveLength(1);
  });
});
