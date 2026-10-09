// test_suite PASSES ITS test_file TO bun AS ONE SINGLE-QUOTED WORD (security, check-first).
//
// test_suite builds one shell command for the tools shell (bash -c). Every value in it went through its shq
// except the test file, which was spliced as JSON.stringify("./" + test_file): a double-quoted word, in which
// bash expands substitutions. The file is validated first ([A-Za-z0-9_./-], no '..'), so no value can carry a
// metacharacter today; this pins the quoting itself, so the command does not depend on that validator alone.
//
// The shell transport is a recorder: the command is captured and nothing runs.
import { afterAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { resolveTestSuite } from "../../src/resolvers/test-suite.js";

const originalFetch = globalThis.fetch;
afterAll(() => { globalThis.fetch = originalFetch; });

async function commandFor(pointer: Record<string, unknown>): Promise<string> {
  let command = "";
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const body = typeof init?.body === "string" ? init.body : "";
    if (body.includes("vesselCapability")) {
      return new Response(JSON.stringify({ content: { vessels: [{ endpoint: "http://shell.test", resolve_endpoint: "/resolve", health_score: 1 }] } }), { status: 200 });
    }
    if (String(input).startsWith("http://shell.test")) {
      command = String(JSON.parse(body).impulse.pointer.command ?? "");
      return new Response(JSON.stringify({ stdout: "" }), { status: 200 });
    }
    return new Response("{}", { status: 200 });
  }) as typeof fetch;
  try {
    await resolveTestSuite({ type: "test_suite", vessel: "development-vessel", ...pointer });
  } finally {
    globalThis.fetch = originalFetch;
  }
  return command;
}

describe("test_suite: the test file is one single-quoted word", () => {
  test("MUST-FAIL: the working-tree command passes './<test_file>' single-quoted, never double-quoted", async () => {
    const cmd = await commandFor({ test_file: "test/a/x.test.ts" });
    expect(cmd).toContain("bun test './test/a/x.test.ts' --timeout");
    expect(cmd).not.toContain("\"./test/a/x.test.ts\"");
  });
  test("MUST-FAIL: the base-ref command quotes it the same way", async () => {
    const cmd = await commandFor({ test_file: "test/checks/gap-x.check.ts", base_ref: "HEAD" });
    expect(cmd).toContain("bun test './test/checks/gap-x.check.ts' --timeout");
  });
  test("MUST-FAIL: test-suite.ts builds no shell text with JSON.stringify", () => {
    const text = readFileSync(join(import.meta.dir, "..", "..", "src", "resolvers", "test-suite.ts"), "utf8");
    expect((text.match(/JSON\.stringify\("\.\/"/g) ?? []).length).toBe(0);
  });
  test("CONTROL: without a test_file the whole suite runs, as before", async () => {
    const cmd = await commandFor({});
    expect(cmd).toMatch(/bun test --timeout \d+/);
  });
});
