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
//
// QA FOLLOW-UP (on 0f3daf0b). (b) The evidence was the WHOLE text of every touched test file plus the whole own
// check, and a bare literal counted: d4b09d0 read as "tested" against activity-api's PRE-EXISTING
// trace-aggregate-report tests because `{ group_by: 'activity_id', limit: 1 }` — an explicit value, the opposite of an
// omission — names the default. Evidence is now only the test lines the change ADDED, and for an omission only a
// test title naming it or a call to the narrowed function without the key. (P3) a nested `Math.max(parseInt(x, 10), 1)`
// read its radix and lower bound as upper bounds. (P2) a NEW handler with its own cap was compared with the tightest
// maximum documented anywhere in the file (7 of 10 lane refusals were that). (P1) a destructured read
// (`const { limit: rawLimit } = input`) read as the parameter no longer handled. (d) patch_with_tools ran the floor
// only inside its LLM-judge condition.
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
// activity-api's own trace-aggregate-report tests as they stood before d4b09d0 (they did not change in it).
const AGG_TESTS = fx("trace-aggregate-report.failure-class.test.before-d4b09d0.txt") + "\n" + fx("trace-aggregate-report.real-schema.test.before-d4b09d0.txt");

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
  it("MUST-FAIL: both call sites feed the floor; feature_compose's evidence is the ADDED test lines, patch_with_tools' floor is outside its LLM condition", () => {
    const src = readFileSync(join(import.meta.dir, "../../src/resolvers/feature-compose.ts"), "utf8");
    const call = src.slice(src.indexOf("inertLiteralRefusal ?? await verifyPatchAddressesGap({"));
    expect(call.slice(0, call.indexOf("});"))).toMatch(/\bcontractFiles,\s*\n\s*checkText,/);
    expect(src).toMatch(/const checkText = contractAddedTestText\(\[\.\.\.postPatchContents\]\.map\(\(\[abs, post\]\) => \(\{ path: abs, pre: preEditContent\.get\(abs\) \?\? "", post \}\)\)\);/);
    const pwt = readFileSync(join(import.meta.dir, "../../src/resolvers/patch-with-tools.ts"), "utf8");
    const floor = pwt.indexOf('contractNarrowingRefusal([{ path: pointer.target_file, pre: baseContent, post: afterSrc }], "")');
    const llmCond = pwt.indexOf("if (proposalText && llmEndpoints.length > 0) {");
    expect(floor).toBeGreaterThan(0);
    expect(floor).toBeLessThan(llmCond);
  });
  it("MUST-FAIL (b): d4b09d0 against activity-api's PRE-EXISTING trace-aggregate-report tests is still refused", async () => {
    const v = await gate(AGG_PATH, AGG_PRE, AGG_POST, AGG_DIFF, AGG_TESTS);
    expect(v.addresses).toBe(false);
    expect(String(v.reason)).toContain("narrows_documented_contract:omitted group_by");
  });
  it("MUST-FAIL (b): an added test passing group_by EXPLICITLY (the default literal) is not omission evidence", async () => {
    const added = "    const r = await runTraceAggregateReport(db, { group_by: 'activity_id', limit: 1 }, AUTH);";
    const v = await gate(AGG_PATH, AGG_PRE, AGG_POST, AGG_DIFF, added);
    expect(v.addresses).toBe(false);
  });
  it("MUST-FAIL (b): a comment naming the omission is not a test", async () => {
    const v = await gate(AGG_PATH, AGG_PRE, AGG_POST, AGG_DIFF, "  // an omitted group_by keeps its default\n  expect(r.group_by).toBe('status');");
    expect(v.addresses).toBe(false);
  });
  it("MUST-FAIL (b): an unrelated `{ limit: 100 }` does not exercise the 500 -> 100 clamp", async () => {
    const v = await gate(ET_PATH, ET_PRE, ET_POST, ET_DIFF, "    const page = await list({ limit: 100 });");
    expect(v.addresses).toBe(false);
  });
  it("MUST-FAIL (P3): a nested Math.max lower bound (`Math.max(parseInt(x, 10), 1)`) is not read as a maximum", async () => {
    const from = "    const limit = Math.min(Math.max(parseInt(String(limitParam), 10), 1), 500);";
    const to = "    const limit = Math.min(Math.max(parseInt(String(limitParam), 10), 0), 500);";
    const pre = edit(ET_PRE, "    const limit = Math.min(Math.max(limitParam, 1), 500);", from);
    const v = await gate(ET_PATH, pre, edit(pre, from, to), unified(from, to));
    expect(v.addresses).toBe(true);
  });
  it("MUST-FAIL (P2): an ADDED handler with its own cap is not compared with a maximum documented elsewhere", async () => {
    const anchor = "    const offset = Math.max(offsetParam, 0);";
    const handler = `${anchor}\n  });\n\napp.get('/recent', async (c) => {\n    const recentParam = parseInt(c.req.query('limit') || '20', 10);\n    const limit = Math.min(Math.max(recentParam, 1), 100);`;
    const v = await gate(ET_PATH, ET_PRE, edit(ET_PRE, anchor, handler), unified(anchor, "    const limit = Math.min(Math.max(recentParam, 1), 100);"));
    expect(v.addresses).toBe(true);
  });
  it("MUST-FAIL (P1 side effect): an outgoing `f({ limit: 1 })` is not a read, so dropping the real read is still refused", async () => {
    const from = "  const limit = clampInt(input.limit, 10, 1, 1000);";
    const to = "  const limit = 10;\n  const page = await fetchPage({ limit: 1 });";
    const v = await gate(AGG_PATH, AGG_PRE, edit(AGG_PRE, from, to), unified(from, to));
    expect(v.addresses).toBe(false);
    expect(String(v.reason)).toContain("narrows_documented_contract:documented limit no longer handled");
  });
  it("MUST-FAIL (P1): a shorthand destructuring (`const { limit } = input`) still handles the parameter", async () => {
    const from = "  const limit = clampInt(input.limit, 10, 1, 1000);";
    const to = "  const { limit } = input;";
    const v = await gate(AGG_PATH, AGG_PRE, edit(AGG_PRE, from, to), unified(from, to));
    expect(String(v.reason ?? "")).not.toContain("documented limit no longer handled");
  });
  it("MUST-FAIL (P1): a destructured read (`const { limit: rawLimit } = input`) still handles the parameter", async () => {
    const from = "  const limit = clampInt(input.limit, 10, 1, 1000);";
    const to = "  const { limit: rawLimit } = input;\n  const limit = clampInt(rawLimit, 10, 1, 1000);";
    const v = await gate(AGG_PATH, AGG_PRE, edit(AGG_PRE, from, to), unified(from, to));
    expect(v.addresses).toBe(true);
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
  it("CONTROL: the d4b09d0 narrowing whose added test calls the function WITHOUT group_by passes", async () => {
    const added = "    const r = await runTraceAggregateReport(db, { metric: 'count' }, AUTH);\n    expect(r.reason).toBe('unserved_group_by');";
    const v = await gate(AGG_PATH, AGG_PRE, AGG_POST, AGG_DIFF, added);
    expect(v.addresses).toBe(true);
  });
  it("CONTROL: the ddf9b46 narrowing carrying a limit test passes", async () => {
    const test = `it("caps the list limit at 100", async () => {\n  const res = await app.request("/?limit=101");\n  expect((await res.json()).limit).toBe(100);\n});`;
    const v = await gate(ET_PATH, ET_PRE, ET_POST, ET_DIFF, test);
    expect(v.addresses).toBe(true);
  });
});

// LINEAR TIME. cb6bb0b4's read pattern put whitespace quantifiers side by side (`\s*:\s*[…\s]+` then `\s*\)`), so a
// line like `({ limit }` + spaces + `:` + spaces backtracked polynomially: 4 KB took ~1.7 s, 16 KB minutes. A regex
// that hangs does not throw, so the floor would not fail closed — it would block the vessel's event loop on every
// landing of that file. The param-head, max and default patterns had the same adjacency (quadratic). Each 16 KB line
// below must be extracted in under 50 ms. It runs in a CHILD process with a hard timeout, so the red run on a
// backtracking tree is bounded: it is killed and fails, it does not hang the suite.
describe("the contract extract runs in linear time on pathological lines (must-fail at cb6bb0b4)", () => {
  it("MUST-FAIL: 16 KB whitespace lines (read, param head, max, default) each extract in under 50 ms", () => {
    // The vessel's modules may log at import, so stdout is silenced first and the result is one marked line. Each line
    // is timed as the best of three runs, so a GC pause or a loaded host is not read as backtracking.
    const script = `
      const write = process.stdout.write.bind(process.stdout);
      console.log = () => {}; console.info = () => {}; console.warn = () => {};
      const m = await import(${JSON.stringify(join(import.meta.dir, "../../src/resolvers/feature-compose.js"))});
      const et = await Bun.file(${JSON.stringify(join(FIX, "execution-traces.before-ddf9b46.excerpt.txt"))}).text();
      const sp = " ".repeat(8192);
      const lines = { read: "({ limit }" + sp + ":" + sp, head: sp + sp + "x = 1; // c", max: " * - limit: max" + sp + sp + ".", def: " * - offset: default" + sp + sp };
      m.contractNarrowings(et, et.replace("1), 500)", "1), 100)"));
      const out = {};
      for (const [k, l] of Object.entries(lines)) {
        const pre = l + "\\n" + et;
        let best = Infinity;
        for (let i = 0; i < 3; i++) {
          const t = performance.now();
          m.contractNarrowings(pre, pre.replace("1), 500)", "1), 100)"));
          best = Math.min(best, performance.now() - t);
        }
        out[k] = Math.round(best * 10) / 10;
      }
      write("\\nCN_LINEAR " + JSON.stringify(out) + "\\n");
    `;
    const r = Bun.spawnSync({ cmd: [process.execPath, "-e", script], stdout: "pipe", stderr: "pipe", timeout: 20_000 });
    const line = r.stdout.toString().split("\n").find((l) => l.startsWith("CN_LINEAR ")) ?? "";
    expect({ exited: r.exitCode, killed: r.signalCode ?? null, result: line !== "", stderr: line !== "" ? "" : r.stderr.toString().slice(-600) })
      .toEqual({ exited: 0, killed: null, result: true, stderr: "" });
    const ms = JSON.parse(line.slice("CN_LINEAR ".length)) as Record<string, number>;
    expect(Object.keys(ms).sort()).toEqual(["def", "head", "max", "read"]);
    for (const [k, v] of Object.entries(ms)) expect({ line: k, under50ms: v < 50, ms: v }).toMatchObject({ line: k, under50ms: true });
  }, 40_000);
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
  it("(1) contractFiles is read only by the deterministic floor, before the LLM prompt is built: the judge never sees it", () => {
    const src = readFileSync(join(import.meta.dir, "../../src/resolvers/feature-compose.ts"), "utf8");
    const body = src.slice(src.indexOf("export async function verifyPatchAddressesGap("));
    const fnBody = body.slice(0, body.indexOf("\n}\n"));
    const uses = [...fnBody.matchAll(/args\.(contractFiles|checkText)\b/g)].map((m) => m.index!);
    expect(uses.length).toBe(4);
    expect(Math.max(...uses)).toBeLessThan(fnBody.indexOf("semanticJudgePrompt("));
    const prompt = src.slice(src.indexOf("function semanticJudgePrompt("), src.indexOf("function semanticJudgePrompt(") + 600);
    expect(prompt).not.toMatch(/contractFiles|checkText/);
  });
  it("the evidence is only the test lines a change added: an untouched test file contributes nothing", () => {
    const path = "/vessels/repos/activity-api/src/routes/trace-aggregate-report.failure-class.test.ts";
    const t = fx("trace-aggregate-report.failure-class.test.before-d4b09d0.txt");
    expect(fc.contractAddedTestText([{ path, pre: t, post: t }])).toBe("");
    const added = "  it('an omitted group_by is refused', async () => {";
    expect(fc.contractAddedTestText([{ path, pre: t, post: `${t}\n${added}\n  // a comment` }])).toBe(added);
    expect(fc.contractAddedTestText([{ path: AGG_PATH, pre: AGG_PRE, post: AGG_POST }])).toBe("");
  });
  it("names exactly one narrowing per real landing", () => {
    expect((fc.contractNarrowings(AGG_PRE, AGG_POST) as Array<{ kind: string; param: string }>).map((n) => `${n.kind}:${n.param}`)).toEqual(["omitted_refused:group_by"]);
    expect((fc.contractNarrowings(ET_PRE, ET_POST) as Array<{ kind: string; param: string }>).map((n) => `${n.kind}:${n.param}`)).toEqual(["lowered_max:limit"]);
  });
});
