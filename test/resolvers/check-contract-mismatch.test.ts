// A CHECK RED ON A CONTRACT ITS TARGET DOES NOT HAVE IS REFUSED AT THE VERIFY (2026-10-20).
//
// 333be5f (substrate-authored, template-input-lint harness-check-scenario) landed a check that calls
// resolveTemplateInputLintScan and asserts `result.shape` is "template_input_lint_issues" and `result.body.unusedInputs`
// holds the unused inputs. The resolver returns shape "templateInputLintReport" and a body with no unusedInputs, so the
// check is red on every tree whatever the fix. It is an expect() assertion red, so the shared classifier
// (retry-evidence.ts classifyCheckRun) called it a reproduction and the verify (judgeTestWritingCheck) passed it.
//
// THE CONTRACT: classifyCheckRun keeps, beside each assertion failure, the values bun printed and where the failing
// expect() is (`compared`: Expected / Received, the stack frame's file:line:col); `failures` is unchanged. The verify
// refuses `check_asserts_contract_mismatch` (check-supply-admission.ts contractMismatchRefusal) when that assertion
// reads `.shape` and Received is a shape the called function returns while Expected is one it never names, or reads
// `.body.<X>`, Received is undefined, and no return's body sets X. A genuine red (a field the function does return, with
// the wrong value) still passes.
//
// FIXTURES: 333be5f's check file verbatim, and template-input-lint-scan.ts as it was at 333be5f, both as .txt. The
// fixture vessel stubs the site's two dependencies (SEED_TEMPLATES is empty and selfAuthHeaders sends no key), so no
// run here scans the real templates or posts anything: 333be5f's check passes no dry_run and would POST gap rows to the
// live store when run against the real tree. The *-run-bun142.txt files are bun 1.4.2's output for the same checks
// (paths rewritten to /tmp/fx); the LIVE section re-runs them with the bun running this file.
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const FIX = join(import.meta.dir, "..", "fixtures", "check-contract-mismatch");
const fixture = (name: string): string => readFileSync(join(FIX, name), "utf8");
const csa = await import("../../src/resolvers/check-supply-admission.js") as Record<string, unknown>;
const re = await import("../../src/resolvers/retry-evidence.js") as Record<string, unknown>;
type Reader = { read: (rel: string) => string | null; list: (relDir: string) => string[] };
type Refusal = { test: string; module: string; fn: string; reads: string; reason: string } | null;
const refusal = csa["contractMismatchRefusal"] as undefined | ((source: string, checkRel: string, redReason: unknown, reader: Reader) => Refusal);
const classify = re["classifyCheckRun"] as (raw: string) => { failures: unknown[]; compared?: Array<Record<string, unknown>> };
type Judgement = { ok: boolean; stage: string | null; reason: string };
const judge = csa["judgeTestWritingCheck"] as (i: { gapId: string; vesselRoot: string; editSite: string | null; run: (rel: string) => Promise<string>; runs?: number }) => Promise<Judgement>;
const checkFile = csa["checkSupplyCheckFile"] as (id: string) => string;

const SITE_REL = "src/resolvers/template-input-lint-scan.ts";
const SITE_SRC = fixture("template-input-lint-scan.at-333be5f.ts.txt");
const CHECK_333 = fixture("333be5f-template-input-lint-harness-check-scenario.check.ts.txt");
const CHECK_BODY = fixture("body-field.check.ts.txt");
const CHECK_GENUINE = fixture("genuine-red.check.ts.txt");
const REL_333 = "test/checks/template-input-lint-development-vessel-harness-check-scenari.check.ts";
const STUBS: Record<string, string> = {
  "src/resolvers/types.ts": "export type ResolverResult = { shape: string; body: unknown };\n",
  "src/lib/self-auth.ts": "export function selfAuthHeaders(_url: string, _self: string): Record<string, string> { return {}; }\n",
  "src/seed/index.ts": "export const SEED_TEMPLATES: unknown[] = [];\n",
};
const readerOf = (files: Record<string, string>): Reader => ({ read: (rel) => files[rel] ?? null, list: (dir) => Object.keys(files).filter((f) => f.startsWith(`${dir.replace(/\/+$/, "")}/`)) });
const TREE = readerOf({ [SITE_REL]: SITE_SRC, ...STUBS });

describe("the classifier keeps what an assertion red compared (bun 1.4.2 fixtures)", () => {
  test("[MUST-FAIL] 333be5f's red: Expected / Received and the failing expect()'s frame are kept; the failure record is unchanged", () => {
    const c = classify(fixture("333be5f-run-bun142.txt"));
    expect(c.failures).toEqual([{ name: "template-input-lint-development-vessel-harness-check-scenario > detects unused template inputs", cls: "assertion", error: "error: expect(received).toBe(expected)" }]);
    expect(c.compared).toEqual([{ name: "template-input-lint-development-vessel-harness-check-scenario > detects unused template inputs", file: `/tmp/fx/${REL_333}`, line: 15, col: 26, expected: "\"template_input_lint_issues\"", received: "\"templateInputLintReport\"" }]);
  });

  test("[MUST-FAIL] a toEqual diff's sides are kept: the missing body field reads Received undefined", () => {
    const c = classify(fixture("body-field-run-bun142.txt"));
    expect(c.compared?.[0]).toMatchObject({ line: 16, col: 38, received: "undefined" });
  });
});

describe("contractMismatchRefusal (static, over the run's compared values)", () => {
  test("[MUST-FAIL] 333be5f's check is refused: the shape it expects is one the resolver never returns", () => {
    expect(typeof refusal).toBe("function");
    const r = refusal!(CHECK_333, REL_333, classify(fixture("333be5f-run-bun142.txt")), TREE);
    expect(r).toMatchObject({ module: SITE_REL, fn: "resolveTemplateInputLintScan", reads: "shape" });
    expect(r!.reason).toContain("check_asserts_contract_mismatch:shape");
    expect(r!.reason).toContain("\"templateInputLintReport\"");
  });

  test("[MUST-FAIL] a check reading a body field the resolver's body never sets is refused", () => {
    expect(typeof refusal).toBe("function");
    const r = refusal!(CHECK_BODY, "test/checks/body-field.check.ts", classify(fixture("body-field-run-bun142.txt")), TREE);
    expect(r).toMatchObject({ reads: "body.unusedInputs" });
    expect(r!.reason).toContain("finding_count");
  });

  test("[CONTROL] a genuine red (a field the resolver returns, with the wrong value) is not refused", () => {
    expect(typeof refusal).toBe("function");
    expect(refusal!(CHECK_GENUINE, "test/checks/genuine-red.check.ts", classify(fixture("genuine-red-run-bun142.txt")), TREE)).toBeNull();
  });

  test("[CONTROL] an open contract decides nothing: a return the parser cannot read, or a run with no compared values", () => {
    expect(typeof refusal).toBe("function");
    const delegating = SITE_SRC.replace(/return \{\n    shape: "templateInputLintReport",/, "if (pointer.idPattern === \"\\u0000\") return delegate(pointer);\n  return {\n    shape: \"templateInputLintReport\",");
    expect(delegating).not.toBe(SITE_SRC);
    const run = classify(fixture("333be5f-run-bun142.txt"));
    expect(refusal!(CHECK_333, REL_333, run, readerOf({ [SITE_REL]: delegating, ...STUBS }))).toBeNull();
    expect(refusal!(CHECK_333, REL_333, { ...run, compared: undefined }, TREE)).toBeNull();
    // the frame must be in the check: an assertion inside a helper module is not placed
    expect(refusal!(CHECK_333, REL_333, { ...run, compared: run.compared!.map((x) => ({ ...x, file: "/tmp/fx/test/helpers/x.ts" })) }, TREE)).toBeNull();
  });
});

/** One fixture vessel: the site (as at 333be5f), its stubs, and the gap's check file. */
function vessel(gapId: string, check: string): string {
  const root = mkdtempSync(join(tmpdir(), "contract-mismatch-"));
  for (const [rel, text] of Object.entries({ [SITE_REL]: SITE_SRC, ...STUBS, [`test/checks/${checkFile(gapId)}`]: check })) {
    mkdirSync(join(root, rel, ".."), { recursive: true });
    writeFileSync(join(root, rel), text);
  }
  return root;
}
const runner = (root: string) => async (rel: string): Promise<string> => {
  const p = Bun.spawnSync([process.execPath, "test", `./${rel}`, "--timeout", "20000"], { cwd: root, env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", TMPDIR: tmpdir(), NODE_ENV: "test", TZ: "UTC" }, stdout: "pipe", stderr: "pipe" });
  return new TextDecoder().decode(p.stdout) + new TextDecoder().decode(p.stderr);
};

describe("LIVE: the test_writing verify (judgeTestWritingCheck) with the bun running this file", () => {
  const verdict = async (gapId: string, check: string): Promise<Judgement> => {
    const root = vessel(gapId, check);
    // the instance's gap named no edit site: the src module the check imports becomes it
    return judge({ gapId, vesselRoot: root, editSite: null, run: runner(root), runs: 3 });
  };

  test("[MUST-FAIL] 333be5f's check is refused at the verify: check_asserts_contract_mismatch", async () => {
    const j = await verdict("template-input-lint-development-vessel_harness-check-scenario", CHECK_333);
    expect(j.ok).toBe(false);
    expect(j.stage).toBe("check_asserts_contract_mismatch");
    expect(j.reason).toContain("check_asserts_contract_mismatch:shape");
  });

  test("[MUST-FAIL] the body-field variant is refused at the verify", async () => {
    const j = await verdict("contract-mismatch-body-field", CHECK_BODY);
    expect(j.stage).toBe("check_asserts_contract_mismatch");
    expect(j.reason).toContain("body.unusedInputs");
  });

  test("[CONTROL] a genuine red passes the verify", async () => {
    const j = await verdict("contract-mismatch-genuine", CHECK_GENUINE);
    expect(j).toMatchObject({ ok: true, stage: null });
  });
});

// AN INVERTED CHECK IS REFUSED BEFORE IT LANDS (2026-10-21).
//
// A system test-writing compose landed checks that call an object-or-null classifier (it reads `kind`) with a field it
// never reads (`status`) and expect a STRING back: `expect(kindOf({ status: "green" })).toBe("green")`, once directly
// through `(mod as any).fn(…)` and once through a local alias `const classify: any = (mod as any).fn`. Each is an
// assertion red (Expected a string, Received null), so the verify passed it and the cutover committed it, and greening
// it would mean breaking the real classifier. The rule now also reads an assertion on the call's result ITSELF
// (`check_asserts_contract_mismatch:value`): Expected is a string the function can never return, and Received is a
// kind it does return. The callee is resolved through a cast and through one local alias.
//
// FIXTURES: settlement-kind.ts.txt (a classifier of that form, with the compared literal "non_attempt" in its module),
// the two inverted checks, and a control with the real signature and a reachable return; *-run-bun1314.txt are bun
// 1.3.14's runs of them (paths rewritten to /tmp/fx).
const KIND_REL = "src/resolvers/settlement-kind.ts";
const KIND_SRC = fixture("settlement-kind.ts.txt");
const KIND_TREE = readerOf({ [KIND_REL]: KIND_SRC });
const CHECK_INVERTED = fixture("inverted-value.check.ts.txt");
const CHECK_ALIASED = fixture("aliased-value.check.ts.txt");
const CHECK_REACHABLE = fixture("reachable-red.check.ts.txt");
const REL_INVERTED = "test/checks/inverted-value.check.ts";
const REL_ALIASED = "test/checks/aliased-value.check.ts";
const REL_REACHABLE = "test/checks/reachable-red.check.ts";

describe("contractMismatchRefusal: a value the called function never returns", () => {
  test("[FIXTURE] the inverted check's red compared a string with null at its own expect()", () => {
    const c = classify(fixture("inverted-value-run-bun1314.txt"));
    expect(c.compared?.[0]).toMatchObject({ file: `/tmp/fx/${REL_INVERTED}`, line: 8, expected: "\"green\"", received: "null" });
  });

  test("[MUST-FAIL] an inverted check through `(ns as any).fn(…)` is refused: a string from an object-or-null function", () => {
    expect(typeof refusal).toBe("function");
    const r = refusal!(CHECK_INVERTED, REL_INVERTED, classify(fixture("inverted-value-run-bun1314.txt")), KIND_TREE);
    expect(r).toMatchObject({ module: KIND_REL, fn: "settlementKindOf", reads: "value" });
    expect(r!.reason).toContain("check_asserts_contract_mismatch:value");
    expect(r!.reason).toContain("null | object");
  });

  test("[MUST-FAIL] the same through a local alias is refused, though the expected string is a literal in the module", () => {
    expect(typeof refusal).toBe("function");
    expect(KIND_SRC).toContain("\"non_attempt\"");
    const r = refusal!(CHECK_ALIASED, REL_ALIASED, classify(fixture("aliased-value-run-bun1314.txt")), KIND_TREE);
    expect(r).toMatchObject({ module: KIND_REL, fn: "settlementKindOf", reads: "value" });
    expect(r!.reason).toContain("\"non_attempt\"");
  });

  test("[CONTROL] the real signature with a reachable return (a string from a string function) is not refused", () => {
    expect(typeof refusal).toBe("function");
    expect(refusal!(CHECK_REACHABLE, REL_REACHABLE, classify(fixture("reachable-red-run-bun1314.txt")), KIND_TREE)).toBeNull();
  });

  test("[CONTROL] a negated matcher, a non-equality matcher, an open return, or a Received the function never returns decides nothing", () => {
    expect(typeof refusal).toBe("function");
    const run = classify(fixture("inverted-value-run-bun1314.txt"));
    expect(refusal!(CHECK_INVERTED.replace("expect(got).toBe(", "expect(got).not.toBe("), REL_INVERTED, run, KIND_TREE)).toBeNull();
    expect(refusal!(CHECK_INVERTED.replace("expect(got).toBe(", "expect(got).toContain("), REL_INVERTED, run, KIND_TREE)).toBeNull();
    const open = KIND_SRC.replace("if (!o || typeof o !== \"object\") return null;", "if (!o || typeof o !== \"object\") return fallback(o);");
    expect(open).not.toBe(KIND_SRC);
    expect(refusal!(CHECK_INVERTED, REL_INVERTED, run, readerOf({ [KIND_REL]: open }))).toBeNull();
    expect(refusal!(CHECK_INVERTED, REL_INVERTED, { ...run, compared: run.compared!.map((x) => ({ ...x, received: "\"green \"" })) }, KIND_TREE)).toBeNull();
  });
});

describe("LIVE: the test_writing verify refuses an inverted check before it lands", () => {
  const kindVessel = (gapId: string, check: string): string => {
    const root = mkdtempSync(join(tmpdir(), "contract-mismatch-value-"));
    for (const [rel, text] of Object.entries({ [KIND_REL]: KIND_SRC, [`test/checks/${checkFile(gapId)}`]: check })) {
      mkdirSync(join(root, rel, ".."), { recursive: true });
      writeFileSync(join(root, rel), text);
    }
    return root;
  };
  const verdict = async (gapId: string, check: string): Promise<Judgement> => {
    const root = kindVessel(gapId, check);
    return judge({ gapId, vesselRoot: root, editSite: null, run: runner(root), runs: 3 });
  };

  test("[MUST-FAIL] the inverted check is refused at the verify: check_asserts_contract_mismatch:value", async () => {
    const j = await verdict("contract-mismatch-inverted-value", CHECK_INVERTED);
    expect(j.ok).toBe(false);
    expect(j.stage).toBe("check_asserts_contract_mismatch");
    expect(j.reason).toContain("check_asserts_contract_mismatch:value");
  });

  test("[MUST-FAIL] the aliased inverted check is refused at the verify", async () => {
    const j = await verdict("contract-mismatch-aliased-value", CHECK_ALIASED);
    expect(j.stage).toBe("check_asserts_contract_mismatch");
    expect(j.reason).toContain("settlementKindOf");
  });

  test("[CONTROL] a check with the real signature and a reachable return passes the verify", async () => {
    const j = await verdict("contract-mismatch-reachable-value", CHECK_REACHABLE);
    expect(j).toMatchObject({ ok: true, stage: null });
  });
});

// A WRAPPER IS NOT A CONTRACT (2026-10-22).
//
// A landed system check bound `const res = await Promise.resolve((mod as any).fn(goal, dig))` and asserted
// `expect(res).toBe(true)` on a function that returns a verdict object or null. The rule resolved the callee of the
// outermost call, `Promise.resolve`, found no module behind it and decided nothing, so the check passed the verify and
// was armed. Every value-preserving pass-through is now looked through before the callee is resolved, for the value,
// shape and body rules alike: await, parentheses, `as` / `satisfies` / `!`, a one-argument Promise.resolve(x), and
// element i of an awaited Promise.all([…]) (inline or through a local), and a local that holds the call.
//
// FIXTURES: wrapped-boolean (that check's form against settlement-kind.ts.txt), wrapped-forms (one test per wrapper,
// each red Expected a primitive, Received null), wrapped-honest (wrapped calls whose expected kind IS returned), and
// their bun 1.3.14 runs.
const REL_WRAPPED_BOOL = "test/checks/wrapped-boolean.check.ts";
const REL_WRAPPED_FORMS = "test/checks/wrapped-forms.check.ts";
const REL_WRAPPED_HONEST = "test/checks/wrapped-honest.check.ts";
const CHECK_WRAPPED_BOOL = fixture("wrapped-boolean.check.ts.txt");
const CHECK_WRAPPED_FORMS = fixture("wrapped-forms.check.ts.txt");
const CHECK_WRAPPED_HONEST = fixture("wrapped-honest.check.ts.txt");
type Run = { failures: unknown[]; compared?: Array<Record<string, unknown>> };
const onlyFailure = (run: Run, name: string): Run => ({ ...run, compared: run.compared!.filter((x) => String(x["name"]).endsWith(`> ${name}`)) });

describe("contractMismatchRefusal looks through value-preserving wrappers", () => {
  test("[MUST-FAIL] `await Promise.resolve((ns as any).fn(…))` asserted toBe(true) on an object-or-null function is refused", () => {
    expect(typeof refusal).toBe("function");
    const r = refusal!(CHECK_WRAPPED_BOOL, REL_WRAPPED_BOOL, classify(fixture("wrapped-boolean-run-bun1314.txt")), KIND_TREE);
    expect(r).toMatchObject({ module: KIND_REL, fn: "settlementKindOf", reads: "value" });
    expect(r!.reason).toContain("expects true (a boolean)");
  });

  const run = classify(fixture("wrapped-forms-run-bun1314.txt"));
  for (const form of [
    "Promise.resolve inline",
    "Promise.all element, awaited in parentheses",
    "Promise.all element through a local, at a later index",
    "satisfies, as and a non-null assertion around Promise.resolve",
    "Promise.resolve of a local that holds the call",
  ]) {
    test(`[MUST-FAIL] ${form}: refused`, () => {
      expect(typeof refusal).toBe("function");
      const one = onlyFailure(run, form);
      expect(one.compared).toHaveLength(1);
      const r = refusal!(CHECK_WRAPPED_FORMS, REL_WRAPPED_FORMS, one, KIND_TREE);
      expect(r).toMatchObject({ module: KIND_REL, fn: "settlementKindOf", reads: "value" });
    });
  }

  test("[MUST-FAIL] the shape and body rules look through the same wrappers", () => {
    expect(typeof refusal).toBe("function");
    const viaResolve = CHECK_333.replace("const result = await mod.resolveTemplateInputLintScan({", "const result = await Promise.resolve(mod.resolveTemplateInputLintScan({").replace("    });\n\n    expect(result.shape)", "    }));\n\n    expect(result.shape)");
    expect(viaResolve).not.toBe(CHECK_333);
    expect(refusal!(viaResolve, REL_333, classify(fixture("333be5f-run-bun142.txt")), TREE)).toMatchObject({ reads: "shape" });
    const viaAll = CHECK_BODY.replace("const result = await mod.resolveTemplateInputLintScan({", "const result = (await Promise.all([mod.resolveTemplateInputLintScan({").replace("    });\n\n    expect(result.shape)", "    })]))[0];\n\n    expect(result.shape)");
    expect(viaAll).not.toBe(CHECK_BODY);
    expect(refusal!(viaAll, "test/checks/body-field.check.ts", classify(fixture("body-field-run-bun142.txt")), TREE)).toMatchObject({ reads: "body.unusedInputs" });
  });

  test("[CONTROL] an honest wrapped call whose expected kind the function returns is not refused", () => {
    expect(typeof refusal).toBe("function");
    expect(refusal!(CHECK_WRAPPED_HONEST, REL_WRAPPED_HONEST, classify(fixture("wrapped-honest-run-bun1314.txt")), KIND_TREE)).toBeNull();
  });

  test("[CONTROL] a wrapper that does not preserve the value decides nothing", () => {
    expect(typeof refusal).toBe("function");
    const bool = classify(fixture("wrapped-boolean-run-bun1314.txt"));
    // a two-argument call, a Promise.all index past the array, and a local binding that shadows Promise
    const twoArgs = CHECK_WRAPPED_BOOL.replace("(mod as any).settlementKindOf(evidence)\n", "(mod as any).settlementKindOf(evidence), 1\n");
    expect(twoArgs).not.toBe(CHECK_WRAPPED_BOOL);
    expect(refusal!(twoArgs, REL_WRAPPED_BOOL, bool, KIND_TREE)).toBeNull();
    const pastEnd = onlyFailure(run, "Promise.all element, awaited in parentheses");
    expect(refusal!(CHECK_WRAPPED_FORMS.replace("(mod as any).settlementKindOf(guess)]))[0]", "(mod as any).settlementKindOf(guess)]))[1]"), REL_WRAPPED_FORMS, pastEnd, KIND_TREE)).toBeNull();
    const shadowed = CHECK_WRAPPED_BOOL.replace("    const evidence = {", "    const Promise = { resolve: (_x: unknown) => true };\n    const evidence = {");
    const shifted = { ...bool, compared: bool.compared!.map((x) => ({ ...x, line: Number(x["line"]) + 1 })) };
    expect(refusal!(shadowed, REL_WRAPPED_BOOL, shifted, KIND_TREE)).toBeNull();
  });
});

describe("LIVE: the test_writing verify refuses a wrapped inverted check before it lands", () => {
  const verdictOf = async (gapId: string, check: string): Promise<Judgement> => {
    const root = mkdtempSync(join(tmpdir(), "contract-mismatch-wrapped-"));
    for (const [rel, text] of Object.entries({ [KIND_REL]: KIND_SRC, [`test/checks/${checkFile(gapId)}`]: check })) {
      mkdirSync(join(root, rel, ".."), { recursive: true });
      writeFileSync(join(root, rel), text);
    }
    return judge({ gapId, vesselRoot: root, editSite: null, run: runner(root), runs: 3 });
  };

  test("[MUST-FAIL] `await Promise.resolve(fn(…))` toBe(true) on an object-or-null function is refused at the verify", async () => {
    const j = await verdictOf("contract-mismatch-wrapped-boolean", CHECK_WRAPPED_BOOL);
    expect(j.ok).toBe(false);
    expect(j.stage).toBe("check_asserts_contract_mismatch");
    expect(j.reason).toContain("check_asserts_contract_mismatch:value");
  });

  test("[CONTROL] an honest wrapped check passes the verify", async () => {
    const j = await verdictOf("contract-mismatch-wrapped-honest", CHECK_WRAPPED_HONEST);
    expect(j).toMatchObject({ ok: true, stage: null });
  });
});
