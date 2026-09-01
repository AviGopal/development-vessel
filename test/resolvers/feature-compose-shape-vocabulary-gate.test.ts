import { describe, it, expect } from "bun:test";
import {
  detectUnadvertisedShapeLiteral,
  loadFleetShapeVocabulary,
  unadvertisedShapeRefusalReason,
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

  it("flags NOTHING when the committed tree's own predicate site is fed in as if wholly added", () => {
    // The corpus check, pinned. Uses the REAL fleet vocabulary if this host has one;
    // when it does not, the fail-open rule applies and the expectation is the same.
    const real = loadFleetShapeVocabulary();
    const text = [
      "              evidence_resolve: {",
      '                shape: "trace_failure_pattern_report",',
      "                input: { template_id: p.template_id },",
      '                nonzero_field: "occurrence_count"',
      "              },",
    ];
    expect(detectUnadvertisedShapeLiteral(diffOf(text), real)).toEqual([]);
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
