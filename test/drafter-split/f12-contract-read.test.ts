// Checklist 2.1: the open drafter requests the callable return contract through the
// existing codeIntrospectResult field; the closed core clamps and fulfills it.
import { afterAll, describe, expect, it } from "bun:test";
import { readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { codeContract, resolveCodeIntrospect } from "../../src/resolvers/code-introspect.js";
import { classifyCheckRun } from "../../src/resolvers/retry-evidence.js";

const fc = await import("../../src/resolvers/feature-compose.ts");
const path = join(import.meta.dir, "contract-read-fixture.ts");
const workspaceRoot = resolve(import.meta.dir, "../..");
const introspectFixture = (pointer: Parameters<typeof resolveCodeIntrospect>[0]) => resolveCodeIntrospect(pointer, { workspaceRoot });
const source = `export function answer(): { shape: string; body: { count: number } } { return { shape: "Answer", body: { count: 42 } }; }\n`;
afterAll(() => { try { unlinkSync(path); } catch {} });

describe("drafter contract read request (checklist 2.1)", () => {
  it("clamps and preserves a contract request using only path and function", () => {
    const result = fc.clampDrafterReadPlan({
      reads: [{ kind: "contract", path: `repos/development-vessel/src/example.ts`, fn: "answer" }],
      lessonQueries: [],
      ancestorDepth: 0,
    }, { verifyVessels: ["repos/development-vessel"], targets: [], checkPaths: [] });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.reads).toEqual([{ kind: "contract", path: "repos/development-vessel/src/example.ts", fn: "answer" }]);
    const requests = Array.from({ length: 100 }, () => ({ kind: "contract", path: "repos/development-vessel/src/example.ts", fn: "answer" }));
    const bounded = fc.clampDrafterReadPlan({ reads: requests, lessonQueries: [], ancestorDepth: 0 }, { verifyVessels: ["repos/development-vessel"], targets: [], checkPaths: [] });
    expect(bounded.ok && bounded.reads.length * fc.MAX_DRAFT_CONTRACT_FACT_BYTES).toBeLessThanOrEqual(fc.MAX_DRAFT_READ_BYTES);
    expect(bounded.ok && bounded.reads.length).toBeLessThanOrEqual(fc.MAX_DRAFT_READS);
  });

  it("returns shapes, body keys, and kinds from codeIntrospectResult's shared contract", async () => {
    writeFileSync(path, source);
    const result = await introspectFixture({ type: "code_introspect", path, include_contract: true });
    expect(fc.drafterContractFactFromResult(result, "answer")).toEqual({
      shapes: ["Answer"], bodyKeys: ["count"], kinds: ["object"],
    });
    expect(fc.drafterContractFactFromResult(result, "missing")).toBeNull();
  });

  it("a partly open return is reported as null rather than inventing a contract", async () => {
    writeFileSync(path, `export function answer(value: unknown) { return value; }\n`);
    const result = await introspectFixture({ type: "code_introspect", path, include_contract: true });
    expect(fc.drafterContractFactFromResult(result, "answer")).toBeNull();
  });

  it("fulfills the bounded request into the facts passed to the assembler", async () => {
    writeFileSync(path, source);
    const factResult = await introspectFixture({ type: "code_introspect", path, include_contract: true });
    const requestedPath = "repos/development-vessel/src/example.ts";
    let shown: unknown;
    const emptyContext = {
      grounding: "", targetWindows: {}, priorFeedback: "", principles: "", composeLessons: "",
      netNewTargets: [], opBudgetHint: 24, journal: [], version: "test",
    };
    const result = await fc.draftContextThroughOpenModule({
      facts: { contents: {}, lessonHits: [] },
      scope: { verifyVessels: ["repos/development-vessel"], targets: [], checkPaths: [] },
      expect: { ceiling: 24, netNew: [], targets: [], targetContents: {}, mandatory: [], floorPrompt: "", prompts: () => ({ decompose: "", refine: "" }) },
      floorBudget: 24,
      readFile: async () => null,
      readContract: async (p: string) => p === requestedPath ? factResult : null,
      readGapRow: async () => null,
      lessonRows: async () => [],
      ancestorStart: "", selfId: "", variant: "drafter-v9-contract", mode: "default",
      load: async () => ({
        planDrafterReads: () => ({ reads: [{ kind: "contract", path: requestedPath, fn: "answer" }], lessonQueries: [], ancestorDepth: 0 }),
        assembleDrafterContext: (facts: unknown) => {
          shown = (facts as { contractFacts?: unknown }).contractFacts;
          return emptyContext;
        },
      }),
    });
    expect(result.record.fell_back).toBeNull();
    expect(shown).toEqual({ [`${requestedPath}#answer`]: { shapes: ["Answer"], bodyKeys: ["count"], kinds: ["object"] } });
  });

  it("the fact continues to come through the one extractor used by codeIntrospectResult", () => {
    const read = (p: string) => readFileSync(join(import.meta.dir, "..", "..", p), "utf8");
    const introspect = read("src/resolvers/code-introspect.ts");
    const admission = read("src/resolvers/check-supply-admission.ts");
    expect(introspect).toContain("exportContract(rel, reader)");
    expect(admission).toContain("returnedContract(ts, msf, target.fn)");
    expect(admission).toContain("returnedContract(ts, called.msf, called.fn)");
  });

  it("tracks the hollow-check fixture and the admission gate when the returned contract changes", async () => {
    const fixtureDir = join(import.meta.dir, "..", "fixtures", "check-contract-mismatch");
    const fixture = (name: string) => readFileSync(join(fixtureDir, name), "utf8");
    const sitePath = "src/resolvers/template-input-lint-scan.ts";
    const checkPath = "test/checks/template-input-lint-development-vessel-harness-check-scenari.check.ts";
    const check = fixture("333be5f-template-input-lint-harness-check-scenario.check.ts.txt");
    const run = classifyCheckRun(fixture("333be5f-run-bun142.txt"));
    const site = fixture("template-input-lint-scan.at-333be5f.ts.txt");
    const files: Record<string, string> = {
      [sitePath]: site,
      "src/resolvers/types.ts": "export type ResolverResult = { shape: string; body: unknown };\n",
      "src/lib/self-auth.ts": "export function selfAuthHeaders(_url: string, _self: string): Record<string, string> { return {}; }\n",
      "src/seed/index.ts": "export const SEED_TEMPLATES: unknown[] = [];\n",
    };
    const reader = (tree: Record<string, string>) => ({
      read: (rel: string) => tree[rel] ?? null,
      list: (dir: string) => Object.keys(tree).filter((p) => p.startsWith(`${dir.replace(/\/+$/, "")}/`)),
    });
    const factFor = (tree: Record<string, string>) => fc.drafterContractFactFromResult({
      shape: "codeIntrospectResult", body: { path: sitePath, contract: codeContract(sitePath, reader(tree)) },
    }, "resolveTemplateInputLintScan");
    const firstFact = factFor(files);
    expect(firstFact?.shapes).toContain("templateInputLintReport");
    expect(firstFact?.shapes).not.toContain("template_input_lint_issues");
    const admission = await import("../../src/resolvers/check-supply-admission.js");
    const firstRefusal = admission.contractMismatchRefusal(check, checkPath, run, reader(files));
    expect(firstRefusal?.reason).toContain('"templateInputLintReport"');

    const mutated = { ...files, [sitePath]: site.replace('shape: "templateInputLintReport"', 'shape: "ChangedTemplateReport"') };
    expect(mutated[sitePath]).not.toBe(site);
    const changedFact = factFor(mutated);
    expect(changedFact?.shapes).toContain("ChangedTemplateReport");
    expect(changedFact?.shapes).not.toContain("templateInputLintReport");
    const changedRun = { ...run, compared: run.compared?.map((row) => ({ ...row, received: '"ChangedTemplateReport"' })) };
    const changedRefusal = admission.contractMismatchRefusal(check, checkPath, changedRun, reader(mutated));
    expect(changedRefusal?.reason).toContain('"ChangedTemplateReport"');
  });
});
