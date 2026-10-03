// only_tests NAMES NEVER REACH A SHELL (security, check-first).
//
// test_suite runs `bun test` through the shell producer as ONE command string. It used to narrow the
// run with ` -t ${JSON.stringify(regexEscaped(only_tests).join("|"))}`: a DOUBLE-quoted string, inside
// which sh still expands backticks and $VAR. A test title is data from a gap row (any gap writer), so a
// title carrying `systemctl restart x` was EXECUTED in the live container (measured 2026-10-03, node 1).
//
// These drive the REAL resolveTestSuite against a tiny fixture vessel in the test's own temp dir: the
// fixture shell producer runs the command it is sent with `sh -c`, exactly as the shell producer does,
// so a title that escapes its quoting runs. Every injected command only touches a sentinel file inside
// this test's temp dir. The fetch, exec and fs guards keep the run off the fleet, /workspace and the
// host's lifecycle tools.
import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installCutoverFetchGuard, restoreCutoverFetch, routeShell, type FetchGuard } from "./cutover-fetch-guard.js";
import { installCutoverExecGuard, restoreCutoverExecModules, type ExecGuard } from "./cutover-exec-guard.js";
import { installCutoverFsGuard, restoreCutoverFsModules, type FsGuard } from "./cutover-fs-guard.js";

const ROOT = join(tmpdir(), `ts-only-tests-noinj-${Date.now()}-${Math.random().toString(36).slice(2)}`);
const SENT = join(ROOT, "sentinel");
const FIXTURE_NAME = `noinj-fixture-${Math.random().toString(36).slice(2, 8)}`;
const FIXTURE = join(ROOT, "vessels", FIXTURE_NAME);
mkdirSync(SENT, { recursive: true });
mkdirSync(join(FIXTURE, "node_modules"), { recursive: true }); // present, so the command never runs `bun install`
// The gap store for the arm-time case lives in this temp dir too (read at module load, so set before import).
process.env["WORKSPACE_ROOT"] = join(ROOT, "ws");
mkdirSync(join(ROOT, "ws"), { recursive: true });
process.env["SUBSTRATE_GAP_SKIP_COMPOSE_TRIGGER"] = "1";
delete process.env["GAP_STORE_ENDPOINT"];

const { resolveTestSuite } = await import("../../src/resolvers/test-suite.js");
const gapStore = (await import("../../src/resolvers/substrate-gap.js")) as Record<string, any>;

// Titles. Each injected payload only ever touches a sentinel inside SENT.
const T_BACKTICK = `inj backtick \`touch ${SENT}/pwned-backtick\` end`;
const T_DOLLAR = `inj dollar $(touch ${SENT}/pwned-dollar) end`;
const T_SQUOTE = `inj it's \`touch ${SENT}/pwned-squote\` and '$(touch ${SENT}/pwned-squote2)' end`;
const T_VAR = "inj var $HOME and ${HOME} end";
const T_META = "a (b) [c] {d} +e ?f *g .h |i ^j $k \\l";
const T_QQ = "regex x |\\?\\?= adds nothing to a regex already matching \\?\\?";
const T_WB = "word boundary \\b stays literal";
const T_NORMAL = "plain normal alpha";
const T_OTHER = "plain other beta";
const ALL = [T_BACKTICK, T_DOLLAR, T_SQUOTE, T_VAR, T_META, T_QQ, T_WB, T_NORMAL, T_OTHER];

writeFileSync(join(FIXTURE, "package.json"), JSON.stringify({ name: FIXTURE_NAME, private: true }));
writeFileSync(
  join(FIXTURE, "fixture.test.ts"),
  `import { test, expect } from "bun:test";\n` + ALL.map((t) => `test(${JSON.stringify(t)}, () => { expect(1).toBe(1); });\n`).join(""),
);

const PWNED = ["pwned-backtick", "pwned-dollar", "pwned-squote", "pwned-squote2", "pwned-vessel"];

/** Points the command's tree at the fixture: both candidate roots end in /<FIXTURE_NAME>. */
const atFixture = (command: string): string =>
  command.replace(new RegExp(`[A-Za-z0-9_./-]*/${FIXTURE_NAME}(?![A-Za-z0-9_.-])`, "g"), FIXTURE);

/** The fixture shell producer: runs the command with sh -c, as the shell producer does. */
function runInShell(command: string): string {
  const p = Bun.spawnSync(["sh", "-c", atFixture(command)], {
    cwd: ROOT,
    env: { PATH: process.env["PATH"] ?? "/usr/bin:/bin", HOME: process.env["HOME"] ?? ROOT, TMPDIR: ROOT },
    stdout: "pipe",
    stderr: "pipe",
  });
  return new TextDecoder().decode(p.stdout) + new TextDecoder().decode(p.stderr);
}

/** The command with every single-quoted span removed: what sh still evaluates. */
function evaluatedText(command: string): string {
  let out = "";
  let inDouble = false;
  for (let i = 0; i < command.length; i++) {
    const c = command[i]!;
    if (!inDouble && c === "'") {
      const end = command.indexOf("'", i + 1);
      if (end < 0) return out + command.slice(i); // unterminated: treat the rest as evaluated
      i = end;
      out += "''";
      continue;
    }
    if (c === "\\" && i + 1 < command.length) { out += c + command[i + 1]; i++; continue; }
    if (c === '"') inDouble = !inDouble;
    out += c;
  }
  return out;
}

let fetchGuard: FetchGuard;
let execGuard: ExecGuard;
let fsGuard: FsGuard;
const shellCommands: string[] = [];

beforeEach(() => {
  shellCommands.length = 0;
  fetchGuard = installCutoverFetchGuard();
  execGuard = installCutoverExecGuard();
  fsGuard = installCutoverFsGuard();
});
afterEach(() => {
  const v = [...fetchGuard.restore(), ...execGuard.restore(), ...fsGuard.restore()];
  expect(v).toEqual([]);
});
afterAll(() => {
  restoreCutoverFetch();
  restoreCutoverExecModules();
  restoreCutoverFsModules();
});

const run = async (only_tests: unknown[], execute = true, extra: Record<string, unknown> = {}) => {
  routeShell(fetchGuard, (cmd) => {
    shellCommands.push(cmd);
    return execute ? runInShell(cmd) : " 1 pass\n 0 fail\n";
  });
  return resolveTestSuite({ type: "test_suite", vessel: `repos/${FIXTURE_NAME}`, test_file: "fixture.test.ts", timeout_ms: 90_000, only_tests, ...extra });
};

describe("test_suite only_tests never reach a shell", () => {
  it("MUST-FAIL: titles carrying `cmd`, $(cmd), quotes and $VAR run as LITERAL filters and execute nothing", async () => {
    const r = await run([T_BACKTICK, T_DOLLAR, T_SQUOTE, T_VAR]);
    for (const f of PWNED) expect(existsSync(join(SENT, f))).toBe(false);
    expect(r.shape).toBe("test_suite");
    const b = r.body as Record<string, any>;
    expect(b.ran).toBe(true);
    expect(b.pass).toBe(4);
    expect(b.total).toBe(4);
    expect(b.requested_not_passing).toBe(0);
  }, 120_000);

  it("MUST-FAIL: no title text reaches a shell-evaluated position of the command", async () => {
    await run([T_BACKTICK, T_DOLLAR, T_SQUOTE, T_VAR], false);
    expect(shellCommands.length).toBe(1);
    const evaluated = evaluatedText(shellCommands[0]!);
    expect(evaluated).not.toContain("pwned");
    expect(evaluated).not.toContain("`");
    expect(evaluated).not.toContain("$HOME and");
    expect(evaluated).not.toContain("inj ");
  });

  it("MUST-FAIL: a vessel name that is not a plain name is refused before any shell call", async () => {
    routeShell(fetchGuard, (cmd) => { shellCommands.push(cmd); return " 1 pass\n 0 fail\n"; });
    const r = await resolveTestSuite({ type: "test_suite", vessel: `repos/x\`touch ${SENT}/pwned-vessel\``, only_tests: [T_NORMAL] });
    expect(r.shape).toBe("structuredError");
    expect(shellCommands).toEqual([]);
    expect(existsSync(join(SENT, "pwned-vessel"))).toBe(false);
  });

  it("MUST-FAIL: regex metacharacters ( ) [ ] { } + ? * . | ^ $ \\ in a title match it literally", async () => {
    const r = await run([T_META]);
    const b = r.body as Record<string, any>;
    expect(b.ran).toBe(true);
    expect(b.pass).toBe(1);
    expect(b.total).toBe(1);
    expect(b.requested_not_passing).toBe(0);
  }, 120_000);

  it("CONTROL: backslash titles (\\?\\? and \\b) still match literally", async () => {
    const r = await run([T_QQ, T_WB]);
    const b = r.body as Record<string, any>;
    expect(b.ran).toBe(true);
    expect(b.pass).toBe(2);
    expect(b.total).toBe(2);
    expect(b.requested_not_passing).toBe(0);
  }, 120_000);

  it("CONTROL: a normal title still filters to just that test", async () => {
    const r = await run([T_NORMAL]);
    const b = r.body as Record<string, any>;
    expect(b.ran).toBe(true);
    expect(b.pass).toBe(1);
    expect(b.total).toBe(1);
    expect(b.requested_not_passing).toBe(0);
  }, 120_000);

  it("MUST-FAIL: a title with a control character, or an absurd length, is refused with a structured error and nothing runs", async () => {
    for (const bad of [["ok title", "line\nbreak"], ["tab\there"], ["nul\u0000x"], ["x".repeat(5000)]]) {
      const r = await run(bad, false);
      expect(r.shape).toBe("structuredError");
      expect(String((r.body as Record<string, any>).field ?? "")).toContain("only_tests");
    }
    expect(shellCommands).toEqual([]);
  });
});

describe("substrateGap_write refuses an unrunnable only_tests at ARM time", () => {
  it("MUST-FAIL: a test_suite check naming a title with a newline is rejected as validation_rejected, and no row is written", async () => {
    gapStore.__setBirthJudgeForTests?.(async () => "unknown");
    try {
      const r = await gapStore.resolveSubstrateGapWrite({
        type: "substrateGap_write",
        gap: {
          id: "only-tests-newline-arm-time",
          category: "operator_request",
          source: "human_reported",
          status: "open",
          detected_at: "2026-10-03T10:00:00Z",
          summary: "fixture: a check whose test title carries a newline",
          classification_metadata: {
            edit_site: `repos/${FIXTURE_NAME}/src/a.ts`,
            evidence_resolve: {
              shape: "test_suite",
              input: { vessel: `repos/${FIXTURE_NAME}`, test_file: "fixture.test.ts", only_tests: ["fine (title) +ok", "evil\n`touch x`"] },
              zero_field: "requested_not_passing",
            },
          },
        },
      });
      expect(r.shape).toBe("structuredError");
      const b = r.body as Record<string, any>;
      expect(b.failure_mode).toBe("validation_rejected");
      expect(String(b.field ?? "")).toContain("only_tests");
      const after = await gapStore.resolveSubstrateGap({ type: "substrateGap", id: "only-tests-newline-arm-time", limit: 5 });
      const rows = ((after.body as { gaps?: Array<{ id: string }> }).gaps ?? []).filter((g) => g.id === "only-tests-newline-arm-time");
      expect(rows).toEqual([]);
    } finally {
      await gapStore.__settleBirthEvaluationsForTests?.();
      gapStore.__setBirthJudgeForTests?.(null);
    }
  });

  it("CONTROL: a CLOSE that re-sends such stored metadata is not refused by the gate (a poisoned row stays closable)", async () => {
    const r = await gapStore.resolveSubstrateGapWrite({
      type: "substrateGap_write",
      gap: {
        id: "only-tests-newline-close-control",
        category: "operator_request",
        source: "human_reported",
        status: "closed",
        detected_at: "2026-10-03T10:00:00Z",
        summary: "fixture: closing a row whose stored check has a newline title",
        classification_metadata: {
          closed_reason: "rejected",
          evidence_resolve: { shape: "test_suite", input: { vessel: `repos/${FIXTURE_NAME}`, test_file: "fixture.test.ts", only_tests: ["evil\nname"] }, zero_field: "requested_not_passing" },
        },
      },
    });
    const b = (r.body ?? {}) as Record<string, any>;
    expect(b.failure_mode === "validation_rejected" && String(b.field ?? "").includes("only_tests")).toBe(false);
  });
});
