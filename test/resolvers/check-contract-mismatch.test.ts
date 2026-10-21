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
