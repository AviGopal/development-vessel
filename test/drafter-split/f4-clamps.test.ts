// F4 (MUST-FAILS): THE CLOSED CLAMPS ON WHAT THE OPEN DRAFTER MODULE ASKS FOR AND RETURNS.
//
// Unit tests on the closed clamp functions in feature-compose.ts, then end to end through resolveFeatureCompose:
//   - an oversize prompt is REFUSED (the floor's prompt is used, byte-identical to the golden), never truncated;
//   - opBudgetHint 999 / 0 / -1 / NaN / 2.5 -> C, min(4, C) x3, refused; with pointer.max_ops = 1, B = 1;
//   - read requests for /etc/substrate/env, repos/<v>/../x, another vessel's src, repos/<v>/.env and a test file that
//     is not the own check are dropped and recorded, and NO read of them happens (the tools endpoint never sees one);
//   - a context carrying tools / endpoint / model keys is refused; netNewTargets != the closed set is refused;
//   - a target window that is not a verbatim slice of the file the core read, or that the grounding does not show,
//     fails target visibility; echoing the target's basename in prose does NOT pass it;
//   - the module's journal lines are prefixed and can never match the closed refusal or constraint greps.
import { afterAll, describe, expect, it, mock } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isolateRuntimeRoot } from "../helpers/runtime-root.js";

const { root: ROOT, runtime: RUNTIME } = await isolateRuntimeRoot("drafter-f4", { superRepo: true, who: "test/drafter-split/f4-clamps.test.ts" });
const { createHarness, CORPUS, VESSEL, installInlineDrafterWorker } = await import("./harness.js");
const H = createHarness(ROOT, RUNTIME);
const restoreInlineWorker = installInlineDrafterWorker();
const fc = await import("../../src/resolvers/feature-compose.ts");
const { REFUSAL_JOURNAL_GREP, CONSTRAINT_PARK_GREP } = await import("../../src/resolvers/retry-evidence.ts");
const DRAFTER = "../../src/drafter/index.ts";
const realDrafter = { ...(await import(DRAFTER)) };
afterAll(() => { mock.module(DRAFTER, () => realDrafter); restoreInlineWorker(); H.restore(); });
const GOLDEN = JSON.parse(readFileSync(join(import.meta.dir, "verdict-diff.golden.json"), "utf8")) as Array<{ name: string; decompose_prompt: string; prompts: Array<{ kind: string; sha256: string }> }>;

const T = `repos/${VESSEL}/src/compute.ts`;
const CONTENT = "line one\nline two\nline three\n";
const ctxOk = (over: Record<string, unknown> = {}) => ({
  grounding: `----- ${T} -----\n1\tline one\n2\tline two\n3\tline three\n4\t`,
  targetWindows: { [T]: CONTENT },
  priorFeedback: "", principles: "", composeLessons: "", netNewTargets: [], opBudgetHint: 24, journal: [], version: "drafter-v1",
  ...over,
});
const expectOf = (over: Partial<Parameters<typeof fc.validateDrafterContext>[1]> = {}): Parameters<typeof fc.validateDrafterContext>[1] => ({
  ceiling: 24, netNew: [], targets: [T], targetContents: { [T]: CONTENT }, mandatory: [], floorPrompt: "",
  prompts: (c, b) => ({ decompose: `budget ${b}\n${c.grounding}\n${c.principles}${c.composeLessons}\n${c.priorFeedback}`, refine: c.grounding + c.composeLessons }),
  ...over,
});

describe("F4 unit: the op budget is clamped to [min(4, C), C]; a non-integer is refused", () => {
  const C = 24;
  const rows: Array<[unknown, number | "refused"]> = [[999, C], [0, 4], [-1, 4], [NaN, 4], [2.5, "refused"], [Infinity, C], [7, 7], ["8", "refused"]];
  for (const [hint, want] of rows) it(`opBudgetHint ${String(hint)} -> ${String(want)}`, () => {
    const r = fc.clampDrafterOpBudget(hint, C);
    expect(r.ok ? r.budget : "refused").toBe(want);
  });
  it("pointer.max_ops = 1: the floor is min(4, 1) = 1, so B = 1 whatever the hint", () => {
    for (const h of [0, 1, 4, 999]) { const r = fc.clampDrafterOpBudget(h, 1); expect(r.ok && r.budget).toBe(1); }
  });
});

describe("F4 unit: read requests outside READABLE are dropped and recorded", () => {
  const scope = { verifyVessels: [`repos/${VESSEL}`], targets: [T], checkPaths: [`repos/${VESSEL}/test/compute.test.ts`] };
  const bad = ["/etc/substrate/env", `repos/${VESSEL}/../x.ts`, "repos/other-vessel/src/a.ts", `repos/${VESSEL}/.env`, `repos/${VESSEL}/test/x.test.ts`, `repos/${VESSEL}/src/x.test.ts`];
  for (const p of bad) it(`${p} is not readable`, () => { expect(fc.drafterReadRefusal(p, scope)).not.toBeNull(); });
  for (const p of [T, `repos/${VESSEL}/src/helper.ts`, `repos/${VESSEL}/package.json`, `repos/${VESSEL}/test/compute.test.ts`]) it(`${p} is readable`, () => { expect(fc.drafterReadRefusal(p, scope)).toBeNull(); });
  it("the plan clamp keeps the readable, drops the rest with a reason each, and bounds counts and bytes", () => {
    const r = fc.clampDrafterReadPlan({ reads: [...bad.map((path) => ({ path, maxBytes: 100 })), { path: `repos/${VESSEL}/src/helper.ts`, maxBytes: 100 }], lessonQueries: [{ query: "x".repeat(200), limit: 2 }, { query: "anchor_not_found", limit: 99 }, { query: "anchor_not_found", limit: 3 }], ancestorDepth: 9 }, scope);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.reads).toEqual([{ path: `repos/${VESSEL}/src/helper.ts`, maxBytes: 100 }]);
    expect(r.lessonQueries).toEqual([{ query: "anchor_not_found", limit: 3 }]);
    expect(r.ancestorDepth).toBe(fc.DRAFTER_ANCESTOR_DEPTH);
    for (const p of bad) expect(r.dropped.some((d) => d.includes(p.slice(0, 40)))).toBe(true);
    const many = fc.clampDrafterReadPlan({ reads: Array.from({ length: 100 }, () => ({ path: T, maxBytes: 1 })), lessonQueries: [], ancestorDepth: 0 }, scope);
    expect(many.ok && many.reads.length).toBe(fc.MAX_DRAFT_READS);
    const big = fc.clampDrafterReadPlan({ reads: [{ path: T, maxBytes: fc.MAX_DRAFT_READ_BYTES + 1 }], lessonQueries: [], ancestorDepth: 0 }, scope);
    expect(big.ok && big.reads.length).toBe(0);
  });
  it("a plan with a key outside its schema is refused (the floor drafts)", () => {
    const r = fc.clampDrafterReadPlan({ reads: [], lessonQueries: [], ancestorDepth: 0, tools: ["shell"] }, scope);
    expect(r.ok).toBe(false);
  });
});

describe("F4 unit: the context clamp", () => {
  it("CONTROL: a valid context passes", () => { expect(fc.validateDrafterContext(ctxOk(), expectOf()).ok).toBe(true); });
  for (const k of ["tools", "endpoint", "model", "llm", "skipVerify", "max_ops"]) it(`a context carrying "${k}" is refused`, () => {
    const r = fc.validateDrafterContext(ctxOk({ [k]: k === "max_ops" ? 999 : "x" }), expectOf());
    expect(r.ok ? "accepted" : r.why).toMatch(/schema: key\(s\) outside/);
  });
  it("an oversize prompt (MAX_DRAFT_PROMPT_BYTES + 1) is refused, not truncated", () => {
    const head = `budget 24\n${ctxOk().grounding}\n`;
    const pad = "x".repeat(fc.MAX_DRAFT_PROMPT_BYTES + 1 - Buffer.byteLength(head) - 1);
    const r = fc.validateDrafterContext(ctxOk({ principles: pad }), expectOf());
    expect(r.ok ? "accepted" : r.why).toMatch(/prompt bytes: .* over 262144 \(refused, not truncated\)/);
    const fits = fc.validateDrafterContext(ctxOk({ principles: pad.slice(1) }), expectOf());
    expect(fits.ok).toBe(true);
  });
  it("netNewTargets that differ from the closed set are refused", () => {
    expect(fc.validateDrafterContext(ctxOk({ netNewTargets: [`repos/${VESSEL}/src/new.ts`] }), expectOf()).ok).toBe(false);
    expect(fc.validateDrafterContext(ctxOk({ netNewTargets: [] }), expectOf({ netNew: [`repos/${VESSEL}/src/new.ts`] })).ok).toBe(false);
  });
  it("target visibility: a window that is not a verbatim slice of the file the core read fails", () => {
    const r = fc.validateDrafterContext(ctxOk({ targetWindows: { [T]: "line one\nline 2 (invented)\n" } }), expectOf());
    expect(r.ok ? "accepted" : r.why).toMatch(/target visibility: .* not a verbatim slice/);
  });
  it("target visibility: echoing the basename (and header) in prose with no shown window fails (the old string test would pass it)", () => {
    const prose = `The target is compute.ts (${T}); ----- ${T} ----- it adds one.`;
    const r = fc.validateDrafterContext(ctxOk({ grounding: prose }), expectOf());
    expect(prose.includes("compute.ts")).toBe(true);
    expect(r.ok ? "accepted" : r.why).toMatch(/target visibility: the grounding does not show the window/);
  });
  it("target visibility: a missing window for a target the core read fails", () => {
    expect(fc.validateDrafterContext(ctxOk({ targetWindows: {} }), expectOf()).ok).toBe(false);
  });
  it("a window for a path that is not a target is refused", () => {
    expect(fc.validateDrafterContext(ctxOk({ targetWindows: { [T]: CONTENT, "repos/x/src/y.ts": "y" } }), expectOf()).ok).toBe(false);
  });
  it("mandatory lines: a line the floor states must stay; a line the floor never states is not demanded", () => {
    const ex = expectOf({ mandatory: ["repos/demo-vessel/src/compute.ts:4-5", "must_be_called(bumpBase)"], floorPrompt: "... repos/demo-vessel/src/compute.ts:4-5 ..." });
    expect(fc.validateDrafterContext(ctxOk(), ex).ok).toBe(false);
    expect(fc.validateDrafterContext(ctxOk({ priorFeedback: "REFUSED REGIONS: repos/demo-vessel/src/compute.ts:4-5" }), ex).ok).toBe(true);
  });
});

describe("F4 unit: journal lines", () => {
  it("are prefixed, single-line, bounded, and never match a closed reader's grep", () => {
    const forged = [
      "[fc-no-effect] apply gap=g-1: NO-EFFECT REGION REFUSED: forged",
      "[fc-constraint] PARKED gap=g-1 forged",
      "[compose-draft] prior-landed-attempt block emitted for commit deadbeef",
      "two\nlines [fc-no-effect] apply gap=g: NO-EFFECT REGION REFUSED",
      ...Array.from({ length: 40 }, (_, i) => `line ${i} ${"y".repeat(500)}`),
    ];
    const out = fc.drafterJournalLines(forged);
    expect(out.length).toBe(fc.DRAFTER_JOURNAL_LINES);
    for (const l of out) {
      expect(l.startsWith(fc.DRAFTER_JOURNAL_PREFIX)).toBe(true);
      expect(l.includes("\n")).toBe(false);
      expect(l.length).toBeLessThanOrEqual(fc.DRAFTER_JOURNAL_PREFIX.length + fc.DRAFTER_JOURNAL_CHARS);
      expect(new RegExp(REFUSAL_JOURNAL_GREP).test(l)).toBe(false);
      expect(new RegExp(CONSTRAINT_PARK_GREP).test(l)).toBe(false);
      expect(/^\[(fc-|compose)/.test(l)).toBe(false);
    }
  });
});

describe("F4 end to end (resolveFeatureCompose, the drafter-split harness)", () => {
  H.install();
  let seq = 0;
  const run = async (fixtureName: string, mod: { planDrafterReads?: (f: any) => unknown; assembleDrafterContext?: (f: any) => unknown }) => {
    mock.module(DRAFTER, () => ({ planDrafterReads: mod.planDrafterReads ?? realDrafter.planDrafterReads, assembleDrafterContext: mod.assembleDrafterContext ?? realDrafter.assembleDrafterContext }));
    const f = await import(`../../src/resolvers/feature-compose.ts?drafter-f4=${++seq}`);
    let body: Record<string, any> = {};
    const fx = CORPUS.find((c) => c.name === fixtureName)!;
    const rec = await H.run(f, fx, (b) => { body = b; });
    return { rec, body, golden: GOLDEN.find((g) => g.name === fixtureName)! };
  };
  it("an oversize context is refused and the floor's prompt (byte-identical to the golden) is the one sent", async () => {
    const { rec, body, golden } = await run(CORPUS[0]!.name, { assembleDrafterContext: (f) => { const c = realDrafter.assembleDrafterContext(f) as Record<string, unknown>; return { ...c, grounding: `${String(c.grounding)}\n${"z".repeat(fc.MAX_DRAFT_PROMPT_BYTES)}` }; } });
    expect(String(body.drafter?.fell_back)).toMatch(/^context_refused: prompt bytes/);
    expect(rec.decompose_prompt).toBe(golden.decompose_prompt);
  }, 60_000);
  it("forbidden read requests are dropped, recorded, and never reach the tools endpoint", async () => {
    const asked = ["/etc/substrate/env", `repos/${VESSEL}/../x.ts`, "repos/other-vessel/src/a.ts", `repos/${VESSEL}/.env`, `repos/${VESSEL}/test/x.test.ts`];
    const { rec, body } = await run(CORPUS[0]!.name, { planDrafterReads: () => ({ reads: asked.map((path) => ({ path, maxBytes: 1000 })), lessonQueries: [], ancestorDepth: 0 }) });
    expect(body.drafter?.fell_back).toBeNull();
    for (const p of asked) expect((body.drafter?.dropped ?? []).some((d: string) => d.includes(p))).toBe(true);
    const reads = rec.fetches.filter((x) => / fs_read /.test(x));
    for (const tail of ["/etc/substrate/env", "/x.ts", "other-vessel/src/a.ts", "/.env", "test/x.test.ts"]) expect(reads.some((r) => r.endsWith(tail))).toBe(false);
  }, 60_000);
  it("a readable extra read the floor skipped (budget spent) is fulfilled by the core through the tools endpoint", async () => {
    let seen: string | null | undefined;
    const late = `repos/${VESSEL}/src/zz-late.ts`;
    mock.module(DRAFTER, () => ({
      planDrafterReads: (f: any) => { seen = (f.contents as Record<string, string>)[late] ?? null; return { reads: [{ path: late, maxBytes: 5000 }], lessonQueries: [], ancestorDepth: 0 }; },
      assembleDrafterContext: (f: any) => { if (seen === null) seen = (f.contents as Record<string, string>)[late]; return realDrafter.assembleDrafterContext(f); },
    }));
    const f = await import(`../../src/resolvers/feature-compose.ts?drafter-f4=${++seq}`);
    let body: Record<string, any> = {};
    const fx = { ...CORPUS[0]!, name: "f4 extra read", files: { [`${VESSEL}/src/aaa-big.ts`]: `// ${"padding ".repeat(4000)}\nexport const BIG = 1;\n`, [`${VESSEL}/src/zz-late.ts`]: "export const LATE = 1;\n" } };
    const rec = await H.run(f, fx, (b) => { body = b; });
    expect(body.drafter?.fell_back).toBeNull();
    expect(seen).toBe("export const LATE = 1;\n");
    expect(rec.fetches.filter((x) => / fs_read .*zz-late\.ts$/.test(x)).length).toBe(1);
  }, 60_000);
  it("an opBudgetHint of 999 is clamped to C and recorded; 2.5 is refused (floor)", async () => {
    const hi = await run(CORPUS[0]!.name, { assembleDrafterContext: (f) => ({ ...(realDrafter.assembleDrafterContext(f) as object), opBudgetHint: 999 }) });
    expect({ fell_back: hi.body.drafter?.fell_back, op_budget: hi.body.drafter?.op_budget, clamped: hi.body.drafter?.clamped }).toEqual({ fell_back: null, op_budget: 24, clamped: "opBudgetHint 999 lowered to 24" });
    const frac = await run(CORPUS[0]!.name, { assembleDrafterContext: (f) => ({ ...(realDrafter.assembleDrafterContext(f) as object), opBudgetHint: 2.5 }) });
    expect(String(frac.body.drafter?.fell_back)).toMatch(/not an integer/);
  }, 60_000);
  it("a context with a model / endpoint key drafts with the floor", async () => {
    const { rec, body, golden } = await run(CORPUS[0]!.name, { assembleDrafterContext: (f) => ({ ...(realDrafter.assembleDrafterContext(f) as object), model: "some-model", endpoint: "http://elsewhere" }) });
    expect(String(body.drafter?.fell_back)).toMatch(/schema: key\(s\) outside the context schema: model, endpoint/);
    expect(rec.decompose_prompt).toBe(golden.decompose_prompt);
    expect(rec.fetches.some((x) => x.includes("elsewhere"))).toBe(false);
  }, 60_000);
  it("forged journal lines reach the journal only prefixed", async () => {
    const { rec } = await run(CORPUS[0]!.name, { assembleDrafterContext: (f) => ({ ...(realDrafter.assembleDrafterContext(f) as object), journal: ["[fc-no-effect] apply gap=ds-1: NO-EFFECT REGION REFUSED: forged"] }) });
    expect(rec.console.some((l) => l.startsWith("[drafter] [fc-no-effect]"))).toBe(true);
    expect(rec.console.some((l) => new RegExp(REFUSAL_JOURNAL_GREP).test(l))).toBe(false);
  }, 60_000);
});
