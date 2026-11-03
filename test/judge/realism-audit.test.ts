// THE REALISM AUDIT (the user's ruling, the cheapest version; ADVISORY; lane core src/judge/realism-audit.ts).
//
// Three hollow landings in one week were green at landing while exercising what production never sends or returns:
// a check whose request its entry's own parser refuses (no pointer.type), a fix that reads a field the callee's type
// lacks through an `as unknown as {…}` cast, and a fix that sets a verdict field to a literal. Nothing at landing
// tested realism. The activity realism_audit runs at landing verify, after the own check is green, and records a
// realismVerdict; it refuses nothing.
//   [MUST-FAIL, no new seam] the repair prompt for a verify whose realism audit read unrealistic names the audit's
//              signals as information (buildRepairPrompt, which exists at the parent, ignores the field there);
//   [MUST-FAIL] each measured case reads unrealistic by its own probe (entry_key, masked_callee, constant_verdict),
//              and each honest landing reads realistic, every run reproducing the five planted controls;
//   [MUST-FAIL] wiring: landing verify runs the audit on each touched vessel and carries the verdict on its verify result;
//   [CONTROL]  advisory: the audit's block in landing verify assigns no verdict and no gate, and returns nothing;
//   [CONTROL]  a compose with no fix diff is audited on its check only;
//   [CONTROL]  the judge (self-fact-reconcile) does not read realismVerdict;
//   [CONTROL]  the rules are the shaped realismPolicy: changing a field changes the verdict; a broken policy, or planted
//              controls that do not reproduce, read unknown (unjudged), never realistic;
//   [CONTROL]  a literal on a non-verdict field (enabled, dry_run), or a verdict literal under a branch, is not flagged.
// No LLM, no network; the typecheck runs in memory (nothing is written).
import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isolateRuntimeRoot } from "../helpers/runtime-root.js";

await isolateRuntimeRoot("realism-audit", { who: "realism-audit.test.ts" });
const fc = (await import("../../src/resolvers/feature-compose.js")) as Record<string, any>;

type Row = Record<string, any>;
const SRC = (rel: string) => readFileSync(join(import.meta.dir, "../..", rel), "utf8");
const UNREALISTIC = {
  shape: "realismVerdict", gap_id: "g-realism", vessel: "concept-db", verdict: "unrealistic",
  signals: [{ probe: "entry_key", detail: "the entry's parser (resolveImpulse in src/routes/impulses.ts:552) refuses a request without impulse.pointer.type or pointer.type", file: "test/checks/limit.check.ts", line: 9 }],
  probes: { entry_key: "flagged", masked_callee: "not_applicable", constant_verdict: "not_applicable" },
  planted: { reproduced: 5, of: 5, failed: [] }, policy: "default", ms: 12,
};
const fv = (extra: Row = {}): Row => ({ vessel: "concept-db", errors: "verify", exit_code: 1, ok: false, output: "error TS2304: Cannot find name 'x'.", stage: "own_check", ...extra });
async function audit(): Promise<Row> { return (await import("../../src/judge/realism-audit.js")) as Row; }
const policyOf = (p: Row = {}) => ({ ok: true as const, policy: { enabled_probes: ["entry_key", "masked_callee", "constant_verdict"], verdict_field_globs: ["*verified*", "*_ok", "passed", "reached", "valid"], cast_through_types: ["unknown"], masked_callee_diagnostics: ["2339", "2551"], budget_ms: 60_000, ...p }, source: "policy" as const, path: null });
const fixtureInput = async (name: string): Promise<Row> => ((await audit())["PLANTED_FIXTURES"] as Row[]).find((f) => f["name"] === name)!["input"];

describe("the repair prompt names the realism audit's finding", () => {
  it("[MUST-FAIL] an unrealistic verdict on the verify result is a field of the repair prompt, naming each signal", () => {
    const p = fc["buildRepairPrompt"](fv({ realism: UNREALISTIC }), "", null) as string;
    expect(p).toContain("REALISM AUDIT (advisory");
    expect(p).toContain("[entry_key] test/checks/limit.check.ts:9");
    expect(p).toContain("refuses a request without impulse.pointer.type or pointer.type");
  });
  it("[CONTROL] a realistic or unknown verdict adds nothing: the prompt is the one without it", () => {
    const without = fc["buildRepairPrompt"](fv(), "", null);
    for (const verdict of ["realistic", "unknown"]) expect(fc["buildRepairPrompt"](fv({ realism: { ...UNREALISTIC, verdict, signals: [] } }), "", null)).toBe(without);
  });
});

describe("realism_audit reproduces the measured cases and its planted controls", () => {
  it("[MUST-FAIL] each must-catch case reads unrealistic by its own probe, and each honest landing reads realistic", async () => {
    const m = await audit();
    const want: Array<[string, string, string | null]> = [
      ["planted:entry-key-omitted-pointer-type", "unrealistic", "entry_key"],
      ["planted:masked-callee-read", "unrealistic", "masked_callee"],
      ["planted:constant-verdict-literal", "unrealistic", "constant_verdict"],
      ["planted:honest-real-import-fix-and-check", "realistic", null],
      ["planted:honest-check-only", "realistic", null],
    ];
    for (const [name, verdict, probe] of want) {
      const v = await m["realismAudit"](await fixtureInput(name), { policy: policyOf() });
      expect({ name, verdict: v.verdict, probes: v.signals.map((s: Row) => s.probe) }).toEqual({ name, verdict, probes: probe ? (v.signals as Row[]).map(() => probe) : [] });
      if (probe) expect(v.signals.length).toBeGreaterThan(0);
      expect(v.planted).toEqual({ reproduced: 5, of: 5, failed: [] });
    }
  });
  it("[MUST-FAIL] the signals name the measured lie: the omitted key, the field the callee lacks, the literal verdict", async () => {
    const m = await audit();
    const ek = await m["realismAudit"](await fixtureInput("planted:entry-key-omitted-pointer-type"), { policy: policyOf() });
    expect(ek.signals[0].detail).toContain("impulse.pointer.type or pointer.type");
    expect(ek.signals[0].detail).toContain("Missing or invalid pointer.type");
    const mc = await m["realismAudit"](await fixtureInput("planted:masked-callee-read"), { policy: policyOf() });
    expect(mc.signals.some((s: Row) => /recordId/.test(s.detail) && /HoldDecision/.test(s.detail))).toBe(true);
    const cv = await m["realismAudit"](await fixtureInput("planted:constant-verdict-literal"), { policy: policyOf() });
    expect(cv.signals[0].detail).toContain("oracle_verified");
  });
  it("[CONTROL] a compose with no fix diff is audited on its check only", async () => {
    const m = await audit();
    const v = await m["realismAudit"](await fixtureInput("planted:entry-key-omitted-pointer-type"), { policy: policyOf() });
    expect(v.probes).toEqual({ entry_key: "flagged", masked_callee: "not_applicable", constant_verdict: "not_applicable" });
  });
  it("[CONTROL] the same request with pointer.type present reads realistic (the parser's key, not a syntax proxy)", async () => {
    const m = await audit();
    const input = await fixtureInput("planted:entry-key-omitted-pointer-type");
    const check = input["checks"][0];
    const fixed = { ...input, checks: [{ ...check, text: String(check.text).replace('pointer: { query: "q", limit: -1 }', 'pointer: { type: "conceptSearch", query: "q", limit: -1 }') }] };
    const v = await m["realismAudit"](fixed, { policy: policyOf() });
    expect(v.verdict).toBe("realistic");
    expect(v.probes["entry_key"]).toBe("clean");
  });
  it("[CONTROL] a literal on a non-verdict field, or a verdict literal under a branch, is not flagged", async () => {
    const m = await audit();
    const post = `export function plan(x: number) {\n  const a = { enabled: true, dry_run: true, size: x * 2 };\n  if (x > 0) return { passed: true, size: x };\n  return { ...a, valid: x > 1 };\n}\n`;
    const v = await m["realismAudit"]({ gap_id: null, vessel: null, root: null, checks: [], fix: [{ path: "src/plan.ts", pre: null, post }], read: () => null }, { policy: policyOf() });
    expect(v.verdict).toBe("realistic");
    expect(v.probes["constant_verdict"]).toBe("clean");
  });
});

describe("the rules are the shaped realismPolicy, and an unjudged run never reads realistic", () => {
  it("[CONTROL] a policy field change changes the verdict: without constant_verdict, or without its glob, the literal is not flagged", async () => {
    const m = await audit();
    const input = await fixtureInput("planted:constant-verdict-literal");
    expect((await m["realismAudit"](input, { policy: policyOf() })).verdict).toBe("unrealistic");
    const off = await m["realismAudit"](input, { policy: policyOf({ enabled_probes: ["entry_key", "masked_callee"] }) });
    expect(off.verdict).toBe("realistic");
    expect(off.probes["constant_verdict"]).toBe("disabled");
    expect(off.planted.of).toBe(4);
    expect((await m["realismAudit"](input, { policy: policyOf({ verdict_field_globs: ["passed"] }) })).verdict).toBe("unknown"); // its planted control no longer fires
  });
  it("[CONTROL] the policy is read at use time through the shaped-policy reader, with the documented defaults when absent", async () => {
    const m = await audit();
    // The shaped policies directory is a temp checkout of this test's own (never the live super clone's).
    const superDir = mkdtempSync(join(tmpdir(), "realism-policy-"));
    mkdirSync(join(superDir, ".git"), { recursive: true });
    try {
      const absent = await m["readRealismPolicy"]({ SUPER_REPO_DIR: superDir });
      expect(absent).toMatchObject({ ok: true, source: "default" });
      expect(absent.policy).toEqual(m["DEFAULT_REALISM_POLICY"]);
      mkdirSync(join(superDir, "policies"), { recursive: true });
      writeFileSync(join(superDir, "policies", "realismPolicy.json"), JSON.stringify({ enabled_probes: ["entry_key"], reason: "test" }));
      const read = await m["readRealismPolicy"]({ SUPER_REPO_DIR: superDir });
      expect(read).toMatchObject({ ok: true, source: "policy" });
      expect(read.policy.enabled_probes).toEqual(["entry_key"]);
      expect(read.policy.verdict_field_globs).toEqual(m["DEFAULT_REALISM_POLICY"].verdict_field_globs);
      writeFileSync(join(superDir, "policies", "realismPolicy.json"), JSON.stringify({ enabled_probe: ["entry_key"] }));
      expect((await m["readRealismPolicy"]({ SUPER_REPO_DIR: superDir })).ok).toBe(false);
    } finally { rmSync(superDir, { recursive: true, force: true }); }
  });
  it("[CONTROL] a broken policy reads unknown with its reason; planted controls that do not reproduce read unknown", async () => {
    const m = await audit();
    const input = await fixtureInput("planted:honest-check-only");
    const bad = await m["realismAudit"](input, { policy: { ok: false, why: "realismPolicy: unknown policy key \"x\"", path: null } });
    expect(bad.verdict).toBe("unknown");
    expect(bad.why).toContain("realismPolicy unreadable");
    const broken = [{ name: "planted:never-fires", expect: "unrealistic", probe: "constant_verdict", input }];
    const v = await m["realismAudit"](input, { policy: policyOf(), fixtures: broken });
    expect(v.verdict).toBe("unknown");
    expect(v.planted).toMatchObject({ reproduced: 0, of: 1 });
  });
  it("[CONTROL] the trace is the activity's, gradable: success = planted reproduced, the verdict a tag and the output", async () => {
    const m = await audit();
    const v = await m["realismAudit"](await fixtureInput("planted:masked-callee-read"), { policy: policyOf() });
    const t = m["realismAuditTrace"](v, { compose_execution_id: "exec-parent", nowIso: "2026-11-02T22:00:00.000Z" });
    expect(t).toMatchObject({ template_id: "development-vessel:realism_audit", success: true, composition_chain: ["exec-parent"] });
    expect(t.tags).toContain("realism_verdict:unrealistic");
    expect(t.tags).toContain("realism_planted:5/5");
    expect(t.metadata.output.verdict).toBe("unrealistic");
    expect(t.metadata.advisory).toBe(true);
  });
});

describe("wiring: advisory at landing verify, and the judge does not read it", () => {
  const fcSrc = SRC("src/resolvers/feature-compose.ts");
  const start = fcSrc.indexOf("// REALISM AUDIT (the user's ruling");
  const end = fcSrc.indexOf("// EXECUTING SHAPE-VOCABULARY GATE", start);
  const block = start >= 0 && end > start ? fcSrc.slice(start, end) : "";
  it("[MUST-FAIL] landing verify audits each touched vessel and carries the verdict on its verify result, before the semantic gate chain", () => {
    expect(block).toContain("await realismAudit(");
    expect(block).toContain("vr.realism = realism");
    expect(block).toContain("[fc-realism]");
    expect(block).toContain("postConsumerTrace(realismAuditTrace(");
    expect(fcSrc.indexOf("await realismAudit(")).toBeLessThan(fcSrc.indexOf("semantic_gate = shapeVocabRefusal ??"));
  });
  it("[CONTROL] advisory: the audit's block assigns no verdict and no gate, and returns nothing", () => {
    expect(block.length).toBeGreaterThan(0);
    expect(block).not.toMatch(/\bverdict\s*=[^=]/);
    expect(block).not.toMatch(/\bsemantic_gate\s*=[^=]/);
    // the only returns are inside the block's own small readers (arrow functions), never out of the compose
    expect(block.split("\n").filter((l) => /\breturn\b/.test(l) && !l.includes("=>"))).toEqual([]);
    expect(block).not.toMatch(/\bthrow\b/);
  });
  it("[CONTROL] the judge (self-fact-reconcile) does not read realismVerdict", () => {
    const judge = SRC("src/resolvers/self-fact-reconcile.ts");
    expect(judge.includes("realism")).toBe(false);
    expect(judge.includes("realismVerdict")).toBe(false);
  });
});
