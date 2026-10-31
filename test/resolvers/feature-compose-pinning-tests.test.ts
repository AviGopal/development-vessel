// THE DRAFTER IS SHOWN THE EXISTING TESTS THAT PIN ITS EDIT SITE, READ-ONLY.
//
// Of 20 verify_failed attempts on both nodes in one night, 8 had their own check GREEN and failed in the suite: the
// draft broke existing tests that import the edit site, assert on the region's output text, or pin the call text of
// the region's function in another file. The drafter was shown the site and its own check, never those tests, and a
// draft that edits them is refused.
//
// Expected:
//   - the decompose prompt carries, read-only and labelled "existing tests that pin this site: keep these green", the
//     test files that import the edit site module, contain the region's text, or name the region's enclosing
//     declaration (also under src/), each with the assertion lines that match;
//   - CONTROL: with no pinning test, the prompt is byte-identical to the prompt with no test files at all;
//   - CONTROL: the gap's own check is not listed again (it is shown in its own block);
//   - CONTROL (cap): many pinning files stop at the file cap and the line cap, and the count is logged.
//
// Driven through resolveFeatureCompose (the existing export); the decompose prompt is read from the LLM fixture. The
// tools shell is a RECORDER: no command sent to it is ever run, and fs_write only records.
import { describe, it, expect, beforeEach, afterEach, afterAll } from "bun:test";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { isolateRuntimeRoot } from "../helpers/runtime-root.js";

// feature-compose captures its roots at module load: the helper gives this file its own temp roots regardless of load order.
const { root: ROOT, runtime: RUNTIME } = await isolateRuntimeRoot("fc-pinning-tests", { superRepo: true, who: "feature-compose-pinning-tests.test.ts" });

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
].join("\n");
// A test that imports the site and asserts on its output.
const PIN_IMPORT = "test/door-pin.test.ts";
const PIN_IMPORT_ASSERT = `    expect(writeDropLine("a", "x")).toBe("aDROP-LITERAL-REGIONx");`;
const PIN_IMPORT_TEXT = [
  'import { describe, expect, it } from "bun:test";',
  'import { writeDropLine } from "../src/door";',
  'describe("door", () => {',
  '  it("stamps the line", () => {',
  PIN_IMPORT_ASSERT,
  "  });",
  "});",
  "",
].join("\n");
// A test under src/ that never imports the site: it reads another file as text and pins the call text of writeDropLine.
const PIN_WIRING = "src/door-wiring.test.ts";
const PIN_WIRING_ASSERT = `  expect(src).toContain('return writeDropLine("a", "x");');`;
const PIN_WIRING_TEXT = [
  'import { expect, test } from "bun:test";',
  'const src = require("node:fs").readFileSync(`${import.meta.dir}/door.ts`, "utf8") as string;',
  'test("callerA keeps its call", () => {',
  PIN_WIRING_ASSERT,
  "});",
  "",
].join("\n");
// A test that pins nothing at the site.
const UNRELATED = "test/other.test.ts";
const UNRELATED_TEXT = [
  'import { expect, it } from "bun:test";',
  'import { otherThing } from "../src/other";',
  'it("other", () => { expect(otherThing()).toBe(2); });',
  "",
].join("\n");
const LABEL = "EXISTING TESTS THAT PIN THIS SITE: KEEP THESE GREEN";
const TOOLS = "http://tools.fixture/resolve";
const LLM = "http://llm.fixture/resolve";

const ORIGINAL_FETCH = globalThis.fetch;
const ORIGINAL_LOG = console.log;
const ORIGINAL_WARN = console.warn;
const ENV_KEYS = ["MITOSIS_PUSH_CLONE_DIR", "PARKED_LANDINGS_DIR", "GAP_STORE_ENDPOINT", "COMPOSE_SLOT_DIR", "COMPOSE_WS_DIR", "VESSELS_CLONE_ROOT"] as const;
const saved: Record<string, string | undefined> = {};
let ws: string;
let planPrompts: string[] = [];
let logs: string[] = [];
const INSIDE = [{ kind: "edit", path: SITE_REPO, old_string: "  return path + stamp + line;", new_string: "  return path + line + stamp;", rationale: "fixture" }];

const put = async (rel: string, text: string): Promise<void> => {
  const abs = join(RUNTIME, VESSEL, rel);
  await mkdir(dirname(abs), { recursive: true });
  await writeFile(abs, text);
};

beforeEach(async () => {
  ws = join(ROOT, `case-${Math.random().toString(36).slice(2, 10)}`);
  await mkdir(ws, { recursive: true });
  await rm(RUNTIME, { recursive: true, force: true });
  await mkdir(join(RUNTIME, VESSEL, "src"), { recursive: true });
  await writeFile(join(RUNTIME, VESSEL, "package.json"), "{\"name\":\"demo-vessel\"}\n");
  await writeFile(join(RUNTIME, VESSEL, SITE), SITE_TEXT);
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  process.env["MITOSIS_PUSH_CLONE_DIR"] = join(ws, "git", "vessels");
  process.env["PARKED_LANDINGS_DIR"] = join(ws, "parked");
  process.env["GAP_STORE_ENDPOINT"] = "http://gap-store.fixture/resolve";
  process.env["COMPOSE_SLOT_DIR"] = join(ws, "slots");
  process.env["COMPOSE_WS_DIR"] = join(ws, "compose-ws");
  // The clone root (the second root the tests are read from) is this case's empty dir: only RUNTIME holds tests.
  process.env["VESSELS_CLONE_ROOT"] = join(ws, "clone");
  planPrompts = [];
  logs = [];
  console.log = (...a: unknown[]) => { logs.push(a.map(String).join(" ")); };
  console.warn = () => {};
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = typeof input === "string" ? input : String((input as { url?: string })?.url ?? input);
    let body: Record<string, any> = {};
    try { body = JSON.parse(String(init?.body ?? "{}")); } catch { /* empty */ }
    if (url === TOOLS) {
      const p = body?.impulse?.pointer ?? {};
      const type = String(p.type ?? "");
      if (type === "shell" && String(p.command ?? "").includes("find src")) return Response.json({ stdout: `${SITE}\npackage.json\n` });
      if (type === "fs_read") {
        try { return Response.json({ content: await Bun.file(String(p.path)).text() }); } catch { return Response.json({ error: "absent" }, { status: 404 }); }
      }
      if (type === "fs_write") return Response.json({ ok: true });
      return Response.json({ stdout: "" });
    }
    if (url === LLM) {
      const prompt = String(body?.prompt ?? "");
      if (prompt.includes("decomposing a feature specification")) {
        planPrompts.push(prompt);
        return Response.json({ content: JSON.stringify({ summary: "fixture plan", touched_vessels: [`repos/${VESSEL}`], ops: INSIDE }) });
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

function pointer(ownCheck?: string) {
  return {
    type: "feature_compose",
    spec: `Fix the drop stamp in ${SITE_REPO} so the written line carries the right stamp.`,
    verify_vessels: [`repos/${VESSEL}`],
    land: false,
    skip_push: true,
    directed: true,
    gap: {
      id: "fixture-gap-pinning-tests",
      summary: "fixture gap for the pinning tests block",
      classification_metadata: {
        falsifier: "class2",
        edit_site: SITE_REPO,
        region: REGION,
        ...(ownCheck ? { evidence_resolve: { shape: "test_suite", input: { vessel: `repos/${VESSEL}`, test_file: ownCheck, only_tests: ["door > stamps the line"] }, zero_field: "requested_not_passing" } } : {}),
      },
    },
  };
}
const firstPrompt = async (p = pointer()): Promise<string> => {
  await fc.resolveFeatureCompose(p);
  expect(planPrompts.length).toBeGreaterThan(0);
  return planPrompts[0]!;
};
const pinSection = (prompt: string): string => {
  const at = prompt.indexOf(LABEL);
  return at < 0 ? "" : prompt.slice(at);
};

describe("the drafter is shown the existing tests that pin its edit site, read-only", () => {
  it("[MUST-FAIL] a test importing the site and a src/ test pinning its declaration's call text appear with their assertion lines", async () => {
    await put(PIN_IMPORT, PIN_IMPORT_TEXT);
    await put(PIN_WIRING, PIN_WIRING_TEXT);
    await put(UNRELATED, UNRELATED_TEXT);
    const prompt = await firstPrompt();
    expect(prompt).toContain(PIN_IMPORT_ASSERT.trim());
    expect(prompt).toContain(PIN_WIRING_ASSERT.trim());
    const section = pinSection(prompt);
    expect(section).toContain(LABEL);
    expect(section).toContain(`repos/${VESSEL}/${PIN_IMPORT}`);
    expect(section).toContain(`repos/${VESSEL}/${PIN_WIRING}`);
    expect(section).toMatch(/do not edit these tests/i);
    expect(section).not.toContain(UNRELATED);
  });

  it("CONTROL: with no pinning test nothing is added to the prompt (its bytes and hash are printed, to compare across the change)", async () => {
    await put(UNRELATED, UNRELATED_TEXT);
    const prompt = await firstPrompt();
    expect(prompt).not.toContain(LABEL);
    expect(prompt).not.toContain(UNRELATED);
    expect(prompt).not.toContain("otherThing");
    // Nor to the journal: the console of a compose no test pins is as before (the drafter-split golden pins it).
    expect(logs.filter((l) => l.startsWith("[fc-pin-tests]"))).toEqual([]);
    // Byte-identity is judged ACROSS the change: the same fixture's prompt is printed here at the parent and at the
    // change, and the two lines must be equal. Normalised: this run's temp paths, and the compose-lesson count lines
    // ("- (Nx) class: ..."), which come from the host's lesson store and change between runs whatever the code.
    const norm = prompt.split(ws).join("<ws>").split(ROOT).join("<root>").split("\n").filter((l) => !/^- \(\d+x\) /.test(l)).join("\n");
    ORIGINAL_LOG(`[pin-control] prompt bytes=${norm.length} sha256=${createHash("sha256").update(norm).digest("hex")}`);
  });

  it("CONTROL: the gap's own check is shown in its own block and not listed again as a pinning test", async () => {
    await put(PIN_IMPORT, PIN_IMPORT_TEXT);
    await put(PIN_WIRING, PIN_WIRING_TEXT);
    const prompt = await firstPrompt(pointer(PIN_IMPORT));
    expect(prompt).toContain(`THE GAP'S OWN CHECK — repos/${VESSEL}/${PIN_IMPORT}`);
    const section = pinSection(prompt);
    expect(section).toContain(`repos/${VESSEL}/${PIN_WIRING}`);
    expect(section).not.toContain(`repos/${VESSEL}/${PIN_IMPORT} (pins:`);
  });

  it("CONTROL (cap): many pinning files stop at the file and line caps, stay within one window, and the count is logged", async () => {
    const assertsPerFile = 20;
    for (let i = 0; i < 10; i++) {
      const asserts = Array.from({ length: assertsPerFile }, (_, j) => `    expect(writeDropLine("p${i}", "l${j}")).toContain("DROP-LITERAL-REGION");`);
      await put(`test/pin-${String(i).padStart(2, "0")}.test.ts`, ['import { expect, it } from "bun:test";', 'import { writeDropLine } from "../src/door";', 'it("pins", () => {', ...asserts, "});", ""].join("\n"));
    }
    const prompt = await firstPrompt();
    const section = pinSection(prompt);
    const headers = section.match(/^----- repos\/demo-vessel\/test\/pin-\d\d\.test\.ts \(pins:/gm) ?? [];
    expect(headers.length).toBe(6);
    expect(section).toContain("4 more pinning test file(s) not shown");
    const firstFile = section.slice(section.indexOf("----- repos/demo-vessel/test/pin-"));
    const firstBody = firstFile.slice(0, firstFile.indexOf("\n\n"));
    expect((firstBody.match(/^L\d+: /gm) ?? []).length).toBe(8);
    const blockEnd = section.indexOf("not shown (cap");
    expect(blockEnd).toBeGreaterThan(0);
    expect(blockEnd).toBeLessThanOrEqual(6000);
    const line = logs.find((l) => l.startsWith("[fc-pin-tests]"));
    expect(line).toBeDefined();
    expect(line!).toContain("10 pinning test file(s)");
    expect(line!).toContain("showed 6 (cap 6 files, 8 lines each");
  });
});

describe("regionFragments: what a test asserting on a region's output can contain", () => {
  it("a template-literal region splits at its holes; short pieces are dropped", () => {
    expect(typeof fc.regionFragments).toBe("function");
    const r = 'return `[write-door] dropped ${dropped.join(",")}: goal not admitted as a change (door=${door}, goal_hash=${goalHash})`;';
    expect(fc.regionFragments(r)).toEqual(["write-door] dropped", "goal not admitted as a change (door"]);
  });
  it("a region with no string literal is its own fragment; a multi-line region has none", () => {
    expect(typeof fc.regionFragments).toBe("function");
    expect(fc.regionFragments("if (refused.length > 0) return null;")).toEqual(["if (refused.length > 0) return null"]);
    expect(fc.regionFragments("a\nb")).toEqual([]);
  });
});
