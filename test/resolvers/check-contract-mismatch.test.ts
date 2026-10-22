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

// AN EXPECTED VALUE NOTHING THE CHECK SUPPLIES CAN PRODUCE IS REFUSED BEFORE IT LANDS (2026-10-22).
//
// c2ab3e0 (substrate-authored, an activity-api lookup check) mocks the URL resolver and global.fetch so the search the
// function calls returns a hit WITHOUT its embedding, then expects the function to return the embedding
// [0.1, 0.2, 0.3, 0.4]. Nothing the check supplies carries those numbers, and neither does the module, so no code path
// can produce them: red forever, an assertion red, so it passed the verify and the arm guards. The rule
// (`check_asserts_contract_mismatch:expected_not_derivable`) refuses an equality assertion on a called export's result
// whose expected array or object literal shares not one datum with the check's own text (its mocks, fixtures and
// arguments) or the called module, when the check stands in for a dependency and reads no data from outside its text.
//
// FIXTURES: c2ab3e0's check verbatim, embedding-lookup-cache.ts as it was at c2ab3e0, and a control whose mocked hit
// carries the vector under a field the function does not read (red today, derivable); *-run-bun142.txt are bun 1.4.2
// runs of both (paths rewritten to /tmp/fx). The fixture vessel stubs the URL resolver the check mocks.
const EMB_REL = "src/lib/embedding-lookup-cache.ts";
const EMB_SRC = fixture("embedding-lookup-cache.at-c2ab3e0.ts.txt");
const EMB_STUBS: Record<string, string> = { "src/lib/prior-seed.ts": "export async function resolveConceptDbUrl(): Promise<string | null> { return null; }\n" };
const EMB_TREE = readerOf({ [EMB_REL]: EMB_SRC, ...EMB_STUBS });
const CHECK_C2A = fixture("c2ab3e0-embedding-lookup-cache.check.ts.txt");
const CHECK_DERIVABLE = fixture("derivable-embedding.check.ts.txt");
const REL_C2A = "test/checks/c2ab3e0-embedding-lookup-cache.check.ts";
const REL_DERIVABLE = "test/checks/derivable-embedding.check.ts";
const RUN_C2A = "c2ab3e0-run-bun142.txt";
const RUN_DERIVABLE = "derivable-embedding-run-bun142.txt";

describe("contractMismatchRefusal: an expected value nothing the check supplies can produce", () => {
  test("[FIXTURE] c2ab3e0's red compared the expected embedding with null at its own expect()", () => {
    const c = classify(fixture(RUN_C2A));
    expect(c.compared?.[0]).toMatchObject({ file: `/tmp/fx/${REL_C2A}`, line: 66, received: "null" });
  });

  test("[MUST-FAIL] c2ab3e0's check is refused: its expected embedding is in nothing it supplies", () => {
    expect(typeof refusal).toBe("function");
    const r = refusal!(CHECK_C2A, REL_C2A, classify(fixture(RUN_C2A)), EMB_TREE);
    expect(r).toMatchObject({ module: EMB_REL, fn: "lookupEmbeddingForSignature", reads: "expected_not_derivable" });
    expect(r!.reason).toContain("check_asserts_contract_mismatch:expected_not_derivable");
    expect(r!.reason).toContain("(0.1, 0.2, 0.3, 0.4)");
  });

  test("[CONTROL] the same check whose mocked hit carries the vector (red today, derivable) is not refused", () => {
    expect(typeof refusal).toBe("function");
    expect(refusal!(CHECK_DERIVABLE, REL_DERIVABLE, classify(fixture(RUN_DERIVABLE)), EMB_TREE)).toBeNull();
  });

  test("[CONTROL] no stand-in, a negated or non-equality matcher, an open literal, a datum in the module, or outside data decides nothing", () => {
    expect(typeof refusal).toBe("function");
    const run = classify(fixture(RUN_C2A));
    const edit = (from: string, to: string, src = CHECK_C2A): string => { expect(src).toContain(from); return src.replace(from, to); };
    // the stand-ins removed (line numbers kept): what the function reads is the real dependency's
    const real = edit("global.fetch = originalFetch;", "void originalFetch;", edit("global.fetch = mockFetch as any;", "void mockFetch;", edit("const mockFetch = mock(async", "const mockFetch = (async", edit("mock.module('../../src/lib/prior-seed',", "void ('../../src/lib/prior-seed',"))));
    expect(refusal!(real, REL_C2A, run, EMB_TREE)).toBeNull();
    expect(refusal!(edit("expect(result).toEqual(", "expect(result).not.toEqual("), REL_C2A, run, EMB_TREE)).toBeNull();
    expect(refusal!(edit("expect(result).toEqual(", "expect(result).toContain("), REL_C2A, run, EMB_TREE)).toBeNull();
    expect(refusal!(edit("[0.1, 0.2, 0.3, 0.4]", "[0.1, 0.2, 0.3, signature.length]"), REL_C2A, run, EMB_TREE)).toBeNull();
    expect(refusal!(CHECK_C2A, REL_C2A, run, readerOf({ [EMB_REL]: `${EMB_SRC}\nexport const SAMPLE = [0.4];\n`, ...EMB_STUBS }))).toBeNull();
    expect(refusal!(`${CHECK_C2A}\nconst recorded = readFileSync("search-hit.json", "utf8");\n`, REL_C2A, run, EMB_TREE)).toBeNull();
  });
});

describe("LIVE: the test_writing verify refuses an expectation nothing the check supplies can produce", () => {
  const verdictOf = async (gapId: string, check: string): Promise<Judgement> => {
    const root = mkdtempSync(join(tmpdir(), "contract-mismatch-derivable-"));
    for (const [rel, text] of Object.entries({ [EMB_REL]: EMB_SRC, ...EMB_STUBS, [`test/checks/${checkFile(gapId)}`]: check })) {
      mkdirSync(join(root, rel, ".."), { recursive: true });
      writeFileSync(join(root, rel), text);
    }
    return judge({ gapId, vesselRoot: root, editSite: null, run: runner(root), runs: 3 });
  };

  test("[MUST-FAIL] c2ab3e0's check is refused at the verify: check_asserts_contract_mismatch:expected_not_derivable", async () => {
    const j = await verdictOf("contract-mismatch-expected-not-derivable", CHECK_C2A);
    expect(j.ok).toBe(false);
    expect(j.stage).toBe("check_asserts_contract_mismatch");
    expect(j.reason).toContain("check_asserts_contract_mismatch:expected_not_derivable");
  });

  test("[CONTROL] the derivable check passes the verify", async () => {
    const j = await verdictOf("contract-mismatch-expected-derivable", CHECK_DERIVABLE);
    expect(j).toMatchObject({ ok: true, stage: null });
  });
});

// A PROPERTY READ ON A RETURN THAT IS NOT AN OBJECT IS REFUSED BEFORE IT LANDS (2026-10-22).
//
// goal-host 725638cc landed a goal-target inference check that reads `.shapes` off what inferGoalTargetShapes
// returns: `expect(Array.isArray(decision?.shapes) ? decision!.shapes : []).toContain("shellResult")`. The function is
// declared `Promise<string[]>` (its sibling inferGoalTargetDecision returns the object with `shapes`), so the read is
// undefined on every tree, the subject is [] whatever the fix, and the check is red forever: an assertion red, so it
// passed the verify. The rule (`check_asserts_contract_mismatch:property.<X>`) reads every named property the failing
// assertion's subject reads (through the locals it is computed from) off a called export's result, and refuses one the
// function's DECLARED return type can never have (arrays, primitives, null / undefined, and unions of those; a
// Promise<T> read as T when awaited), else the return walk's kinds when they hold no object.
//
// FIXTURES: 725638cc's check verbatim, goal-target-inference.ts as it was at 725638cc, and a control reading `.shapes`
// off inferGoalTargetDecision (an object return; red today too); *-run-bun142.txt are bun 1.4.2 runs of them (paths
// rewritten to /tmp/fx). The fixture vessel stubs the module's eight imports.
const GTI_REL = "src/goal-target-inference.ts";
const GTI_SRC = fixture("goal-target-inference.at-725638cc.ts.txt");
const GTI_TREE = readerOf({ [GTI_REL]: GTI_SRC });
const CHECK_725 = fixture("725638cc-goal-target-inference.check.ts.txt");
const CHECK_OBJECT_READ = fixture("object-return-read.check.ts.txt");
const REL_725 = "test/checks/725638cc-goal-target-inference.check.ts";
const REL_OBJECT_READ = "test/checks/object-return-read.check.ts";
const RUN_725 = "725638cc-run-bun142.txt";
const RUN_OBJECT_READ = "object-return-read-run-bun142.txt";

describe("contractMismatchRefusal: a property read on a return that is not an object", () => {
  test("[FIXTURE] 725638cc's red is its own toContain(), Received []", () => {
    const c = classify(fixture(RUN_725));
    expect(c.compared?.[0]).toMatchObject({ file: `/tmp/fx/${REL_725}`, line: 23, received: "[]" });
  });

  test("[MUST-FAIL] 725638cc's check is refused: .shapes off a function declared Promise<string[]>", () => {
    expect(typeof refusal).toBe("function");
    const r = refusal!(CHECK_725, REL_725, classify(fixture(RUN_725)), GTI_TREE);
    expect(r).toMatchObject({ module: GTI_REL, fn: "inferGoalTargetShapes", reads: "property.shapes" });
    expect(r!.reason).toContain("check_asserts_contract_mismatch:property.shapes");
    expect(r!.reason).toContain("declared Promise<string[]>");
  });

  test("[CONTROL] the same read off inferGoalTargetDecision (an object return) is not refused", () => {
    expect(typeof refusal).toBe("function");
    expect(refusal!(CHECK_OBJECT_READ, REL_OBJECT_READ, classify(fixture(RUN_OBJECT_READ)), GTI_TREE)).toBeNull();
  });

  test("[CONTROL] an array member, an un-awaited Promise, or an undeclared open return decides nothing", () => {
    expect(typeof refusal).toBe("function");
    const run = classify(fixture(RUN_725));
    const edit = (from: string, to: string, src = CHECK_725): string => { expect(src).toContain(from); return src.replace(from, to); };
    // a real member of the declared array kind
    expect(refusal!(edit("Array.isArray(decision?.shapes) ? decision!.shapes : []", "decision.length > 0 ? decision : []"), REL_725, run, GTI_TREE)).toBeNull();
    // the call's Promise itself (not awaited): then is a real member
    expect(refusal!(edit("const decision = await mod.inferGoalTargetShapes(goal, knownShapes);", "const decision = mod.inferGoalTargetShapes(goal, knownShapes);"), REL_725, run, GTI_TREE)).toBeNull();
    // no declared return type and a return walk that cannot close: decides nothing
    const undeclared = GTI_SRC.replace("  opts: InferGoalTargetShapesOpts = {},\n): Promise<string[]> {", "  opts: InferGoalTargetShapesOpts = {},\n) {");
    expect(undeclared).not.toBe(GTI_SRC);
    expect(refusal!(CHECK_725, REL_725, run, readerOf({ [GTI_REL]: undeclared }))).toBeNull();
  });

  test("[MUST-FAIL] the read moved into a local the subject is computed from is still refused", () => {
    expect(typeof refusal).toBe("function");
    const run = classify(fixture(RUN_725));
    const edit = (from: string, to: string, src = CHECK_725): string => { expect(src).toContain(from); return src.replace(from, to); };
    const viaLocal = edit("    expect(Array.isArray(decision?.shapes) ? decision!.shapes : []).toContain(\"shellResult\");", "    const shapes = Array.isArray(decision?.shapes) ? decision!.shapes : []; expect(shapes).toContain(\"shellResult\");");
    expect(refusal!(viaLocal, REL_725, run, GTI_TREE)).toMatchObject({ reads: "property.shapes" });
  });
});

describe("LIVE: the test_writing verify refuses a property read on a return that is not an object", () => {
  const GTI_STUBS: Record<string, string> = {
    "src/registry-field.ts": "export function registryFieldFor(..._a: unknown[]): null { return null; }\nexport function registryRatioFor(..._a: unknown[]): null { return null; }\n",
    "src/verbatim-read.ts": "export function verbatimReadTarget(..._a: unknown[]): null { return null; }\n",
    "src/judge/shapes.ts": "export function isMutationShape(_s: string): boolean { return false; }\n",
    "src/read-goal.ts": "export function goalDemandsArtifact(_g: string): boolean { return false; }\nexport function isReadQuestionGoal(_g: string): boolean { return false; }\n",
    "src/shape-name.ts": "export function isShapeName(_s: string): boolean { return false; }\n",
    "src/beta-sample.ts": "export function betaSample(a: number, b: number): number { return a / (a + b); }\n",
    "src/described-producers.ts": "export type Candidate = unknown; export type ChooserTier = unknown; export type ShapeCatalog = unknown;\nexport function describedCandidatesBlock(..._a: unknown[]): string { return \"\"; }\nexport function lexicalChoice(..._a: unknown[]): null { return null; }\nexport function validity(..._a: unknown[]): null { return null; }\n",
    "src/novel-target.ts": "export type NovelTarget = unknown; export const NOVEL_OPTION = \"__novel__\"; export const RESIDUAL_OPTION = \"__residual__\";\nexport function parseNovel(..._a: unknown[]): null { return null; }\nexport function parseResidual(..._a: unknown[]): null { return null; }\n",
  };
  const verdictOf = async (gapId: string, check: string): Promise<Judgement> => {
    const root = mkdtempSync(join(tmpdir(), "contract-mismatch-property-"));
    for (const [rel, text] of Object.entries({ [GTI_REL]: GTI_SRC, ...GTI_STUBS, [`test/checks/${checkFile(gapId)}`]: check })) {
      mkdirSync(join(root, rel, ".."), { recursive: true });
      writeFileSync(join(root, rel), text);
    }
    return judge({ gapId, vesselRoot: root, editSite: null, run: runner(root), runs: 3 });
  };

  test("[MUST-FAIL] 725638cc's check is refused at the verify: check_asserts_contract_mismatch:property.shapes", async () => {
    const j = await verdictOf("contract-mismatch-property-on-array", CHECK_725);
    expect(j.ok).toBe(false);
    expect(j.stage).toBe("check_asserts_contract_mismatch");
    expect(j.reason).toContain("check_asserts_contract_mismatch:property.shapes");
  });

  test("[CONTROL] the object-return read passes the verify", async () => {
    const j = await verdictOf("contract-mismatch-property-on-object", CHECK_OBJECT_READ);
    expect(j).toMatchObject({ ok: true, stage: null });
  });
});

// A CHECK THAT CALLS ITS TARGET THROUGH A CAST IS REFUSED BEFORE IT LANDS (2026-10-22, user ruling: held until a gate
// refuses it).
//
// development-vessel 2182d140 landed a check calling `Number((mod as any).nonAttemptDelayMs(row))`: one row object where
// the function declares (baseMs, streak, maxMs, receiverMinMs = 0). The cast erased the signature, so the call
// typechecked and the check is red for the call on every tree, not for the defect. castCalleeRefusal refuses a call to
// a src export reached through a cast to any / unknown (`check_asserts_contract_mismatch:cast_callee:<fn>`), statically;
// the verify applies it after contractMismatchRefusal, so a check refused for its contract keeps that reason.
//
// FIXTURES: 2182d140's check verbatim, nonAttemptDelayMs as it was at 2182d140 (an excerpt), and a control making the
// same assertion through the typed call.
const GCS_REL = "src/resolvers/gap-check-supply.ts";
const GCS_SRC = fixture("gap-check-supply.at-2182d140.excerpt.ts.txt");
const GCS_TREE = readerOf({ [GCS_REL]: GCS_SRC });
const CHECK_2182 = fixture("2182d140-sequencing-condition.check.ts.txt");
const CHECK_TYPED = fixture("typed-callee.check.ts.txt");
const REL_2182 = "test/checks/a-ruled-sequencing-condition-has-no-shaped-field-the-check-s.check.ts";
const castRefusal = csa["castCalleeRefusal"] as undefined | ((source: string, checkRel: string, reader: Reader) => { module: string; fn: string; reason: string } | null);

describe("castCalleeRefusal: a call to the target through a cast to any / unknown", () => {
  test("[MUST-FAIL] 2182d140's check is refused: nonAttemptDelayMs reached through `(mod as any)`", () => {
    expect(typeof castRefusal).toBe("function");
    const r = castRefusal!(CHECK_2182, REL_2182, GCS_TREE);
    expect(r).toMatchObject({ module: GCS_REL, fn: "nonAttemptDelayMs" });
    expect(r!.reason).toContain("check_asserts_contract_mismatch:cast_callee:nonAttemptDelayMs");
    expect(r!.reason).toContain("(baseMs: number, streak: number, maxMs: number, receiverMinMs = 0)");
  });

  test("[CONTROL] the typed call is not refused", () => {
    expect(typeof castRefusal).toBe("function");
    expect(castRefusal!(CHECK_TYPED, REL_2182, GCS_TREE)).toBeNull();
  });

  test("[MUST-FAIL] every cast form that reaches the callee is refused", () => {
    expect(typeof castRefusal).toBe("function");
    const call = "Number((mod as any).nonAttemptDelayMs(row))";
    expect(CHECK_2182).toContain(call);
    for (const form of [
      "Number((mod as unknown as Record<string, (r: unknown) => number>)[\"nonAttemptDelayMs\"](row))",
      "Number((mod.nonAttemptDelayMs as any)(row))",
      "Number((<any>mod).nonAttemptDelayMs(row))",
      "Number(((mod as unknown) as any).nonAttemptDelayMs(row))",
      "Number((mod as unknown)[\"nonAttemptDelayMs\"](row))",
      "Number(((mod as unknown) as { nonAttemptDelayMs: (r: unknown) => number }).nonAttemptDelayMs(row))",
    ]) expect(castRefusal!(CHECK_2182.replace(call, form), REL_2182, GCS_TREE)?.fn).toBe("nonAttemptDelayMs");
    const aliased = CHECK_2182.replace(`  const delayMs = ${call};`, "  const f: any = mod.nonAttemptDelayMs;\n  const delayMs = Number(f(row));");
    expect(aliased).not.toBe(CHECK_2182);
    expect(castRefusal!(aliased, REL_2182, GCS_TREE)?.fn).toBe("nonAttemptDelayMs");
  });

  test("[CONTROL] a cast on an argument or a result, a cast to a real type, or a module outside src decides nothing", () => {
    expect(typeof castRefusal).toBe("function");
    const call = "Number((mod as any).nonAttemptDelayMs(row))";
    for (const form of [
      "Number(mod.nonAttemptDelayMs(row as any, 1, 60_000))",
      "(mod.nonAttemptDelayMs(0, 1, 60_000) as any)",
      "Number((mod as typeof mod).nonAttemptDelayMs(0, 1, 60_000))",
    ]) expect(castRefusal!(CHECK_2182.replace(call, form), REL_2182, GCS_TREE)).toBeNull();
    expect(castRefusal!(CHECK_2182.replace("../../src/resolvers/gap-check-supply", "../helpers/gap-check-supply"), REL_2182, readerOf({ "test/helpers/gap-check-supply.ts": GCS_SRC }))).toBeNull();
  });
});

describe("LIVE: the test_writing verify refuses a check that calls its target through a cast", () => {
  const verdictOf = async (gapId: string, check: string): Promise<Judgement> => {
    const root = mkdtempSync(join(tmpdir(), "contract-mismatch-cast-"));
    for (const [rel, text] of Object.entries({ [GCS_REL]: GCS_SRC, [`test/checks/${checkFile(gapId)}`]: check })) {
      mkdirSync(join(root, rel, ".."), { recursive: true });
      writeFileSync(join(root, rel), text);
    }
    return judge({ gapId, vesselRoot: root, editSite: null, run: runner(root), runs: 3 });
  };

  test("[MUST-FAIL] 2182d140's check is refused at the verify: check_asserts_contract_mismatch:cast_callee", async () => {
    const j = await verdictOf("contract-mismatch-cast-callee", CHECK_2182);
    expect(j.ok).toBe(false);
    expect(j.stage).toBe("check_asserts_contract_mismatch");
    expect(j.reason).toContain("check_asserts_contract_mismatch:cast_callee:nonAttemptDelayMs");
  });

  test("[CONTROL] the typed check passes the verify", async () => {
    const j = await verdictOf("contract-mismatch-typed-callee", CHECK_TYPED);
    expect(j).toMatchObject({ ok: true, stage: null });
  });
});
