// AN ARMED ONE-LINE-REGION GAP'S PLAN STAYS INSIDE THE REGION'S ENCLOSING DECLARATION, OR IS REFUSED BEFORE THE SUITE.
//
// An armed gap whose region is one literal line, occurring once in its edit site, got a 4-op draft: it changed a
// function's signature and three of its callers. 17 tests that were green on the parent went red on the draft, and the
// attempt failed in the suite before its own check ran. Nothing looked at where the plan's ops were before applying them.
//
// Expected:
//   - plan acceptance places each op against the region's enclosing declaration; a plan with ops outside it gets ONE
//     re-plan whose prompt names those ops and the declaration;
//   - a re-plan that still widens is refused before any op is applied (stage region_too_narrow, a terminal refusal, so
//     the lineage's failed-attempt budget is not spent), and the reason is recorded on the gap row as a failure lesson;
//   - CONTROL: a single op inside the enclosing declaration (the region's neighbour line) proceeds with one plan call;
//   - CONTROL: the same widening plan on a gap with no region proceeds exactly as before.
//
// The tools shell is a RECORDER: no command sent to it is ever run, and fs_write only records.
import { describe, it, expect, beforeEach, afterEach, afterAll } from "bun:test";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { isolateRuntimeRoot } from "../helpers/runtime-root.js";

// feature-compose captures its roots at module load: the helper gives this file its own temp roots regardless of load order.
const { root: ROOT, runtime: RUNTIME } = await isolateRuntimeRoot("fc-region-scope", { superRepo: true, who: "feature-compose-region-scope.test.ts" });

const fc = (await import("../../src/resolvers/feature-compose.js")) as Record<string, any>;

const VESSEL = "demo-vessel";
const SITE = "src/door.ts";
const SITE_REPO = `repos/${VESSEL}/${SITE}`;
const REGION = `const stamp = "DROP-LITERAL-REGION";`;
const SITE_TEXT = [
  "export function writeDropLine(path: string, line: string): string {",
  `  ${REGION}`,
  "  return path + stamp + line;",
  "}",
  "",
  "export function callerA(): string {",
  `  return writeDropLine("a", "x");`,
  "}",
  "",
  "export function callerB(): string {",
  `  return writeDropLine("b", "y");`,
  "}",
  "",
].join("\n");
// The write-door structure: the region is one literal line inside handleWrite, about 184 lines below the definition of
// writeDropLine, whose signature the widening plan changes along with its callers.
const DOOR = "src/write-door.ts";
const DOOR_REPO = `repos/${VESSEL}/${DOOR}`;
const DOOR_REGION = `const refused = "not in the goal's product";`;
const DOOR_TEXT = [
  "export function writeDropLine(path: string, line: string): string {",
  "  return path + line;",
  "}",
  "",
  ...Array.from({ length: 190 }, (_, i) => `export const pad${i} = ${i};`),
  "",
  "export function handleWrite(path: string): string {",
  `  ${DOOR_REGION}`,
  "  return writeDropLine(path, refused);",
  "}",
  "",
  "export function otherWriter(): string {",
  `  return writeDropLine("b", "y");`,
  "}",
  "",
].join("\n");
const DOOR_REGION_LINE = DOOR_TEXT.split("\n").findIndex((l) => l.includes(DOOR_REGION)) + 1;
// The live write-door layout for the repair rounds: the region at line 198 inside writeDropLine (197-199), a caller
// at line 382 inside templateRunRefused. A repair round grounded wide (the live round read lines 172-402) may SEE 382;
// only the edit set is held to the region's declaration.
const GH = "src/gh-door.ts";
const GH_REPO = `repos/${VESSEL}/${GH}`;
const GH_REGION = "goal not admitted as a change";
const GH_LINES: string[] = [];
for (let i = 1; i <= 196; i++) GH_LINES.push(`export const p${i} = ${i};`);
GH_LINES.push("export function writeDropLine(door: string, dropped: readonly string[], goalHash: string): string {");
GH_LINES.push(`  return "[write-door] dropped " + dropped.join(",") + ": ${GH_REGION} (door=" + door + ", goal_hash=" + goalHash + ")";`);
GH_LINES.push("}");
for (let i = 200; i <= 377; i++) GH_LINES.push(`export const q${i} = ${i};`);
GH_LINES.push("export function templateRunRefused(door: string, key: string, goalHash: string, record?: (l: string) => void): boolean {");
GH_LINES.push("  const keyed = [key];");
GH_LINES.push("  void keyed;");
GH_LINES.push("  // already refused in this dispatch");
GH_LINES.push(`  record?.(writeDropLine(door, keyed, goalHash) + "; already refused in this dispatch");`);
GH_LINES.push("  return true;");
GH_LINES.push("}");
for (let i = 385; i <= 402; i++) GH_LINES.push(`export const r${i} = ${i};`);
GH_LINES.push("");
const GH_TEXT = GH_LINES.join("\n");
const GH_CALLER_382 = GH_LINES[381]!;
const GH_SIGNATURE_197 = GH_LINES[196]!;
const GH_REGION_198 = GH_LINES[197]!;
// The verify's typecheck, failing at the caller: what a widened signature leaves behind, and what grounds the repair there.
const FAILING_VERIFY = `== install ==\n== resolve ==\nDRYRUN_EXIT=0\n== typecheck ==\n${GH}(382,12): error TS2554: Expected 4 arguments, but got 3.\nTC_EXIT=2\n== shape-dispatch ==\nSD_EXIT=0\n== tests ==\nSKIPPED_TYPECHECK_FAILED\n`;
const TOOLS = "http://tools.fixture/resolve";
const LLM = "http://llm.fixture/resolve";

const ORIGINAL_FETCH = globalThis.fetch;
const ORIGINAL_LOG = console.log;
const ORIGINAL_WARN = console.warn;
const ENV_KEYS = ["MITOSIS_PUSH_CLONE_DIR", "PARKED_LANDINGS_DIR", "GAP_STORE_ENDPOINT", "COMPOSE_SLOT_DIR", "COMPOSE_WS_DIR"] as const;
const saved: Record<string, string | undefined> = {};
type ToolCall = { type: string; command?: string; path?: string; old_string?: string };
let ws: string;
let calls: ToolCall[] = [];
let gapWrites: string[] = [];
let planOps: Array<Record<string, unknown>> = [];
let replanOps: Array<Record<string, unknown>> = [];
let planPrompts: string[] = [];
let repairFix: Record<string, unknown> | null = null;
let repairPrompts = 0;
let repairPromptText: string[] = [];
let failVerify = false;

beforeEach(async () => {
  ws = join(ROOT, `case-${Math.random().toString(36).slice(2, 10)}`);
  await mkdir(ws, { recursive: true });
  await rm(RUNTIME, { recursive: true, force: true });
  await mkdir(join(RUNTIME, VESSEL, "src"), { recursive: true });
  await writeFile(join(RUNTIME, VESSEL, "package.json"), "{\"name\":\"demo-vessel\"}\n");
  await writeFile(join(RUNTIME, VESSEL, SITE), SITE_TEXT);
  await writeFile(join(RUNTIME, VESSEL, DOOR), DOOR_TEXT);
  await writeFile(join(RUNTIME, VESSEL, GH), GH_TEXT);
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  process.env["MITOSIS_PUSH_CLONE_DIR"] = join(ws, "git", "vessels");
  process.env["PARKED_LANDINGS_DIR"] = join(ws, "parked");
  process.env["GAP_STORE_ENDPOINT"] = "http://gap-store.fixture/resolve";
  process.env["COMPOSE_SLOT_DIR"] = join(ws, "slots");
  process.env["COMPOSE_WS_DIR"] = join(ws, "compose-ws");
  calls = [];
  gapWrites = [];
  planPrompts = [];
  repairFix = null;
  repairPrompts = 0;
  repairPromptText = [];
  failVerify = false;
  console.log = () => {};
  console.warn = () => {};
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = typeof input === "string" ? input : String((input as { url?: string })?.url ?? input);
    let body: Record<string, any> = {};
    try { body = JSON.parse(String(init?.body ?? "{}")); } catch { /* empty */ }
    if (url === TOOLS) {
      const p = body?.impulse?.pointer ?? {};
      const call: ToolCall = { type: String(p.type ?? "") };
      if (typeof p.command === "string") call.command = p.command;
      if (typeof p.path === "string") call.path = p.path;
      if (typeof p.old_string === "string") call.old_string = p.old_string;
      calls.push(call);
      if (call.type === "shell" && (call.command ?? "").includes("find src")) return Response.json({ stdout: `${SITE}\npackage.json\n` });
      if (call.type === "fs_read") {
        try { return Response.json({ content: await Bun.file(String(p.path)).text() }); } catch { return Response.json({ error: "absent" }, { status: 404 }); }
      }
      if (call.type === "fs_write") return Response.json({ ok: true });
      if (failVerify && call.type === "shell" && (call.command ?? "").includes("== typecheck ==")) return Response.json({ stdout: FAILING_VERIFY });
      return Response.json({ stdout: "" });
    }
    if (url === LLM) {
      const prompt = String(body?.prompt ?? "");
      if (prompt.includes("decomposing a feature specification")) {
        planPrompts.push(prompt);
        const ops = prompt.includes("REGION SCOPE:") ? replanOps : planOps;
        return Response.json({ content: JSON.stringify({ summary: "fixture plan", touched_vessels: [`repos/${VESSEL}`], ops }) });
      }
      if (prompt.includes("Pick the SINGLE most-blocking error") && repairFix) {
        repairPrompts++;
        repairPromptText.push(prompt);
        return Response.json({ content: JSON.stringify(repairFix) });
      }
      return new Response("unavailable (test)", { status: 400 });
    }
    if (body?.pointer?.type === "vesselCapability") {
      const shape = String(body.pointer.shape ?? "");
      if (shape === "shellResult") return Response.json({ content: { vessels: [{ endpoint: "http://tools.fixture", resolve_endpoint: "/resolve", health_score: 1 }] } });
      if (shape === "llm_completion") return Response.json({ content: { vessels: [{ endpoint: "http://llm.fixture", resolve_endpoint: "/resolve", health_score: 1 }] } });
      return Response.json({ content: { vessels: [] } });
    }
    if (url.startsWith("http://gap-store.fixture")) {
      const t = String(body?.impulse?.pointer?.type ?? "");
      if (t === "substrateGap") return Response.json({ shape: "substrateGap", body: { gaps: [] } });
      gapWrites.push(JSON.stringify(body));
      return Response.json({ shape: "substrateGapWriteResult", body: { action: "noop" } });
    }
    return new Response("unavailable (test)", { status: 400 });
  }) as unknown as typeof fetch;
});

afterEach(async () => {
  globalThis.fetch = ORIGINAL_FETCH;
  console.log = ORIGINAL_LOG;
  console.warn = ORIGINAL_WARN;
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  await rm(ws, { recursive: true, force: true });
  await rm(RUNTIME, { recursive: true, force: true });
});
afterAll(async () => {
  globalThis.fetch = ORIGINAL_FETCH;
  console.log = ORIGINAL_LOG;
  console.warn = ORIGINAL_WARN;
  await rm(ROOT, { recursive: true, force: true });
});

function pointer(withRegion: boolean) {
  return {
    type: "feature_compose",
    spec: `Fix the drop stamp in ${SITE_REPO} so the written line carries the right stamp.`,
    verify_vessels: [`repos/${VESSEL}`],
    land: false,
    skip_push: true,
    directed: true,
    gap: {
      id: "fixture-gap-region-scope",
      summary: "fixture gap for the region scope check",
      classification_metadata: { falsifier: "class2", edit_site: SITE_REPO, ...(withRegion ? { region: REGION } : {}) },
    },
  };
}
const edit = (old_string: string, new_string: string) => ({ kind: "edit", path: SITE_REPO, old_string, new_string, rationale: "fixture" });
// The incident's plan: the signature (inside the enclosing declaration) plus two of its callers (outside it).
const WIDENING = [
  edit("export function writeDropLine(path: string, line: string): string {", "export function writeDropLine(path: string, line: string, sep = \"\"): string {"),
  edit(`  return writeDropLine("a", "x");`, `  return writeDropLine("a", "x", "-");`),
  edit(`  return writeDropLine("b", "y");`, `  return writeDropLine("b", "y", "-");`),
];
// A one-line fix on the region's neighbour line: inside the enclosing declaration.
const INSIDE = [edit("  return path + stamp + line;", "  return path + line + stamp;")];
const siteWrites = () => calls.filter((c) => (c.type === "fs_write" || c.type === "fs_edit") && (c.path ?? "").endsWith(`${VESSEL}/${SITE}`));
const stageOf = (r: { body?: unknown }) => (r.body as Record<string, unknown>)["stage"];

describe("an armed one-line-region gap's plan is placed against the region's enclosing declaration before apply", () => {
  it("[MUST-FAIL] a plan that edits the signature plus callers outside the declaration is refused before the suite, naming the region's declaration", async () => {
    planOps = WIDENING;
    replanOps = WIDENING;
    const r = await fc.resolveFeatureCompose(pointer(true));
    expect({ stage: stageOf(r), site_writes: siteWrites().length }).toEqual({ stage: "region_too_narrow", site_writes: 0 });
    const body = r.body as Record<string, unknown>;
    expect(String(body["error"])).toContain("ops 2,3 outside the region's enclosing declaration writeDropLine");
    expect(body["failure_kind"]).toBe("terminal_refusal");
  });

  it("[MUST-FAIL] the first widening plan gets ONE re-plan whose prompt names the ops outside and the declaration", async () => {
    planOps = WIDENING;
    replanOps = INSIDE;
    const r = await fc.resolveFeatureCompose(pointer(true));
    const replans = planPrompts.filter((p) => p.includes("REGION SCOPE:"));
    expect(replans.length).toBe(1);
    expect(replans[0]).toContain("ops 2,3 outside the region's enclosing declaration writeDropLine");
    expect(stageOf(r)).not.toBe("region_too_narrow");
    expect(siteWrites().length).toBeGreaterThan(0);
  });

  it("[MUST-FAIL] a re-plan that still widens records the named reason on the gap row as a failure lesson", async () => {
    planOps = WIDENING;
    replanOps = WIDENING;
    await fc.resolveFeatureCompose(pointer(true));
    expect(planPrompts.filter((p) => p.includes("REGION SCOPE:")).length).toBe(1);
    const lessonWrites = gapWrites.filter((w) => w.includes("failure_lessons") && w.includes("region_too_narrow"));
    expect(lessonWrites.length).toBeGreaterThan(0);
    expect(lessonWrites[0]).toContain("writeDropLine");
  });

  it("CONTROL: a single op inside the enclosing declaration proceeds with no re-plan", async () => {
    planOps = INSIDE;
    replanOps = WIDENING;
    const r = await fc.resolveFeatureCompose(pointer(true));
    expect(planPrompts.filter((p) => p.includes("REGION SCOPE:")).length).toBe(0);
    expect(stageOf(r)).not.toBe("region_too_narrow");
    expect(siteWrites().length).toBeGreaterThan(0);
  });

  it("CONTROL: the same widening plan on a gap with no region proceeds exactly as before", async () => {
    planOps = WIDENING;
    replanOps = INSIDE;
    const r = await fc.resolveFeatureCompose(pointer(false));
    expect(planPrompts.filter((p) => p.includes("REGION SCOPE:")).length).toBe(0);
    expect(stageOf(r)).not.toBe("region_too_narrow");
    expect(siteWrites().length).toBeGreaterThan(0);
    expect(gapWrites.filter((w) => w.includes("region_too_narrow")).length).toBe(0);
  });
});

function doorPointer() {
  return {
    type: "feature_compose",
    spec: `Fix the refused-write report in ${DOOR_REPO} so a refused store write is reported correctly.`,
    verify_vessels: [`repos/${VESSEL}`],
    land: false,
    skip_push: true,
    directed: true,
    gap: {
      id: "fixture-gap-region-scope-door",
      summary: "fixture gap for the region scope check, write-door structure",
      classification_metadata: { falsifier: "class2", edit_site: DOOR_REPO, region: DOOR_REGION },
    },
  };
}
const doorEdit = (old_string: string, new_string: string) => ({ kind: "edit", path: DOOR_REPO, old_string, new_string, rationale: "fixture" });
// The observed plan: the signature ~184 lines above the region, the caller inside the region's function, another caller.
const DOOR_WIDENING = [
  doorEdit("export function writeDropLine(path: string, line: string): string {", "export function writeDropLine(path: string, line: string, why = \"\"): string {"),
  doorEdit("  return writeDropLine(path, refused);", "  return writeDropLine(path, refused, \"store\");"),
  doorEdit(`  return writeDropLine("b", "y");`, `  return writeDropLine("b", "y", "");`),
];
const DOOR_INSIDE = [doorEdit("  return writeDropLine(path, refused);", "  return writeDropLine(path, \"refused: \" + refused);")];
const doorWrites = () => calls.filter((c) => (c.type === "fs_write" || c.type === "fs_edit") && (c.path ?? "").endsWith(`${VESSEL}/${DOOR}`));

describe("the write-door structure: a region inside one function, a signature ~184 lines away", () => {
  it("fixture: the region line sits about 184 lines below the signature the plan edits", () => {
    expect(DOOR_REGION_LINE - 1).toBeGreaterThanOrEqual(184);
  });
  it("[MUST-FAIL] the signature-plus-callers plan gets one re-plan naming ops 1,3 outside handleWrite, then is refused before the suite", async () => {
    planOps = DOOR_WIDENING;
    replanOps = DOOR_WIDENING;
    const r = await fc.resolveFeatureCompose(doorPointer());
    const replans = planPrompts.filter((p) => p.includes("REGION SCOPE:"));
    expect({ replans: replans.length, stage: stageOf(r), door_writes: doorWrites().length }).toEqual({ replans: 1, stage: "region_too_narrow", door_writes: 0 });
    expect(replans[0]).toContain("ops 1,3 outside the region's enclosing declaration handleWrite");
    expect(String((r.body as Record<string, unknown>)["error"])).toContain("outside the region's enclosing declaration handleWrite");
  });
  it("CONTROL (same address): an op inside handleWrite, on the region's neighbour line, proceeds with no re-plan", async () => {
    planOps = DOOR_INSIDE;
    replanOps = DOOR_WIDENING;
    const r = await fc.resolveFeatureCompose(doorPointer());
    expect(planPrompts.filter((p) => p.includes("REGION SCOPE:")).length).toBe(0);
    expect(stageOf(r)).not.toBe("region_too_narrow");
    expect(doorWrites().length).toBeGreaterThan(0);
  });
});

function ghPointer() {
  return {
    type: "feature_compose",
    spec: `Fix the drop line in ${GH_REPO} so a refused store write is reported as not in the goal's product.`,
    verify_vessels: [`repos/${VESSEL}`],
    land: false,
    skip_push: true,
    directed: true,
    gap: {
      id: "fixture-gap-region-scope-repair",
      summary: "fixture gap for the region scope check in repair rounds",
      classification_metadata: { falsifier: "class2", edit_site: GH_REPO, region: GH_REGION },
    },
  };
}
const ghEdit = (old_string: string, new_string: string) => ({ kind: "edit", path: GH_REPO, old_string, new_string, rationale: "fixture" });

describe("the repair rounds (fc-repair) hold their ops to the GAP's enclosing declaration, not to the repair window", () => {
  it("fixture: the region is line 198 inside writeDropLine (197-199) and the caller is line 382", () => {
    expect(GH_TEXT.split("\n").findIndex((l) => l.includes(GH_REGION)) + 1).toBe(198);
    expect(GH_SIGNATURE_197.startsWith("export function writeDropLine(")).toBe(true);
    expect(GH_CALLER_382).toContain("writeDropLine(door, keyed, goalHash)");
  });
  it("[MUST-FAIL] a repair round grounded wide enough to show line 382 edits the caller there: not applied, repairs end, the same named reason is recorded", async () => {
    planOps = [ghEdit(GH_REGION_198, GH_REGION_198.replace(GH_REGION, "not in the goal's product"))];
    replanOps = [];
    failVerify = true;
    repairFix = { file: GH_REPO, old_string: GH_CALLER_382, new_string: GH_CALLER_382.replace("goalHash)", "goalHash, \"\")") };
    const r = await fc.resolveFeatureCompose(ghPointer());
    expect(repairPrompts).toBeGreaterThan(0);
    // The repair window showed line 382: the bound below is not the window.
    expect(repairPromptText[0]).toMatch(/\b382\| /);
    expect({ caller_382_edits: calls.filter((c) => c.type === "fs_edit" && c.old_string === GH_CALLER_382).length, repair_rounds: repairPrompts })
      .toEqual({ caller_382_edits: 0, repair_rounds: 1 });
    expect(String((r.body as Record<string, unknown>)["region_repair_refused"])).toContain(`repair op ${GH_REPO}:382 outside the region's enclosing declaration writeDropLine`);
    // Recorded where the next attempt's drafter reads it: the gap row's failure_lessons, class region_repair_refused.
    expect(gapWrites.filter((w) => w.includes("failure_lessons") && w.includes("\"class\":\"region_repair_refused\"") && w.includes(`${GH_REPO}:382`) && w.includes("writeDropLine")).length).toBeGreaterThan(0);
  });
  it("CONTROL (same address): a repair-round op inside writeDropLine (line 197) is applied as before", async () => {
    planOps = [ghEdit(GH_REGION_198, GH_REGION_198.replace(GH_REGION, "not in the goal's product"))];
    replanOps = [];
    failVerify = true;
    repairFix = { file: GH_REPO, old_string: GH_SIGNATURE_197, new_string: GH_SIGNATURE_197.replace("goalHash: string)", "goalHash: string, _why = \"\")") };
    const r = await fc.resolveFeatureCompose(ghPointer());
    expect(repairPrompts).toBeGreaterThan(0);
    expect(calls.filter((c) => c.type === "fs_edit" && c.old_string === GH_SIGNATURE_197).length).toBeGreaterThan(0);
    expect((r.body as Record<string, unknown>)["region_repair_refused"]).toBeUndefined();
  });
  it("places a repair op by the declaration that holds it in the current text", () => {
    expect(typeof fc.repairOpOutsideRegion).toBe("function");
    const scope = { path: GH_REPO, declaration: "writeDropLine" };
    expect(fc.repairOpOutsideRegion({ path: GH_REPO, old_string: GH_CALLER_382 }, GH_TEXT, scope)).toBe(true);
    expect(fc.repairOpOutsideRegion({ path: GH_REPO, old_string: GH_SIGNATURE_197 }, GH_TEXT, scope)).toBe(false);
    expect(fc.repairOpOutsideRegion({ path: GH_REPO, start_line: 382, end_line: 382 }, GH_TEXT, scope)).toBe(true);
    expect(fc.repairOpOutsideRegion({ path: GH_REPO, start_line: 198, end_line: 198 }, GH_TEXT, scope)).toBe(false);
    expect(fc.repairOpOutsideRegion({ path: `repos/${VESSEL}/src/other.ts`, old_string: GH_SIGNATURE_197 }, GH_TEXT, scope)).toBe(true);
  });
});

describe("regionScopeWidening: op placement against the enclosing declaration", () => {
  it("places the signature inside, the callers and another file outside, and abstains when the region is not once", () => {
    expect(typeof fc.regionScopeWidening).toBe("function");
    const site = { path: SITE_REPO, text: SITE_TEXT, region: REGION };
    expect(fc.regionScopeWidening([...WIDENING, { kind: "edit", path: `repos/${VESSEL}/src/other.ts`, old_string: "x", new_string: "y" }], site))
      .toEqual({ declaration: "writeDropLine", lo: 1, hi: 4, outside: [2, 3, 4] });
    expect(fc.regionScopeWidening(INSIDE, site)?.outside).toEqual([]);
    expect(fc.regionScopeWidening(WIDENING, { ...site, region: "writeDropLine" })).toBeNull();
    expect(fc.regionScopeWidening(WIDENING, { ...site, region: "absent literal" })).toBeNull();
  });
});
