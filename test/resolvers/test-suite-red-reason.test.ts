// test_suite REPORTS WHY ITS ONE FILE IS RED (B′, check-first, 2026-10-08).
//
// gap-check-supply's arm step judges a landed check through the ONE birth judge, which reads test_suite's report
// (evaluateGapCheck's onReport). That report carried names and counts only, so the arm could tell "the named test
// failed" but not WHY: a load error, a refused connection, a timeout and an assertion all read the same. B′ requires
// the arm and feature_compose's verify to judge the red by the SAME classifier (retry-evidence.ts classifyCheckRun),
// so test_suite now carries that classification of its own run as `red_reason` whenever it ran ONE test_file. A
// whole-suite run carries none (it is not a check's measurement).
//
// These tests execute the resolver's real shell command against a TMPDIR fixture (only ROOT is rewritten), with the bun
// on PATH and, when present, bun 1.4.2 first on PATH (a missing 1.4.2 is a visible skip).
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { resolveTestSuite } from "../../src/resolvers/test-suite.js";

const H = `import { expect, test } from "bun:test";\n`;
const fixture = mkdtempSync(join(tmpdir(), "test-suite-red-reason-"));
function put(rel: string, body: string): void {
  mkdirSync(join(fixture, rel, ".."), { recursive: true });
  writeFileSync(join(fixture, rel), body);
}
mkdirSync(join(fixture, "node_modules"), { recursive: true });
put("src/x.ts", "export const widget = 1;\n");
put("test/checks/assertion.check.ts", `${H}import * as mod from "../../src/x";\ntest("widget is two", () => { expect(mod.widget).toBe(2); });\ntest("newThing exists", () => { expect(typeof (mod as Record<string, unknown>)["newThing"]).toBe("function"); });\n`);
put("test/checks/load.check.ts", `${H}import { newThing } from "../../src/x";\ntest("newThing exists", () => { expect(typeof newThing).toBe("function"); });\n`);
put("test/checks/net.check.ts", `${H}test("net red", async () => { const r = await fetch("http://127.0.0.1:1/"); expect(r.ok).toBe(true); });\n`);
put("test/a.test.ts", `${H}test("green", () => { expect(1).toBe(1); });\n`);

const ALT_BUN = process.env["BUN_ALT_BINARY"] ?? join(tmpdir(), "bun142", "node_modules", ".bin", "bun");
const ALT_PRESENT = existsSync(ALT_BUN);
const originalFetch = globalThis.fetch;
afterAll(() => { globalThis.fetch = originalFetch; rmSync(fixture, { recursive: true, force: true }); });

async function run(pointer: Record<string, unknown>, pathPrefix: string | null): Promise<{ body: Record<string, unknown>; output: string }> {
  let output = "";
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const body = typeof init?.body === "string" ? init.body : "";
    if (body.includes("vesselCapability")) return new Response(JSON.stringify({ content: { vessels: [{ endpoint: "http://shell.test", resolve_endpoint: "/resolve", health_score: 1 }] } }), { status: 200 });
    if (String(input).startsWith("http://shell.test")) {
      const local = String(JSON.parse(body).impulse.pointer.command ?? "").replace(/^ROOT='[^']*'/, `ROOT='${fixture}'`);
      const PATH = pathPrefix ? `${pathPrefix}:${process.env.PATH ?? ""}` : (process.env.PATH ?? "");
      const p = Bun.spawnSync(["bash", "-c", local], { cwd: fixture, env: { PATH, HOME: process.env.HOME ?? "", TMPDIR: tmpdir() }, stdout: "pipe", stderr: "pipe" });
      output = new TextDecoder().decode(p.stdout) + new TextDecoder().decode(p.stderr);
      return new Response(JSON.stringify({ stdout: output }), { status: 200 });
    }
    return new Response("{}", { status: 200 });
  }) as typeof fetch;
  try {
    const r = await resolveTestSuite({ type: "test_suite", vessel: "repos/development-vessel", ...pointer });
    return { body: (r.body ?? {}) as Record<string, unknown>, output };
  } finally {
    globalThis.fetch = originalFetch;
  }
}
type RR = { ran: boolean; unhandled: boolean; unhandled_cause: string | null; failures: Array<{ name: string; cls: string; cause?: string }> };

for (const [label, prefix, present] of [["host bun", null, true], ["bun 1.4.2", dirname(ALT_BUN), ALT_PRESENT]] as const) {
  const t = present ? test : test.skip;
  describe(`test_suite red_reason on ${label}`, () => {
    t("[MUST-FAIL] a check whose named tests fail on assertions reports each as an assertion (the 'repos/' vessel prefix is accepted)", async () => {
      const r = await run({ test_file: "test/checks/assertion.check.ts", only_tests: ["widget is two", "newThing exists"] }, prefix);
      expect(r.output).toContain(label === "host bun" ? `bun test v${Bun.version}` : "bun test v1.4.2");
      expect(r.body).toMatchObject({ ran: true, fail: 2, requested_not_passing: 2, vessel: "repos/development-vessel" });
      const rr = r.body["red_reason"] as RR | undefined;
      expect(rr).toBeDefined();
      expect(rr!.unhandled).toBe(false);
      expect(rr!.failures.map((f) => [f.name, f.cls])).toEqual([["widget is two", "assertion"], ["newThing exists", "assertion"]]);
    });

    t("[MUST-FAIL] a check that fails to load (named import of a missing export) reports unhandled, cause missing_export", async () => {
      const r = await run({ test_file: "test/checks/load.check.ts", only_tests: ["newThing exists"] }, prefix);
      const rr = r.body["red_reason"] as RR | undefined;
      expect(rr).toMatchObject({ ran: true, unhandled: true, unhandled_cause: "missing_export" });
    });

    t("[MUST-FAIL] a refused connection is a wrong reason, cause network", async () => {
      const r = await run({ test_file: "test/checks/net.check.ts" }, prefix);
      const rr = r.body["red_reason"] as RR | undefined;
      expect(rr?.failures[0]).toMatchObject({ name: "net red", cls: "wrong_reason", cause: "network" });
    });

    t("[CONTROL] a whole-suite run (no test_file) carries no red_reason, and its counts are unchanged", async () => {
      const r = await run({}, prefix);
      expect(r.body["red_reason"]).toBeUndefined();
      expect(r.body).toMatchObject({ ran: true, fail: 0 });
    });
  });
}
