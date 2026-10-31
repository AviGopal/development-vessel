// THE CHECK'S CALL PATH: A RED OWN CHECK TELLS THE NEXT ATTEMPT WHERE THE CHECK GOES, NOT ONLY WHERE NOT TO EDIT.
//
// Measured: of 8 lane src drafts with a valid red own check in a day, 7 edited code the check never exercises. The repair
// loop saw it (no_effect_vs_parent) and refused the wasted regions, but the next round got only that negative record;
// the red run's stack (and, for an expect() on a returned value, the check's own imports) was never turned into
// localization. Expected:
//   (i) a thrown error: the red run's frames under the vessel's src/ become the call path, repo-relative, with the
//       frame's function or the declaration enclosing its line; test files, node_modules and runtime frames do not;
//   (ii) no src frame on the stack: the src symbols the failing test's body calls through its imports, at their
//       declarations (a named import and a namespace member), and not the symbols only a passing test calls;
//   the path rides own_check.call_path on the attempt record (composeAttemptEvidence) and the prompt's record block
//   prints "the check's call path: <file>:<fn>:<line>, …" (attemptEvidenceBlock);
//   controls: a green run, or a red run that reaches no src symbol, adds no call-path line.
// Namespace imports, so the file loads on a tree without the new exports and each test fails by itself.
import { afterAll, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import * as RE from "../../src/resolvers/retry-evidence.js";
import * as FC from "../../src/resolvers/feature-compose.js";

const ROOT = mkdtempSync(join(tmpdir(), "call-path-"));
afterAll(() => rmSync(ROOT, { recursive: true, force: true }));
const put = (rel: string, text: string): void => { const abs = join(ROOT, rel); mkdirSync(dirname(abs), { recursive: true }); writeFileSync(abs, text); };
const files = new Map<string, string>();
const read = (rel: string): string | null => files.get(rel) ?? null;
const add = (rel: string, text: string): void => { files.set(rel, text); put(rel, text); };
const PREFIX = "repos/v/";

// A thrown error: bun prints the excerpt, the error line, then the stack, then the (fail) line.
const THROWN_RUN = [
  "test/checks/loader.check.ts:",
  " 5 | export function parse(s: string) {",
  " 6 |   if (!s) throw new Error(\"empty input\");",
  "                     ^",
  "error: empty input",
  "      at parse (/w/v/src/lib/parse.ts:6:17)",
  "      at <anonymous> (/w/v/src/lib/parse.ts:20:10)",
  "      at loadAll (/w/v/src/resolvers/load.ts:41:3)",
  "      at <anonymous> (/w/v/node_modules/pkg/src/index.ts:3:1)",
  "      at <anonymous> (/w/v/test/checks/loader.check.ts:9:5)",
  "      at run (node:async_hooks:144:29)",
  "(fail) loader > rejects an empty input [0.40ms]",
  "(pass) loader > control [0.02ms]",
  "",
  " 1 pass",
  " 1 fail",
].join("\n");
const PARSE_SRC = ["// parse", "", "", "", "export function parse(s: string) {", "  if (!s) throw new Error(\"empty input\");", "  return s;", "}", "", "", "", "", "", "", "", "", "", "export const helper = (x: string): string => {", "  const y = x.trim();", "  return parse(y);", "};"].join("\n");

// An expect() on a returned value: the only frames are the check file's and the runtime's.
const VALUE_RUN = [
  "test/checks/cart.check.ts:",
  "4 | test(\"total sums the cart\", () => { expect(fmt.money(total([1, 2]))).toBe(\"$3.00\"); });",
  "                                                                         ^",
  "error: expect(received).toBe(expected)",
  "",
  "Expected: \"$3.00\"",
  "Received: \"$0.00\"",
  "",
  "      at <anonymous> (/w/v/test/checks/cart.check.ts:4:73)",
  "      at run (node:async_hooks:144:29)",
  "(fail) total sums the cart [0.30ms]",
  "(pass) control [0.01ms]",
  "",
  " 1 pass",
  " 1 fail",
].join("\n");
const CART_CHECK = [
  "import { expect, test } from \"bun:test\";",
  "import { total, unused } from \"../../src/lib/calc.js\";",
  "import * as fmt from \"../../src/lib/format.js\";",
  "test(\"total sums the cart\", () => { expect(fmt.money(total([1, 2]))).toBe(\"$3.00\"); });",
  "test(\"control\", () => { expect(unused()).toBe(1); });",
].join("\n");
add("test/checks/cart.check.ts", CART_CHECK);
add("src/lib/calc.ts", ["// calc", "", "export function total(xs: number[]): number {", "  return 0;", "}", "export const unused = (): number => 1;"].join("\n"));
add("src/lib/format.ts", ["export function money(n: number): string {", "  return `$${n.toFixed(2)}`;", "}"].join("\n"));
add("src/lib/parse.ts", PARSE_SRC);

const GREEN_RUN = ["(pass) total sums the cart [0.30ms]", "(pass) control [0.01ms]", "", " 2 pass", " 0 fail"].join("\n");

const lessonWith = (callPath: unknown): Record<string, unknown> => ({
  at: "t1", class: "own_check_red", stage: "own_check", no_effect_vs_parent: true,
  edited_spans: [{ path: "repos/v/src/lib/other.ts", start: 3, end: 4, text_sha: "x", base: "y" }],
  own_check: { test_file: "test/checks/cart.check.ts", failing: [{ name: "total sums the cart" }], ...(callPath === undefined ? {} : { call_path: callPath }) },
});

describe("the prompt's record block carries the check's call path", () => {
  it("prints the latest red attempt's call path beside the refused regions", () => {
    const block = RE.attemptEvidenceBlock([lessonWith([{ path: "repos/v/src/lib/calc.ts", fn: "total", line: 3 }, { path: "repos/v/src/lib/format.ts", fn: "money", line: 1 }])]);
    expect(block).toContain("REFUSED REGIONS");
    expect(block).toContain("the check's call path: repos/v/src/lib/calc.ts:total:3, repos/v/src/lib/format.ts:money:1");
  });

  it("CONTROL: a record with no call path, or a malformed one read back from a row, prints no call-path line", () => {
    expect(RE.attemptEvidenceBlock([lessonWith(undefined)])).not.toContain("call path");
    expect(RE.attemptEvidenceBlock([lessonWith([{ path: "repos/v/src/`x`.ts", fn: "a", line: 1 }, { path: "repos/v/src/a.ts", fn: "b$(c)", line: 2 }])])).not.toContain("call path");
  });

  it("the attempt record carries the verify's call path on own_check", () => {
    const cp = [{ path: "repos/v/src/lib/calc.ts", fn: "total", line: 3 }];
    const v = { vessel: "repos/v", errors: "verify", exit_code: 0, ok: false, output: "", stage: "own_check", own: { test_file: "test/checks/cart.check.ts", failing: [{ name: "total sums the cart" }], no_effect_vs_parent: true, call_path: cp } } as unknown as FC.VerifyResult;
    const { record } = FC.composeAttemptEvidence([{ ok: true }], [], [v], false, null);
    expect(record.own_check?.call_path).toEqual(cp);
    const none = { ...v, own: { test_file: "test/checks/cart.check.ts", failing: [{ name: "total sums the cart" }] } } as unknown as FC.VerifyResult;
    expect(FC.composeAttemptEvidence([{ ok: true }], [], [none], false, null).record.own_check?.call_path).toBeUndefined();
  });
});

describe("(i) a thrown error: the red run's src frames", () => {
  it("maps the frames under the check's own tree to repo paths, with the frame's function or the enclosing declaration", () => {
    const path = RE.checkCallPathFromRun(THROWN_RUN, "test/checks/loader.check.ts", { prefix: PREFIX, read });
    expect(path).toEqual([
      { path: "repos/v/src/lib/parse.ts", fn: "parse", line: 6 },
      { path: "repos/v/src/lib/parse.ts", fn: "helper", line: 20 },
      { path: "repos/v/src/resolvers/load.ts", fn: "loadAll", line: 41 },
    ]);
  });

  it("is what ownCheckCallPath returns when the stack has src frames (the static path is not consulted)", () => {
    const path = FC.ownCheckCallPath({ raw: THROWN_RUN, test_file: "test/checks/loader.check.ts", only: [], failing: [{ name: "loader > rejects an empty input" }], vessel_root: "/w/v", prefix: PREFIX, read });
    expect(path.map((e) => `${e.path}:${e.fn}:${e.line}`)).toEqual(["repos/v/src/lib/parse.ts:parse:6", "repos/v/src/lib/parse.ts:helper:20", "repos/v/src/resolvers/load.ts:loadAll:41"]);
  });

  it("CONTROL: a green run, and a red run whose stack holds only test and runtime frames, give no frames", () => {
    expect(RE.checkCallPathFromRun(GREEN_RUN, "test/checks/cart.check.ts", { prefix: PREFIX, read })).toEqual([]);
    expect(RE.checkCallPathFromRun(VALUE_RUN, "test/checks/cart.check.ts", { prefix: PREFIX, read })).toEqual([]);
  });
});

describe("(ii) an expect() on a returned value: the failing test's src calls, statically", () => {
  it("resolves the named and namespace calls of the FAILING test's body to their declarations", () => {
    const path = FC.ownCheckCallPath({ raw: VALUE_RUN, test_file: "test/checks/cart.check.ts", only: [], failing: [{ name: "total sums the cart" }], vessel_root: ROOT, prefix: PREFIX, read });
    expect(path).toEqual([
      { path: "repos/v/src/lib/format.ts", fn: "money", line: 1 },
      { path: "repos/v/src/lib/calc.ts", fn: "total", line: 3 },
    ]);
  });

  it("CONTROL: a green run (no failing test) and a check that calls no src symbol give no path, and no prompt line", () => {
    expect(FC.ownCheckCallPath({ raw: GREEN_RUN, test_file: "test/checks/cart.check.ts", only: [], failing: [], vessel_root: ROOT, prefix: PREFIX, read })).toEqual([]);
    add("test/checks/literal.check.ts", ["import { expect, test } from \"bun:test\";", "test(\"a literal\", () => { expect(1 + 1).toBe(3); });"].join("\n"));
    const none = FC.ownCheckCallPath({ raw: VALUE_RUN.replace(/cart\.check/g, "literal.check").replace("total sums the cart", "a literal"), test_file: "test/checks/literal.check.ts", only: [], failing: [{ name: "a literal" }], vessel_root: ROOT, prefix: PREFIX, read });
    expect(none).toEqual([]);
    expect(RE.attemptEvidenceBlock([lessonWith(none)])).not.toContain("call path");
  });
});
