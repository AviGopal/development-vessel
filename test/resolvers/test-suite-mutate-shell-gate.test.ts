// The mutation runner must pass the live shell gate (local-tools shell-containment) as designed, and a gate refusal
// must be reported as such. 2026-10-06 on node1: every mutate_edit test_suite built was refused by the gate's
// opaque-inline-interpreter rule (a `$(… bun -e …)` substitution with the super-repo as cwd), and the refusal read
// as `mutation_not_applied`, so no file could ever be judged by mutation coverage. These tests run the REAL
// commands test_suite builds THROUGH the sibling local-tools vessel's containShell (no stub of the gate), and apply
// real mutants of a real in-scope file with the checked-in applier.
import { afterEach, beforeAll, describe, expect, it } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import * as testSuite from "../../src/resolvers/test-suite";
import { selectMutants } from "../../src/resolvers/scope-earn-in";

type Row = Record<string, unknown>;
const REPO = resolve(import.meta.dir, "..", "..");
// The sibling layout every place this suite runs: repos/<v> in the super-repo, /workspace/git/vessels/<v> in the clones.
const GATE = resolve(REPO, "..", "local-tools-vessel", "src", "shell-containment.ts");

let superRepo = "";
let gateEnv: Record<string, string> = {};
let containShell: (command: string, cwd: string, opts: { env: Record<string, string> }) => { ok: boolean; reason?: string };
beforeAll(async () => {
  // No silent skip: without the sibling gate this check measures nothing, so it fails and says why.
  if (!existsSync(GATE)) throw new Error(`the sibling local-tools-vessel gate is missing at ${GATE}; this check runs test_suite's real commands through it`);
  containShell = (await import(GATE)).containShell;
  const base = realpathSync(mkdtempSync(join(tmpdir(), "mutate-gate-")));
  superRepo = join(base, "git", "super-repo");
  mkdirSync(join(superRepo, "scripts", "substrate"), { recursive: true });
  writeFileSync(join(superRepo, ".gitmodules"), "");
  writeFileSync(join(superRepo, "scripts", "substrate", "autonomy-scope.json"), "{}");
  execFileSync("git", ["-C", superRepo, "init", "-q"]);
  gateEnv = { WORKSPACE_ROOT: superRepo, MITOSIS_RUNTIME_DIR: join(base, "vessels"), MITOSIS_PUSH_CLONE_DIR: join(base, "git", "vessels"), COMPOSE_WS_DIR: join(base, "git", "compose"), METABOB_API_KEY: "k" };
});

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

/** Run resolveTestSuite with discovery + shell stubbed: capture the exact command, answer with `reply`. */
async function capture(pointer: Row, reply: Row): Promise<{ cmd: string; body: Row }> {
  let cmd = "";
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const body = typeof init?.body === "string" ? init.body : "";
    if (body.includes("vesselCapability")) return Response.json({ content: { vessels: [{ endpoint: "http://shell.test", resolve_endpoint: "/resolve", health_score: 1 }] } });
    cmd = String(JSON.parse(body).impulse.pointer.command ?? "");
    return Response.json(reply);
  }) as unknown as typeof fetch;
  const r = await testSuite.resolveTestSuite({ type: "test_suite", vessel: "development-vessel", test_file: "test/x.test.ts", ...pointer });
  return { cmd, body: r.body as Row };
}
const OK = { stdout: "VERIFIED_ROOT=/tmp/x\nVERIFIED_HEAD=feedc0d\nMUTATION_APPLIED=1\n 1 pass\n 0 fail\n" };
const EDIT = { file: "src/resolvers/maintenance-lease.ts", start: 0, end: 6, original: "import", replacement: "importX", operator: "negate" };

describe("test_suite's real commands pass the live shell gate (must-fail at base)", () => {
  it("the baseline base-tree run passes containShell", async () => {
    const { cmd } = await capture({ base_ref: "HEAD" }, OK);
    expect(containShell(cmd, superRepo, { env: gateEnv })).toMatchObject({ ok: true });
  });
  it("the mutate_revert run passes containShell", async () => {
    const { cmd } = await capture({ base_ref: "HEAD", mutate_revert: { sha: "abcdef1", file: "src/resolvers/maintenance-lease.ts" } }, OK);
    expect(containShell(cmd, superRepo, { env: gateEnv })).toMatchObject({ ok: true });
  });
  it("MUST-FAIL: the mutate_edit run passes containShell (no inline interpreter program inside a substitution)", async () => {
    const { cmd } = await capture({ base_ref: "HEAD", mutate_edit: EDIT }, OK);
    expect(containShell(cmd, superRepo, { env: gateEnv })).toMatchObject({ ok: true });
    expect(cmd).not.toMatch(/\bbun\s+-e\b/);
  });
});

describe("a gate refusal is reported as one, never as 'not applied' (must-fail at base)", () => {
  it("MUST-FAIL: a containment refusal of the mutant run surfaces as gate_refused with the reason", async () => {
    const { body } = await capture({ base_ref: "HEAD", mutate_edit: EDIT }, { error: "write refused by containment", cwd: "/workspace/git/super-repo" });
    expect(body["ran"]).toBe(false);
    expect(String(body["gate_refused"] ?? "")).toContain("refused by containment");
    expect((body["mutation"] as Row)["applied"]).toBe(false);
  });
  it("control: a successful run carries no gate_refused", async () => {
    const { body } = await capture({ base_ref: "HEAD", mutate_edit: EDIT }, OK);
    expect(body["gate_refused"] ?? null).toBeNull();
  });
});

describe("the checked-in applier applies real mutants of a real in-scope file (positive control)", () => {
  it("MUST-FAIL: ≥1 operator mutant of src/resolvers/maintenance-lease.ts applies at this tree, exactly where selected", () => {
    const applier = (testSuite as unknown as { MUTANT_APPLIER_PATH?: string }).MUTANT_APPLIER_PATH;
    expect(typeof applier).toBe("string");
    expect(existsSync(applier!)).toBe(true);
    const src = readFileSync(join(REPO, "src", "resolvers", "maintenance-lease.ts"), "utf8");
    const mutants = selectMutants(src, 6);
    expect(mutants.length).toBeGreaterThan(0);
    let applied = 0;
    for (const m of mutants) {
      const dir = mkdtempSync(join(tmpdir(), "mutant-apply-"));
      mkdirSync(join(dir, "src", "resolvers"), { recursive: true });
      const file = "src/resolvers/maintenance-lease.ts";
      writeFileSync(join(dir, file), src);
      const data = Buffer.from(JSON.stringify({ file, start: m.start, end: m.end, original: m.original, replacement: m.replacement }), "utf8").toString("base64");
      const r = spawnSync("bun", ["run", applier!, data], { cwd: dir, encoding: "utf8" });
      if (r.status === 0) {
        const after = readFileSync(join(dir, file), "utf8");
        expect(after).toBe(src.slice(0, m.start) + m.replacement + src.slice(m.end));
        applied++;
      }
    }
    expect(applied).toBeGreaterThan(0);
  });
  it("the applier refuses when the text at [start,end) is not exactly `original` (file untouched)", () => {
    const applier = (testSuite as unknown as { MUTANT_APPLIER_PATH?: string }).MUTANT_APPLIER_PATH!;
    const dir = mkdtempSync(join(tmpdir(), "mutant-mismatch-"));
    writeFileSync(join(dir, "f.ts"), "export const A = 1;\n");
    const data = Buffer.from(JSON.stringify({ file: "f.ts", start: 0, end: 6, original: "import", replacement: "x" }), "utf8").toString("base64");
    const r = spawnSync("bun", ["run", applier, data], { cwd: dir, encoding: "utf8" });
    expect(r.status).not.toBe(0);
    expect(readFileSync(join(dir, "f.ts"), "utf8")).toBe("export const A = 1;\n");
  });
});
