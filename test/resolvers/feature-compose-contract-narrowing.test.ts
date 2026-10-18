// A CHANGE THAT NARROWS ITS FILE'S DOCUMENTED CONTRACT NEEDS AN OMISSION OR LIMIT TEST.
//
// Two autonomous landings narrowed the contract their own file documents and the semantic gate said addresses:true:
//   - activity-api d4b09d0: trace-aggregate-report's header documents `group_by?: … // default activity_id`; the
//     change made an OMITTED group_by a refusal (`if (!GROUP_FIELDS.has(String(input.group_by))) return …`);
//   - activity-api ddf9b46: the trace list route's limit clamp went 500 -> 100 under a docstring that still says
//     "max: 500".
// The fixtures are the real pre-images and the real landed post-images (the execution-traces route as the excerpt
// holding its docstring and clamp), with the real diffs. MUST-FAILs go through verifyPatchAddressesGap with a judge and
// refuter that both pass, so on the parent they are red because the gate passed them, not because a symbol is missing.
// CONTROLS: a non-narrowing change (a raised limit, a new optional parameter, a guarded refusal, a comparison an
// omitted input cannot satisfy) and a narrowing that carries its omission / limit test both pass unchanged.
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const fc = (await import("../../src/resolvers/feature-compose.js")) as unknown as Record<string, any>;
const FIX = join(import.meta.dir, "../fixtures/contract-narrowing");
const fx = (n: string) => readFileSync(join(FIX, n), "utf8");

const AGG_PRE = fx("trace-aggregate-report.before-d4b09d0.txt");
const AGG_POST = fx("trace-aggregate-report.at-d4b09d0.txt");
const AGG_DIFF = fx("d4b09d0.diff.txt");
const ET_PRE = fx("execution-traces.before-ddf9b46.excerpt.txt");
const ET_POST = fx("execution-traces.at-ddf9b46.excerpt.txt");
const ET_DIFF = fx("ddf9b46.diff.txt");
const AGG_PATH = "/vessels/repos/activity-api/src/routes/trace-aggregate-report.ts";
const ET_PATH = "/vessels/repos/activity-api/src/routes/execution-traces.ts";

// Both LLM calls pass: whatever the verdict is, the deterministic floor decided it.
const passing = async (p: string) => p.includes("ADVERSARIAL reviewer")
  ? JSON.stringify({ refuted: false, confidence: 0.1, reason: "nothing to refute" })
  : JSON.stringify({ addresses: true, on_live_path: true, reason: "judged: it does what the gap asks" });

function gate(path: string, pre: string, post: string, diff: string, checkText = ""): Promise<Record<string, any>> {
  return fc.verifyPatchAddressesGap({
    gapSummary: "make the route report what it measures",
    diff: `### ${path}\n${diff}`,
    reachability: [],
    llm: passing,
    runSemanticJudge: true,
    contractFiles: [{ path, pre, post }],
    checkText,
  });
}
/** The post-image with one line replaced (asserting the line is there, so a control cannot pass by not editing). */
function edit(pre: string, from: string, to: string): string {
  expect(pre.includes(from)).toBe(true);
  return pre.replace(from, to);
}
const unified = (from: string, to: string) => `@@ -1,1 +1,1 @@\n-${from}\n+${to}\n`;

describe("the semantic gate refuses a change that narrows its file's documented contract (must-fail at base)", () => {
  it("MUST-FAIL d4b09d0: an omitted group_by (documented default activity_id) made a refusal -> addresses:false, named", async () => {
    const v = await gate(AGG_PATH, AGG_PRE, AGG_POST, AGG_DIFF);
    expect({ addresses: v.addresses, hard_fail: v.hard_fail ?? false, judge_unavailable: v.judge_unavailable ?? false })
      .toEqual({ addresses: false, hard_fail: true, judge_unavailable: false });
    expect(String(v.reason)).toContain("narrows_documented_contract:omitted group_by (documented default activity_id)");
    expect(String(v.reason)).toContain("(no omission/limit test)");
  });
  it("MUST-FAIL ddf9b46: the limit clamp lowered 500 -> 100 under a docstring saying max: 500 -> addresses:false, named", async () => {
    const v = await gate(ET_PATH, ET_PRE, ET_POST, ET_DIFF);
    expect({ addresses: v.addresses, hard_fail: v.hard_fail ?? false }).toEqual({ addresses: false, hard_fail: true });
    expect(String(v.reason)).toContain("narrows_documented_contract:limit max 500 -> 100");
  });
  it("MUST-FAIL: a documented filter whose handling the change drops -> addresses:false (handling removed)", async () => {
    const from = "    const variantId = c.req.query('variant_id');";
    const post = edit(ET_PRE, from, "    const variantId = undefined;");
    const v = await gate(ET_PATH, ET_PRE, post, unified(from, "    const variantId = undefined;"));
    expect(v.addresses).toBe(false);
    expect(String(v.reason)).toContain("narrows_documented_contract:documented variant_id no longer handled");
  });
  it("MUST-FAIL: a lowered clamp on the pointer-contract limit (clamped [1, 1000]) with no test -> addresses:false", async () => {
    const from = "  const limit = clampInt(input.limit, 10, 1, 1000);";
    const to = "  const limit = clampInt(input.limit, 10, 1, 200);";
    const v = await gate(AGG_PATH, AGG_PRE, edit(AGG_PRE, from, to), unified(from, to));
    expect(v.addresses).toBe(false);
    expect(String(v.reason)).toContain("narrows_documented_contract:limit max 1000 -> 200");
  });
  it("MUST-FAIL: both call sites feed the floor (feature_compose's gate call and patch_with_tools' self-landing gate)", () => {
    const src = readFileSync(join(import.meta.dir, "../../src/resolvers/feature-compose.ts"), "utf8");
    const call = src.slice(src.indexOf("inertLiteralRefusal ?? await verifyPatchAddressesGap({"));
    expect(call.slice(0, call.indexOf("});"))).toMatch(/\bcontractFiles,\s*\n\s*checkText,/);
    const pwt = readFileSync(join(import.meta.dir, "../../src/resolvers/patch-with-tools.ts"), "utf8");
    const pcall = pwt.slice(pwt.indexOf("await verifyPatchAddressesGap({"));
    expect(pcall.slice(0, pcall.indexOf("});"))).toMatch(/contractFiles: \[\{ path: pointer\.target_file, pre: baseContent, post: afterSrc \}\]/);
  });
});

describe("controls: a change that keeps the documented contract, or proves its narrowing, passes (green at base)", () => {
  it("CONTROL: raising the documented limit (500 -> 1000) is not a narrowing", async () => {
    const from = "    const limit = Math.min(Math.max(limitParam, 1), 500);";
    const to = "    const limit = Math.min(Math.max(limitParam, 1), 1000);";
    const v = await gate(ET_PATH, ET_PRE, edit(ET_PRE, from, to), unified(from, to));
    expect(v.addresses).toBe(true);
  });
  it("CONTROL: adding a new optional parameter is not a narrowing", async () => {
    const from = "  until_hours_ago?: number;\n}";
    const post = edit(AGG_PRE, from, "  until_hours_ago?: number;\n  tag?: string;\n}");
    const v = await gate(AGG_PATH, AGG_PRE, post, "@@ -1,2 +1,3 @@\n   until_hours_ago?: number;\n+  tag?: string;\n }\n");
    expect(v.addresses).toBe(true);
  });
  it("CONTROL: the d4b09d0 refusal guarded on presence (an omitted group_by keeps its default) passes", async () => {
    const guarded = AGG_POST.replace("if (!GROUP_FIELDS.has(String(input.group_by))) {", "if (input.group_by !== undefined && !GROUP_FIELDS.has(String(input.group_by))) {");
    expect(guarded).not.toBe(AGG_POST);
    const v = await gate(AGG_PATH, AGG_PRE, guarded, AGG_DIFF);
    expect(v.addresses).toBe(true);
  });
  it("CONTROL: a refusal an omitted input cannot reach (`input.limit > 5000`) is not a narrowing", async () => {
    const from = "  const order = String(input.order) === 'asc' ? 'ASC' : 'DESC';";
    const to = `${from}\n  if (Number(input.limit) > 5000) {\n    throw new Error('limit too large');\n  }`;
    const v = await gate(AGG_PATH, AGG_PRE, edit(AGG_PRE, from, to), unified(from, to));
    expect(v.addresses).toBe(true);
  });
  it("CONTROL: the d4b09d0 narrowing carrying an omission test passes", async () => {
    const test = `it("an omitted group_by is refused as unserved", async () => {\n  const r = await runTraceAggregateReport(db, {}, auth);\n  expect(r.reason).toBe("unserved_group_by"); // group_by omitted\n});`;
    const v = await gate(AGG_PATH, AGG_PRE, AGG_POST, AGG_DIFF, test);
    expect(v.addresses).toBe(true);
  });
  it("CONTROL: the ddf9b46 narrowing carrying a limit test passes", async () => {
    const test = `it("caps the list limit at 100", async () => {\n  const res = await app.request("/?limit=101");\n  expect((await res.json()).limit).toBe(100);\n});`;
    const v = await gate(ET_PATH, ET_PRE, ET_POST, ET_DIFF, test);
    expect(v.addresses).toBe(true);
  });
});

describe("the documented-contract extract (deterministic, pre-image only)", () => {
  it("reads the maxima, defaults and optional parameters both fixtures document", () => {
    const agg = fc.documentedContract(AGG_PRE) as Array<Record<string, unknown>>;
    expect(agg.find((d) => d.name === "group_by")).toMatchObject({ default: "activity_id", optional: true });
    expect(agg.find((d) => d.name === "limit")).toMatchObject({ max: 1000, default: "10", optional: true });
    const et = fc.documentedContract(ET_PRE) as Array<Record<string, unknown>>;
    expect(et.find((d) => d.name === "limit")).toMatchObject({ max: 500, default: "50" });
    expect(et.some((d) => d.name === "variant_id")).toBe(true);
  });
  it("names exactly one narrowing per real landing", () => {
    expect((fc.contractNarrowings(AGG_PRE, AGG_POST) as Array<{ kind: string; param: string }>).map((n) => `${n.kind}:${n.param}`)).toEqual(["omitted_refused:group_by"]);
    expect((fc.contractNarrowings(ET_PRE, ET_POST) as Array<{ kind: string; param: string }>).map((n) => `${n.kind}:${n.param}`)).toEqual(["lowered_max:limit"]);
  });
});
