// AN AUTO-AUTHORED BRIDGE NEVER FREEZES ONE GOAL'S VALUE AND NEVER CARRIES AN UNBINDABLE SLOT (CHANGE-37d; user ruling
// 2026-10-16T20:05:03Z, qa approved the adjusted design).
//
// author-producer mints ONE template per shape (auto-bridge-<shape>) that every later goal reuses. A value the authoring
// LLM copied from ITS goal into a non-file, non-content field was served to every later goal (RUN 1: pos 15's gap_id frozen
// into auto-bridge-gapDecomposition, served to pos 16 and 18); the validation fallback bound the goal text to a generic
// field; and a second authoring hit 409 already_exists, so the first won forever. The executor binds only {{impulse:<slot>}}
// and {{lifecycle.*}} in a task config, so such a value cannot be re-bound: the mint is refused.
//   [MUST-FAIL] (37d″) a concrete value in a field the producer's own resolver_schema does not declare constant is refused,
//               decided from the contract alone: a gap id, and a plain word ("summary") alike. No goal text is read.
//   [MUST-FAIL] a minted config carrying a slot the executor cannot bind ({{decompose_gap_id}}) is refused, by substrate-gap's
//               ONE definition of an unrendered binding token (the same one 32a's quoteUnrenderedTokens and the gap gate use).
//   [MUST-FAIL] the bridge id is keyed on its contract (shape, input shapes, config keys): same contract → same id; a
//               different one → a different id; never the bare auto-bridge-<shape>.
//   [MUST-FAIL] the validation fallback no longer binds the goal text to a generic field; an unbound one fails by name.
//   [CONTROL]   executor-bindable slots and contract-declared constants pass; an unknown or unreachable contract declares
//               nothing (fail closed); file and content fields keep today's rebinding;
//               gapDecomposition still has its direct producer (the satisfier / route), so refusing the bridge removes
//               only the frozen wrapper.
import { afterEach, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
const AP = (await import("../../src/resolvers/author-producer.js")) as Record<string, any>;
const SG = (await import("../../src/resolvers/substrate-gap.js")) as Record<string, any>;
const SRC = readFileSync(new URL("../../src/resolvers/author-producer.ts", import.meta.url), "utf8");

const known = (constant: string[] = []) => ({ known: true, constant, reason: "declared" });
const unknown = { known: false, constant: [] as string[], reason: "the producer declares no contract (known:false)" };
const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });
/** Answer resolver_schema at a fixture endpoint as a producer would. */
function serveContract(answer: unknown, status = 200): Array<Record<string, unknown>> {
  const asked: Array<Record<string, unknown>> = [];
  globalThis.fetch = (async (_u: unknown, init?: RequestInit) => {
    asked.push(JSON.parse(String(init?.body ?? "{}")));
    return status === 200 ? Response.json({ shape: "resolver_schema", body: answer }) : new Response("x", { status });
  }) as unknown as typeof fetch;
  return asked;
}

describe("an auto-authored bridge never freezes a per-call value: the producer's contract decides (37d″)", () => {
  it("[MUST-FAIL] a concrete value in a field the contract does not declare constant is refused", () => {
    expect(typeof AP["frozenFieldsUnderContract"]).toBe("function");
    const cfg = { type: "gapDecomposition", decompose_gap_id: "gap-pos15-frozen" };
    expect(AP.frozenFieldsUnderContract(cfg, known())).toEqual(["decompose_gap_id"]);
    expect(AP.frozenFieldsUnderContract(cfg, unknown)).toEqual(["decompose_gap_id"]);
    expect(SRC).toContain("const frozen = frozenFieldsUnderContract(candidate.task_config, contract);");
  });

  it("[MUST-FAIL] a plain word in an undeclared field is refused too (37d′ let it through by its wording)", () => {
    expect(AP.frozenFieldsUnderContract({ type: "x", format: "summary" }, known(["mode"]))).toEqual(["format"]);
  });

  it("[CONTROL] a field the contract declares constant may hold a concrete value", () => {
    expect(AP.frozenFieldsUnderContract({ type: "x", format: "summary", mode: "strict" }, known(["format", "mode"]))).toEqual([]);
  });

  it("[PARAPHRASE] no goal text is read: the verdict has no goal input at all, and the old wording rule is gone", () => {
    expect(AP.frozenFieldsUnderContract.length).toBe(2);
    expect(SRC).not.toMatch(/frozenGoalValueFields|IDENTIFIER_SHAPED|goalGapId/);
    const cfg = { type: "gapDecomposition", decompose_gap_id: "gap-A" };
    // the same candidate is judged identically whatever goal produced it, because no goal is an input
    expect(AP.frozenFieldsUnderContract(cfg, known())).toEqual(AP.frozenFieldsUnderContract({ ...cfg }, known()));
  });

  it("[CONTROL] producerContract reads the producer's resolver_schema and keeps only constant:true fields", async () => {
    const asked = serveContract({ shape: "x", known: true, fields: [{ name: "format", required: false, type: "string", constant: true }, { name: "repo", required: false, type: "string" }] });
    expect(await AP.producerContract("x", "http://producer.test/v2/impulses/resolve")).toEqual({ known: true, constant: ["format"], reason: "declared" });
    expect(asked[0]).toEqual({ impulse: { pointer: { type: "resolver_schema", shape: "x" } } });
  });

  it("[CONTROL] fail closed: known:false, an HTTP error, a throw, or no endpoint declare nothing", async () => {
    serveContract({ shape: "x", known: false });
    expect((await AP.producerContract("x", "http://producer.test/r")).known).toBe(false);
    serveContract({}, 503);
    expect((await AP.producerContract("x", "http://producer.test/r")).constant).toEqual([]);
    globalThis.fetch = (async () => { throw new TypeError("Unable to connect"); }) as unknown as typeof fetch;
    expect((await AP.producerContract("x", "http://producer.test/r")).known).toBe(false);
    expect(await AP.producerContract("x", null)).toEqual({ known: false, constant: [], reason: "no producer endpoint for its resolver_schema" });
  });

  it("[HELD-OUT] git_log (a shape outside the design set): a contract marking `format` constant allows it, and `repo` stays a per-call input", () => {
    expect(AP.frozenFieldsUnderContract({ type: "git_log", format: "%h %s", repo: "development-vessel" }, known(["format"]))).toEqual(["repo"]);
  });

  it("[MUST-FAIL] a slot the executor cannot bind is refused, by the gap gate's one definition", () => {
    expect(typeof AP["unbindableTokens"]).toBe("function");
    expect(AP.unbindableTokens([{ config: { decompose_gap_id: "{{decompose_gap_id}}" } }])).toEqual(["{{decompose_gap_id}}"]);
    expect(SG.unrenderedBindingToken("{{decompose_gap_id}}")).toBe("{{decompose_gap_id}}");
    expect(SRC).toContain('import { unrenderedBindingToken } from "./substrate-gap.js";');
    expect(SRC).toContain('failure_mode: "unbindable_slot"');
    // only the produce task (the authored config) is scanned; the bridge's own scaffolding tasks are not
    expect(SRC).toContain("const unbindable = unbindableTokens(produceTasks);");
  });

  it("[MUST-FAIL] the bridge id is its contract", () => {
    expect(typeof AP["bridgeTemplateId"]).toBe("function");
    const a = AP.bridgeTemplateId("gapDecomposition", ["goal"], { type: "gapDecomposition", decompose_gap_id: "{{impulse:gap}}" });
    expect(a).toMatch(/^auto-bridge-gapDecomposition-[0-9a-f]{8}$/);
    expect(AP.bridgeTemplateId("gapDecomposition", ["goal"], { decompose_gap_id: "{{impulse:other}}", type: "x" })).toBe(a);
    expect(AP.bridgeTemplateId("gapDecomposition", ["goal", "substrateGap"], { decompose_gap_id: "{{impulse:gap}}" })).not.toBe(a);
    expect(SRC).not.toContain("id: `auto-bridge-${shape}`,");
    expect(SRC).toContain("reused: true");
  });

  it("[MUST-FAIL] the validation fallback binds no goal text; an unbound generic field fails by name", () => {
    expect(SRC).not.toContain('out[key] = fileFromGoal ?? pointer.goal ?? "test";');
    expect(SRC).toContain("have no binding (a generic placeholder is never filled from the goal text)");
  });

  it("[CONTROL] bindable slots and genuine constants pass; file and content fields are not frozen values; the direct producer remains", () => {
    expect(typeof AP["unbindableTokens"]).toBe("function");
    expect(AP.unbindableTokens([{ config: { path: "{{impulse:file}}", note: "{{lifecycle.taskId}}", mode: "strict" } }])).toEqual([]);
    expect(AP.frozenFieldsUnderContract({ type: "x", path: "gap-pos15-frozen", content: "gap-pos15-frozen", note: "{{impulse:n}}" }, known())).toEqual([]);
    const cfgSrc = readFileSync(new URL("../../src/config.ts", import.meta.url), "utf8");
    expect(cfgSrc).toContain('"gapDecomposition"');
    const routes = readFileSync(new URL("../../src/routes/impulses.ts", import.meta.url), "utf8");
    expect(routes).toContain('case "gapDecomposition": {');
  });
});
