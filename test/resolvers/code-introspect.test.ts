import { describe, it, expect, beforeAll } from "bun:test";
import { resolveCodeIntrospect } from "../../src/resolvers/code-introspect.js";
import { mkdirSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const testDir = join(tmpdir(), `dev-vessel-code-introspect-${Date.now()}`);
const sourceFile = join(testDir, "example.ts");

beforeAll(() => {
  mkdirSync(testDir, { recursive: true });
  writeFileSync(sourceFile, `export function hello() {\n  return "world";\n}\nexport function greet(name: string) {\n  return \`hi \${name}\`;\n}\n`);
  process.env["WORKSPACE_ROOT"] = testDir;
});

describe("code-introspect resolver", () => {
  it("returns codeIntrospectResult with lineCount", async () => {
    const result = await resolveCodeIntrospect({ type: "code_introspect", path: sourceFile });
    expect(result.shape).toBe("codeIntrospectResult");
    const body = result.body as { lineCount: number; matches: unknown[] };
    expect(body.lineCount).toBeGreaterThan(0);
    expect(Array.isArray(body.matches)).toBe(true);
  });

  it("finds a symbol and returns match extents (line + column)", async () => {
    const result = await resolveCodeIntrospect({
      type: "code_introspect",
      path: sourceFile,
      pattern: "function \\w+",
    });
    const body = result.body as { matches: Array<{ line: number; column: number; text: string }> };
    expect(body.matches.length).toBe(2);
    const first = body.matches[0];
    expect(first).toBeDefined();
    expect(first!.line).toBeGreaterThanOrEqual(1);
    expect(first!.column).toBeGreaterThanOrEqual(1);
    expect(first!.text).toContain("function");
  });

  it("returns empty matches when pattern is not found", async () => {
    const result = await resolveCodeIntrospect({
      type: "code_introspect",
      path: sourceFile,
      pattern: "class NotPresent",
    });
    const body = result.body as { matches: unknown[] };
    expect(body.matches.length).toBe(0);
  });

  it("respects maxMatches limit", async () => {
    const result = await resolveCodeIntrospect({
      type: "code_introspect",
      path: sourceFile,
      pattern: "function \\w+",
      maxMatches: 1,
    });
    const body = result.body as { matches: unknown[] };
    expect(body.matches.length).toBe(1);
  });
});

// THE OPT-IN CONTRACT (2026-10-22). codeIntrospectResult.body.contract, with include_contract: true, says what the
// module exports and how each function is called: parameters (name, type text, optional, default), the declared
// return type, the signature text and, where the return walk reads them, the returned kinds / shapes / body keys. It is
// read by the readers the check-supply guards use (check-supply-admission.ts exportContract), in-process, and a module
// exporting through an `export { … }` list, a re-export or a default is covered like a declaration. Without the
// opt-in the body is exactly what it was.
import { readFileSync } from "fs";
const fixture = (dir: string, name: string): string => readFileSync(join(import.meta.dir, "..", "fixtures", dir, name), "utf8");
type Entry = { name: string; kind: string; parameters?: Array<{ name: string; type: string | null; optional: boolean; default: string | null }>; returns?: string | null; signature?: string; returned?: { kinds: string[] | null; shapes: string[] | null; body_keys: string[] | null } };
const contractOf = async (path: string): Promise<{ exports: Entry[]; open: string | null }> => {
  const result = await resolveCodeIntrospect({ type: "code_introspect", path, include_contract: true });
  return (result.body as { contract: { exports: Entry[]; open: string | null } }).contract;
};
const entry = (c: { exports: Entry[] }, name: string): Entry | undefined => c.exports.find((e) => e.name === name);

describe("code-introspect contract (opt-in)", () => {
  it("[MUST-FAIL] a multi-line declaration gives its full parameters and return type (goal-target-inference.ts at 725638cc)", async () => {
    const p = join(testDir, "goal-target-inference.ts");
    writeFileSync(p, fixture("check-contract-mismatch", "goal-target-inference.at-725638cc.ts.txt"));
    const e = entry(await contractOf(p), "inferGoalTargetShapes");
    expect(e?.kind).toBe("function");
    expect(e?.parameters).toEqual([
      { name: "goal", type: "string", optional: false, default: null },
      { name: "knownShapes", type: "string[]", optional: false, default: null },
      { name: "opts", type: "InferGoalTargetShapesOpts", optional: true, default: "{}" },
    ]);
    expect(e?.returns).toBe("Promise<string[]>");
    expect(e?.signature).toBe("(goal: string, knownShapes: string[], opts: InferGoalTargetShapesOpts = {}): Promise<string[]>");
  });

  it("[MUST-FAIL] an export reached only through an export list or a re-export is in the contract with its signature", async () => {
    const dir = join(testDir, "reexp");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "index.ts"), fixture("check-references-missing-export", "goal-host-index.at-979b966d.excerpt.ts.txt"));
    const listed = entry(await contractOf(join(dir, "index.ts")), "verifyGoalReached");
    expect(listed?.kind).toBe("function");
    expect(listed?.returns).toBe("Promise<GoalReachVerdict | null>");
    expect(listed?.parameters?.slice(0, 3).map((x) => x.name)).toEqual(["goal", "producedShapes", "taskSummary"]);
    writeFileSync(join(dir, "a.ts"), `import { inner } from "./c";\nfunction local(n: number): string { return String(n); }\nexport { local as renamed, inner };\nexport { fromB } from "./b";\nexport * from "./d";\n`);
    writeFileSync(join(dir, "b.ts"), "export const fromB = (s: string): number => s.length;\n");
    writeFileSync(join(dir, "c.ts"), "export function inner(x: { id: string }): { shape: string; body: { ids: string[] } } { return { shape: \"idList\", body: { ids: [x.id] } }; }\n");
    writeFileSync(join(dir, "d.ts"), "export const fromD: (a: number, b: number) => number = (a, b) => a + b;\nexport const data = { k: 1 };\n");
    const c = await contractOf(join(dir, "a.ts"));
    expect(entry(c, "renamed")).toMatchObject({ kind: "function", signature: "(n: number): string", returns: "string" });
    expect(entry(c, "inner")).toMatchObject({ kind: "re-export", returns: "{ shape: string; body: { ids: string[] } }", returned: { kinds: ["object"], shapes: ["idList"], body_keys: ["ids"] } });
    expect(entry(c, "fromB")).toMatchObject({ kind: "re-export", signature: "(s: string): number" });
    expect(entry(c, "fromD")).toMatchObject({ kind: "const", signature: "(a: number, b: number) => number" });
    expect(entry(c, "data")).toEqual({ name: "data", kind: "const" });
  });

  it("[MUST-FAIL] a default export is in the contract with its signature", async () => {
    const p = join(testDir, "default.ts");
    writeFileSync(p, "export default function main(flag: boolean, n = 2): void {}\n");
    expect(entry(await contractOf(p), "default")).toMatchObject({ kind: "function", signature: "(flag: boolean, n = 2): void", parameters: [{ name: "flag", type: "boolean", optional: false, default: null }, { name: "n", type: null, optional: true, default: "2" }] });
    const q = join(testDir, "default-local.ts");
    writeFileSync(q, "const run = (x: string): string[] => [x];\nexport default run;\n");
    expect(entry(await contractOf(q), "default")).toMatchObject({ signature: "(x: string): string[]", returns: "string[]" });
  });

  it("[CONTROL] without the opt-in the body is exactly what it was: path, lineCount, pattern, matches, nothing else", async () => {
    const result = await resolveCodeIntrospect({ type: "code_introspect", path: sourceFile, pattern: "function \\w+" });
    expect(Object.keys(result.body as object)).toEqual(["path", "lineCount", "pattern", "matches"]);
    expect(JSON.stringify(result)).toBe(JSON.stringify({ shape: "codeIntrospectResult", body: { path: sourceFile, lineCount: 7, pattern: "function \\w+", matches: [{ line: 1, column: 8, text: "function hello" }, { line: 4, column: 8, text: "function greet" }] } }));
    const off = await resolveCodeIntrospect({ type: "code_introspect", path: sourceFile, include_contract: false });
    expect(Object.keys(off.body as object)).toEqual(["path", "lineCount", "pattern", "matches"]);
  });
});

// THE SIGNATURE READER ITSELF (check-supply-admission.ts exportSignatures), and ONE contract for both readers: the
// goal builder (gap-check-supply.ts exportListSentence) and codeIntrospectResult render the same exportContract, so
// for the same module the contract bytes are identical and the goal carries each signature verbatim.
const csa = (await import("../../src/resolvers/check-supply-admission.js")) as Record<string, unknown>;
const ci = (await import("../../src/resolvers/code-introspect.js")) as Record<string, unknown>;
type SrcReader = { read: (rel: string) => string | null; list: (dir: string) => string[] };
const memReader = (files: Record<string, string>): SrcReader => ({ read: (rel) => files[rel] ?? null, list: () => [] });

describe("exportSignatures", () => {
  it("[MUST-FAIL] a multi-line declaration, an overloaded export and an arrow export each give full parameters and return type", () => {
    const sigs = csa["exportSignatures"] as undefined | ((rel: string, r: SrcReader) => Map<string, { parameters: Array<{ name: string; type: string | null }>; returns: string | null; text: string }>);
    expect(typeof sigs).toBe("function");
    const gti = sigs!("src/goal-target-inference.ts", memReader({ "src/goal-target-inference.ts": fixture("check-contract-mismatch", "goal-target-inference.at-725638cc.ts.txt") }));
    expect(gti.get("inferGoalTargetShapes")).toMatchObject({ text: "(goal: string, knownShapes: string[], opts: InferGoalTargetShapesOpts = {}): Promise<string[]>", returns: "Promise<string[]>" });
    expect(gti.get("inferGoalTargetShapes")!.parameters.map((p) => `${p.name}:${p.type}`)).toEqual(["goal:string", "knownShapes:string[]", "opts:InferGoalTargetShapesOpts"]);
    const src = "export function pick(a: string): string;\nexport function pick(a: number,\n  b?: number): number;\nexport function pick(a: unknown, b?: number): unknown { return a ?? b; }\nexport const add = async (\n  x: number,\n  y: number,\n): Promise<number> => x + y;\n";
    const m = sigs!("src/m.ts", memReader({ "src/m.ts": src }));
    expect(m.get("pick")).toMatchObject({ text: "(a: string): string", returns: "string" });
    expect(m.get("add")).toMatchObject({ text: "(x: number, y: number): Promise<number>", returns: "Promise<number>" });
  });
});

describe("one contract for the goal builder and codeIntrospectResult", () => {
  it("[MUST-FAIL] the same module gives byte-identical contracts through both, and the goal carries each signature verbatim", async () => {
    const codeContract = ci["codeContract"] as undefined | ((rel: string, r: SrcReader) => unknown);
    expect(typeof codeContract).toBe("function");
    const text = fixture("check-contract-mismatch", "goal-target-inference.at-725638cc.ts.txt");
    const p = join(testDir, "one-contract.ts");
    writeFileSync(p, text);
    const viaResolver = (await resolveCodeIntrospect({ type: "code_introspect", path: p, include_contract: true })).body as { contract: { exports: Entry[] } };
    const viaGoalReader = codeContract!("src/goal-target-inference.ts", memReader({ "src/goal-target-inference.ts": text })) as { exports: Entry[] };
    expect(JSON.stringify(viaGoalReader)).toBe(JSON.stringify(viaResolver.contract));
    const supply = (await import("../../src/resolvers/gap-check-supply.js")) as { checkSupplyGoal: (v: string, t: string, s: string, site: string, r: SrcReader) => string };
    const goal = supply.checkSupplyGoal("goal-host-vessel", "test/checks/x.check.ts", "inferGoalTargetShapes misroutes", "repos/goal-host-vessel/src/goal-target-inference.ts", memReader({ "src/goal-target-inference.ts": text }));
    const e = viaResolver.contract.exports.find((x) => x.name === "inferGoalTargetShapes")!;
    expect(goal).toContain(`inferGoalTargetShapes: ${e.kind} ${e.signature}`);
  });

  it("[MUST-FAIL] both readers reach the contract through ONE exportContract: the goal builder through codeContract, codeContract through exportContract, and neither re-reads signatures itself", () => {
    const read = (rel: string): string => readFileSync(join(import.meta.dir, "..", "..", rel), "utf8");
    const goalSrc = read("src/resolvers/gap-check-supply.ts");
    const fn = goalSrc.slice(goalSrc.indexOf("export function exportListSentence("), goalSrc.indexOf("\n}\n", goalSrc.indexOf("export function exportListSentence(")));
    expect(fn).toContain("codeContract(siteRel, reader)");
    expect(fn).not.toMatch(/\b(?:exportSignatures|moduleExports|exportContract)\(/);
    const ciSrc = read("src/resolvers/code-introspect.ts");
    expect(ciSrc.match(/\bexportContract\(/g)?.length).toBe(1);
    expect(ciSrc).toContain("contract: codeContract(");
    expect(ciSrc).not.toMatch(/\b(?:exportSignatures|moduleExports)\(/);
  });
});
