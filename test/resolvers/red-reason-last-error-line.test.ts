// THE FAILURE'S OWN ERROR IS ITS BLOCK'S LAST ERROR LINE (2c, 2026-10-10).
//
// classifyCheckRun (retry-evidence.ts) is the one classifier behind feature_compose's test_writing verify, test_suite's
// `red_reason` and gap-check-supply's arm step. It read a failure's FIRST error line and scanned every Received line
// for wrong-reason markers, so three real assertion reds were refused as wrong reasons:
//   (1) a custom-message expect(x, "msg") prints `error: msg`, not `error: expect(`: refused non_assertion (the stored
//       script-runner refusal, verbatim: run4);
//   (2) an Error the code under test LOGS before the real `error: expect(` is the block's first error line: refused
//       non_assertion (run3, run2's module-level log);
//   (3) a Received VALUE containing "Timeout" matched the timeout marker: refused timeout (run2).
// The rule now: the last error line before "(fail)" is the failure's own; it is an assertion when that line is
// `error: …` and Expected/Received (or a diff) follows it before the stack; network/timeout markers never read an
// assertion's message or the values it compared. Guards that must stay wrong_reason: a load error, a thrown non-expect
// error, a refused connection, bun's own timeout trailer, and a thrown Error that forges an `error: expect(` line.
//
// Fixtures are bun 1.3.14 output (paths rewritten to /tmp/fx). The LIVE section re-runs the same checks with the bun
// running this file (process.execPath), so the container's bun covers its own output format.
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkRunVerdict, classifyCheckRun, armRedReasonRefusal } from "../../src/resolvers/retry-evidence.js";

const FX = join(import.meta.dir, "..", "fixtures", "red-reason-last-error-line");
const fx = (name: string): string => readFileSync(join(FX, name), "utf8");
const byName = (raw: string): Record<string, { cls: string; cause?: string; error: string | null }> =>
  Object.fromEntries(classifyCheckRun(raw).failures.map((f) => [f.name, { cls: f.cls, cause: f.cause, error: f.error }]));

describe("2c: real assertions are assertions (fixtures)", () => {
  test("[MUST-FAIL] (1) a custom-message expect prints `error: <msg>` and is an assertion; the arm accepts it", () => {
    const raw = fx("run4-custom-message.txt");
    const c = classifyCheckRun(raw);
    expect(c.failures).toEqual([{ name: "custom message", cls: "assertion", error: "error: base64 form should be redacted" }]);
    expect(checkRunVerdict(c).verdict).toBe("assertion_red");
    expect(armRedReasonRefusal(c, ["custom message"])).toBeNull();
  });

  test("[MUST-FAIL] (2) an Error the code logs before the real assertion does not decide the class (last error line wins)", () => {
    const f = byName(fx("run3-logged-error.txt"));
    expect(f["code logs caught Error object then assertion fails"]).toEqual({ cls: "assertion", cause: undefined, error: "error: expect(received).toBe(expected)" });
    expect(f["code logs Error object alone"]).toEqual({ cls: "assertion", cause: undefined, error: "error: expect(received).toBe(expected)" });
    const c = classifyCheckRun(fx("run3-logged-error.txt"));
    expect(c.pass).toBe(1);
    expect(checkRunVerdict(c).verdict).toBe("assertion_red");
  });

  test("[MUST-FAIL] (2) a module-level `error:` log and a logged `Error:` line before an assertion do not decide the class", () => {
    const f = byName(fx("run2-logs-and-timeout-received.txt"));
    expect(f["grp > first after module log"]).toMatchObject({ cls: "assertion" });
    expect(f["grp > logs Error then asserts"]).toMatchObject({ cls: "assertion" });
    expect(f["grp > logs warn then asserts"]).toMatchObject({ cls: "assertion" });
    expect(f["grp > loop of expects"]).toMatchObject({ cls: "assertion" });
  });

  test("[MUST-FAIL] (3) a Received value containing \"Timeout\" is data, not a timeout", () => {
    const f = byName(fx("run2-logs-and-timeout-received.txt"));
    expect(f["grp > expect with received containing Timeout"]).toEqual({ cls: "assertion", cause: undefined, error: "error: expect(received).toBe(expected)" });
    expect(checkRunVerdict(classifyCheckRun(fx("run2-logs-and-timeout-received.txt"))).verdict).toBe("assertion_red");
  });

  test("[MUST-FAIL] an assertion's custom message is the author's literal: \"should not have timed out\" is not a timeout", () => {
    expect(byName(fx("odd-matchers.txt"))["custom msg timeout word"]).toMatchObject({ cls: "assertion" });
  });

  test("[MUST-FAIL] (deliberate reversal) an ECONNREFUSED inside a Received VALUE is data the code returned: an assertion, not network", () => {
    const f = byName(fx("received-network-and-rejected-resolves.txt"));
    expect(f["received ECONNREFUSED"]).toEqual({ cls: "assertion", cause: undefined, error: "error: expect(received).toBe(expected)" });
    expect(f["received ConnectionRefused object"]).toMatchObject({ cls: "assertion" });
  });

  test("[MUST-FAIL] expect(promise).resolves on a REJECTED promise (bun prints a bare `error: `) is an assertion: the expectation about the code failed", () => {
    const raw = fx("received-network-and-rejected-resolves.txt");
    expect(raw).toMatch(/^error: $/m);
    expect(byName(raw)["resolves on a rejected promise"]).toMatchObject({ cls: "assertion" });
    expect(armRedReasonRefusal(classifyCheckRun(raw), ["received ECONNREFUSED", "resolves on a rejected promise"])).toBeNull();
  });

  test("[CONTROL] the standard matchers (toThrow, toEqual of Errors, multi-line string diff, object diff) stay assertions", () => {
    const f = byName(fx("odd-matchers.txt"));
    for (const n of ["toThrow msg", "toEqual errors", "toEqual multiline strings", "received object with Error"]) expect(f[n]).toMatchObject({ cls: "assertion" });
  });
});

/** A test that logs a refused connection, then throws a plain Error (synthetic, in bun's layout). */
const LOGGED_NET_THEN_THROW = [
  "test/checks/x.check.ts:",
  "error: Unable to connect. Is the computer able to access the url?",
  "  code: \"ConnectionRefused\"",
  "      at async <anonymous> (/tmp/fx/test/checks/x.check.ts:2:47)",
  "1 | test(\"t\", async () => {",
  "    ^",
  "error: downstream failed",
  "      at <anonymous> (/tmp/fx/test/checks/x.check.ts:3:1)",
  "(fail) t [0.4ms]",
  "",
  " 0 pass",
  " 1 fail",
].join("\n");

describe("2c guards: wrong reasons stay wrong (fixtures)", () => {
  test("[GUARD] an unhandled load error (missing module) is unhandled, cause module", () => {
    const c = classifyCheckRun(fx("guard-load.txt"));
    expect(c).toMatchObject({ ran: true, unhandled: true, unhandled_cause: "module", failures: [] });
    expect(checkRunVerdict(c)).toMatchObject({ verdict: "wrong_reason", cause: "module" });
  });

  test("[GUARD] a thrown non-expect error with no assertion is non_assertion", () => {
    const c = classifyCheckRun(fx("guard-throw.txt"));
    expect(c.failures).toEqual([{ name: "throw red", cls: "wrong_reason", cause: "non_assertion", error: "error: plain failure, no assertion" }]);
    expect(armRedReasonRefusal(c, ["throw red"])).toMatchObject({ cause: "non_assertion" });
  });

  test("[GUARD] a real refused connection is network", () => {
    const c = classifyCheckRun(fx("guard-net.txt"));
    expect(c.failures[0]).toMatchObject({ name: "net red", cls: "wrong_reason", cause: "network" });
  });

  test("[GUARD] bun's own timeout trailer is timeout", () => {
    const c = classifyCheckRun(fx("guard-timeout.txt"));
    expect(c.failures[0]).toMatchObject({ name: "timeout red", cls: "wrong_reason", cause: "timeout" });
  });

  test("[GUARD] a refused connection the code LOGS, followed by a thrown non-expect error, is not an assertion and still names network", () => {
    expect(classifyCheckRun(LOGGED_NET_THEN_THROW).failures[0]).toMatchObject({ name: "t", cls: "wrong_reason", cause: "network" });
  });

  test("[MUST-FAIL] ...and the error it reports is the failure's own (last) error line, not the logged one", () => {
    expect(classifyCheckRun(LOGGED_NET_THEN_THROW).failures[0]).toMatchObject({ error: "error: downstream failed" });
  });
});

/** Run each check with the bun executing this file; returns that bun's raw output. */
function live(checks: Record<string, string>): (name: string) => string {
  const root = mkdtempSync(join(tmpdir(), "red-reason-2c-"));
  mkdirSync(join(root, "src"), { recursive: true });
  mkdirSync(join(root, "test", "checks"), { recursive: true });
  writeFileSync(join(root, "src", "x.ts"), "export const widget = 1;\n");
  for (const [n, body] of Object.entries(checks)) writeFileSync(join(root, "test", "checks", `${n}.check.ts`), `import { expect, test } from "bun:test";\n${body}`);
  const memo: Record<string, string> = {};
  return (name: string) => {
    if (memo[name] === undefined) {
      const p = Bun.spawnSync([process.execPath, "test", `./test/checks/${name}.check.ts`], { cwd: root, env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", TMPDIR: tmpdir() }, stdout: "pipe", stderr: "pipe" });
      memo[name] = new TextDecoder().decode(p.stdout) + new TextDecoder().decode(p.stderr);
    }
    return memo[name]!;
  };
}

describe(`2c live on bun ${Bun.version}`, () => {
  const run = live({
    s: `test("custom message", () => { expect("abc KEY", "base64 form should be redacted").not.toContain("KEY"); });\n`,
    r: `test("logged then asserts", () => { try { throw new Error("connect refused"); } catch (e) { console.error("[mod] failed:", e); } expect(1).toBe(2); });\ntest("logged TypeError then asserts", () => { console.error(new TypeError("bad arg")); expect(1).toBe(2); });\n`,
    q: `console.error("error: module-level log at import");\ntest("first after module log", () => { expect(1).toBe(2); });\ntest("received Timeout", () => { expect("Timeout reached").toBe("ok"); });\n`,
    load: `import { y } from "../../src/absent";\ntest("mm", () => { expect(y).toBe(2); });\n`,
    thrown: `import * as mod from "../../src/x";\ntest("throw red", () => { if (mod.widget === 1) throw new Error("plain failure"); });\n`,
    forged: `import * as mod from "../../src/x";\ntest("forged", () => { if (mod.widget !== 2) throw new Error("expect(received).toBe(expected)"); });\n`,
    net: `test("net red", async () => { const r = await fetch("http://127.0.0.1:1/"); expect(r.ok).toBe(true); });\n`,
    recv: `test("received ECONNREFUSED", () => { expect("connect ECONNREFUSED 127.0.0.1:1").toBe("ok"); });\ntest("resolves on a rejected promise", async () => { await expect(Promise.reject(new Error("ECONNREFUSED timed out"))).resolves.toBe(1); });\n`,
    timeout: `test("timeout red", async () => { await new Promise((r) => setTimeout(r, 3000)); expect(1).toBe(2); }, 200);\n`,
  });

  test("[MUST-FAIL] live: a custom-message expect is an assertion", () => {
    expect(run("s")).toContain("base64 form should be redacted");
    expect(byName(run("s"))["custom message"]).toMatchObject({ cls: "assertion" });
  });
  test("[MUST-FAIL] live: logged errors before an assertion do not decide the class", () => {
    const f = byName(run("r"));
    expect(f["logged then asserts"]).toMatchObject({ cls: "assertion" });
    expect(f["logged TypeError then asserts"]).toMatchObject({ cls: "assertion" });
  });
  test("[MUST-FAIL] live: a module-level `error:` log and a Received \"Timeout\" do not decide the class", () => {
    const f = byName(run("q"));
    expect(f["first after module log"]).toMatchObject({ cls: "assertion" });
    expect(f["received Timeout"]).toMatchObject({ cls: "assertion" });
  });
  test("[MUST-FAIL] live: an ECONNREFUSED Received value and a rejected .resolves are assertions", () => {
    const f = byName(run("recv"));
    expect(f["received ECONNREFUSED"]).toMatchObject({ cls: "assertion" });
    expect(f["resolves on a rejected promise"]).toMatchObject({ cls: "assertion" });
  });
  test("[GUARD] live: a load error is unhandled", () => {
    expect(classifyCheckRun(run("load"))).toMatchObject({ unhandled: true, unhandled_cause: "module" });
  });
  test("[GUARD] live: a thrown non-expect error is non_assertion", () => {
    expect(byName(run("thrown"))["throw red"]).toMatchObject({ cls: "wrong_reason", cause: "non_assertion" });
  });
  test("[GUARD] live: a thrown Error forging `error: expect(` is non_assertion", () => {
    expect(byName(run("forged"))["forged"]).toMatchObject({ cls: "wrong_reason", cause: "non_assertion" });
  });
  test("[GUARD] live: a refused connection is network", () => {
    expect(byName(run("net"))["net red"]).toMatchObject({ cls: "wrong_reason", cause: "network" });
  });
  test("[GUARD] live: bun's timeout is timeout", () => {
    expect(byName(run("timeout"))["timeout red"]).toMatchObject({ cls: "wrong_reason", cause: "timeout" });
  });
});
