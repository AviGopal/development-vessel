// THE CHECK REGION COMES FROM THE ROW'S STATED CAUSE, NOT FROM SUMMARY TOKENS (development-vessel:check-region-cause-anchor).
//
// A row whose summary names an incidental identifier (it was stopped by operator_hold) got the operator_hold statement
// as its check region, in the goal the drafter read and in both region gates, while the cause it states (its
// region_prior_text, a declared function) was read by none of them. The site below has the same structure as that
// row's edit site: the cause is a function declared once and called once (both declarations, so no token region), and
// the incidental token sits in one non-declaration statement.
//
//   [MUST-FAIL] under variant-1 the region is the cause's DECLARATION (its own return), in the goal and in the gate's
//               derivation alike; a needs_region row whose cause resolves reaches the gates; a void cause body and an
//               arrow expression body get an inert replacement; the decision is traced and graded by the region gate.
//   [CONTROL]   under variant-0 the region is today's (the operator_hold statement), logged "would anchor"; with no
//               stated cause variant-1 equals variant-0; an unresolvable cause falls back; a variant-0 needs_region row
//               stays refused.
import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  __setCheckRegionCauseAnchorDepsForTests, causeClearsNeedsRegion, causeRegion, noteCauseAnchorGoal, settleCauseAnchor, statedCauseOf,
} from "../../src/resolvers/check-region-cause-anchor.js";
import { explainedTextRegion } from "../../src/resolvers/check-supply-admission.js";

const supply = (await import("../../src/resolvers/gap-check-supply.js")) as Record<string, any>;

const ACTIVITY = "development-vessel:check-region-cause-anchor";
const REL = "src/supply.ts";
const SITE = [
  "export function generateCandidates(raw: Array<{ id: string; category?: string; meta?: Record<string, unknown> }>): string[] {",
  "  const admitted = admitRowsMirror(raw);",
  "  const kept = admitted.filter((g) => operatorOwnedReason(g.meta ?? {}) === null);",
  "  return kept.map((g) => g.id);",
  "}",
  "export function admitRowsMirror<T extends { id: string; category?: string }>(gaps: T[]): T[] {",
  "  return gaps.filter((g) => {",
  "    if (g.category !== \"orphaned_capability\") return true;",
  "    return false;",
  "  });",
  "}",
  "export function operatorOwnedReason(meta: Record<string, unknown>): string | null {",
  "  if (meta.directed === true) return \"directed\";",
  "  if (meta.operator_hold === true) return \"operator_hold\";",
  "  return null;",
  "}",
  "",
].join("\n");
const SUMMARY = "The gap-goal supply (generateCandidates) admits rows through admitRowsMirror, which checks only orphan-class rules " +
  "and has no armed-ness rule; operatorOwnedReason drops armed rows. The walk on such a row is refused at compose admission and " +
  "re-picked. Stopped by operator_hold on the row, not by the system.";
const META = { region: null, region_prior_text: "admitRowsMirror", needs_region: true };
const mask = (v: number) => () => [{ id: "m1", body: { activity_id: ACTIVITY, active_variant: v, from: "2000-01-01T00:00:00Z", until: "2099-01-01T00:00:00Z", by: "operator:test", reason: "test" } }];
const statementAt = (line: number) => SITE.split("\n")[line - 1]!.trim();

afterEach(() => __setCheckRegionCauseAnchorDepsForTests(null));

describe("statedCauseOf", () => {
  it("[CONTROL] the region, else region_prior_text, else nothing", () => {
    expect(statedCauseOf({ region: "x === 1", region_prior_text: "y" })).toBe("x === 1");
    expect(statedCauseOf(META)).toBe("admitRowsMirror");
    expect(statedCauseOf({ region: null })).toBeUndefined();
    expect(statedCauseOf(null)).toBeUndefined();
  });
});

describe("the check region under each variant", () => {
  it("[CONTROL] variant-0: today's pick, the incidental operator_hold statement, and a 'would anchor' line", () => {
    const lines: string[] = [];
    const log = console.log;
    console.log = (...a: unknown[]) => { lines.push(a.join(" ")); };
    try {
      __setCheckRegionCauseAnchorDepsForTests({ readMasks: mask(0) });
      const r = explainedTextRegion(SITE, REL, SUMMARY, "", { cause: statedCauseOf(META) }).region;
      expect(r?.kind).toBe("token");
      expect(r?.anchor).toBe("operator_hold");
      expect(statementAt(r!.mutant.line)).toBe("if (meta.operator_hold === true) return \"operator_hold\";");
    } finally { console.log = log; }
    expect(lines.some((l) => l.includes("would anchor \"admitRowsMirror\"") && l.includes("today: token \"operator_hold\""))).toBe(true);
  });

  it("[MUST-FAIL] variant-1: the stated cause's declaration, its own return replaced; a summary token does not override it", () => {
    __setCheckRegionCauseAnchorDepsForTests({ readMasks: mask(1) });
    const r = explainedTextRegion(SITE, REL, SUMMARY, "", { cause: statedCauseOf(META) }).region;
    expect(r?.kind).toBe("cause");
    expect(r?.anchor).toBe("admitRowsMirror");
    expect(r!.mutant.original.startsWith("return gaps.filter((g) => {")).toBe(true);
    expect(r!.mutant.replacement).toBe("return undefined as any;");
    const declLine = SITE.split("\n").findIndex((l) => l.startsWith("export function admitRowsMirror")) + 1;
    expect(r!.mutant.line).toBe(declLine + 1);
  });

  it("[MUST-FAIL] the goal writer and the gate's derivation name the same region under variant-1", () => {
    __setCheckRegionCauseAnchorDepsForTests({ readMasks: mask(1) });
    const sentence: string = supply.regionGoalSentence(REL, SITE, SUMMARY, META);
    const { spec, more } = supply.regionInputsOf(META);
    expect(more.cause).toBe("admitRowsMirror");
    const gate = explainedTextRegion(SITE, REL, SUMMARY, spec, more).region!;
    expect(sentence).toContain(`cause anchor "admitRowsMirror" at ${REL}:${gate.mutant.line}`);
    expect(sentence).not.toContain("operator_hold");
  });

  it("[MUST-FAIL] every region gate call and the compose precheck pass the row's stated cause", () => {
    const src = (f: string) => readFileSync(join(import.meta.dir, "..", "..", "src", "resolvers", f), "utf8");
    const gcs = src("gap-check-supply.ts");
    const gateCalls = [...gcs.matchAll(/regionMutantGate\(\{[^\n]*\}\)/g)].map((m) => m[0]);
    expect(gateCalls.length).toBe(2);
    for (const c of gateCalls) expect(c).toContain("cause: statedCauseOf(meta)");
    const fc = [...src("feature-compose.ts").matchAll(/regionMutantGateAt\([^\n]*\}\)/g)].map((m) => m[0]);
    expect(fc.length).toBe(1);
    expect(fc[0]).toContain("cause: statedCauseOf(a.meta)");
  });

  it("[CONTROL] with no stated cause, variant-1 gives today's region byte for byte", () => {
    __setCheckRegionCauseAnchorDepsForTests({ readMasks: mask(0) });
    const v0 = explainedTextRegion(SITE, REL, SUMMARY, "", {});
    __setCheckRegionCauseAnchorDepsForTests({ readMasks: mask(1) });
    const v1 = explainedTextRegion(SITE, REL, SUMMARY, "", { cause: statedCauseOf({ region: null }) });
    expect(JSON.stringify(v1)).toBe(JSON.stringify(v0));
    expect(supply.regionGoalSentence(REL, SITE, SUMMARY, { region: null })).toBe((() => { __setCheckRegionCauseAnchorDepsForTests({ readMasks: mask(0) }); return supply.regionGoalSentence(REL, SITE, SUMMARY, { region: null }); })());
  });

  it("[CONTROL] variant-1 with a cause that does not resolve falls back to today's pick", () => {
    __setCheckRegionCauseAnchorDepsForTests({ readMasks: mask(1) });
    const r = explainedTextRegion(SITE, REL, SUMMARY, "", { cause: "noSuchFunction" }).region;
    expect(r?.anchor).toBe("operator_hold");
    expect(causeRegion(SITE, REL, "noSuchFunction").why).toContain("not a declaration");
  });

  it("[CONTROL] an unreadable mask is variant-0", () => {
    __setCheckRegionCauseAnchorDepsForTests({ readMasks: () => { throw new Error("pool down"); } });
    expect(explainedTextRegion(SITE, REL, SUMMARY, "", { cause: "admitRowsMirror" }).region?.anchor).toBe("operator_hold");
  });
});

describe("causeRegion", () => {
  it("[MUST-FAIL] a void body is replaced by {} and an arrow's expression body by undefined", () => {
    const src = "export function sink(x: number[]): void {\n  x.push(1);\n}\nexport const twice = (n: number) => n * 2;\n";
    const v = causeRegion(src, "src/a.ts", "sink").region!;
    expect(v.mutant.original).toBe("{\n  x.push(1);\n}");
    expect(v.mutant.replacement).toBe("{}");
    const a = causeRegion(src, "src/a.ts", "twice").region!;
    expect(a.mutant.original).toBe("n * 2");
    expect(a.mutant.replacement).toBe("undefined");
  });

  it("[MUST-FAIL] every return and throw of the body is ONE mutant; a nested function's returns are not the body's", () => {
    const src = "export function pick(n: number): number {\n  const f = () => { return 9; };\n  if (n < 0) throw new Error(\"neg\");\n  if (n === 0) return f();\n  return n;\n}\n";
    const r = causeRegion(src, "src/p.ts", "pick").region!;
    expect(r.occurrences).toBe(3);
    expect(r.mutant.original).not.toContain("return 9;");
    expect(r.mutant.replacement.match(/return undefined as any;/g)?.length).toBe(2);
    expect(r.mutant.replacement).toContain("void 0;");
  });

  it("[CONTROL] a literal found once is its statement; one found twice, or none, does not resolve", () => {
    const src = "export function f(m: Record<string, unknown>): string {\n  if (m.a === 1) return \"one\";\n  return \"two\";\n}\n";
    expect(causeRegion(src, "src/f.ts", "m.a === 1").region?.mutant.original).toBe("if (m.a === 1) return \"one\";");
    expect(causeRegion(src, "src/f.ts", "return").region).toBeNull();
    expect(causeRegion(src, "src/f.ts", "nowhere").region).toBeNull();
  });
});

describe("a needs_region row and the arm step", () => {
  it("[MUST-FAIL] variant-1: a needs_region row whose stated cause resolves reaches the gates", () => {
    __setCheckRegionCauseAnchorDepsForTests({ readMasks: mask(1) });
    expect(causeClearsNeedsRegion(META, SITE, REL)).toBe(true);
  });
  it("[CONTROL] variant-0, an unresolvable cause, no site text, or no needs_region flag: refused as before", () => {
    __setCheckRegionCauseAnchorDepsForTests({ readMasks: mask(0) });
    expect(causeClearsNeedsRegion(META, SITE, REL)).toBe(false);
    __setCheckRegionCauseAnchorDepsForTests({ readMasks: mask(1) });
    expect(causeClearsNeedsRegion({ ...META, region_prior_text: "noSuchFunction" }, SITE, REL)).toBe(false);
    expect(causeClearsNeedsRegion(META, null, REL)).toBe(false);
    expect(causeClearsNeedsRegion({ ...META, needs_region: false }, SITE, REL)).toBe(false);
  });
});

describe("the decision's trace and its consumer grade", () => {
  const setup = (v: number) => {
    const posted: Array<Record<string, unknown>> = [];
    const dir = mkdtempSync(join(tmpdir(), "crca-"));
    let now = Date.parse("2000-01-01T00:00:00Z");
    __setCheckRegionCauseAnchorDepsForTests({ readMasks: mask(v), postTrace: async (t) => { posted.push(t); return 201; }, nowMs: () => now, stateFile: join(dir, "s.json") });
    return { posted, dir, advance: (ms: number) => { now += ms; } };
  };
  const flush = () => new Promise((r) => setTimeout(r, 0));

  it("[MUST-FAIL] variant-1: the goal posts checkRegionAnchor; a gate whose red moved under the cause region credits reached", async () => {
    const { posted } = setup(1);
    const id = noteCauseAnchorGoal({ gapId: "g-1", meta: META, siteSrc: SITE, siteRel: REL });
    expect(id).not.toBeNull();
    settleCauseAnchor("g-1", { kind: "pass", record: { region: "derived_from_stated_cause", measured: 1, changed: 1 } });
    await flush();
    expect(posted.map((t) => t["activity_id"])).toEqual([`${ACTIVITY}-v1`, `${ACTIVITY}-credit`]);
    expect(posted[0]!["output_shapes"]).toEqual(["checkRegionAnchor"]);
    expect(posted[1]!["success"]).toBe(true);
    expect(posted[1]!["composition_chain"]).toEqual([id]);
  });

  it("[MUST-FAIL] a red that survived the cause region credits not reached; a token-region or unmeasured gate settles nothing", async () => {
    const { posted } = setup(1);
    noteCauseAnchorGoal({ gapId: "g-2", meta: META, siteSrc: SITE, siteRel: REL });
    settleCauseAnchor("g-2", { kind: "pass", record: { region: "derived_from_token_anchor", measured: 1, changed: 1 } });
    settleCauseAnchor("g-2", { kind: "pass", record: { region: "derived_from_stated_cause", measured: 0, changed: 0 } });
    await flush();
    expect(posted).toHaveLength(1);
    settleCauseAnchor("g-2", { kind: "refuse", record: { region: "derived_from_stated_cause", measured: 1, changed: 0 } });
    await flush();
    expect(posted).toHaveLength(2);
    expect(posted[1]!["success"]).toBe(false);
  });

  it("[CONTROL] variant-0 records and posts nothing", async () => {
    const { posted, dir } = setup(0);
    expect(noteCauseAnchorGoal({ gapId: "g-3", meta: META, siteSrc: SITE, siteRel: REL })).toBeNull();
    settleCauseAnchor("g-3", { kind: "pass", record: { region: "derived_from_stated_cause", measured: 1, changed: 1 } });
    await flush();
    expect(posted).toHaveLength(0);
    expect(readdirSync(dir)).toEqual([]);
  });

  it("[CONTROL] a decision with no region gate in 48 h is dropped ungraded", async () => {
    const { posted, advance } = setup(1);
    noteCauseAnchorGoal({ gapId: "g-4", meta: META, siteSrc: SITE, siteRel: REL });
    advance(48 * 3_600_000);
    settleCauseAnchor("g-4", { kind: "pass", record: { region: "derived_from_stated_cause", measured: 1, changed: 1 } });
    await flush();
    expect(posted).toHaveLength(1);
  });
});
