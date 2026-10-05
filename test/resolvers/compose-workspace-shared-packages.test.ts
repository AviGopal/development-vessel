// A compose worktree must resolve the shared packages a vessel names as file:../../packages/<pkg>.
// identity-vessel declares "@avigopal/vessel-discovery-client": "file:../../packages/vessel-discovery-client".
// From a worktree at $COMPOSE_WS_DIR/<id>/<vessel> that path names $COMPOSE_WS_DIR/packages, which nothing
// provided, so the compose verify's `bun install --dry-run` failed ("Could not find package.json for
// file:../../packages/...") and every identity-vessel compose was refused before its draft was judged.
// The same layout defect pull-sync's clone had (super-repo 3b9ff630). Real git and real bun; no network.
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readlinkSync, realpathSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const base = realpathSync(mkdtempSync(join(tmpdir(), "compose-ws-packages-")));
const CLONES = join(base, "git", "vessels");
const WS = join(base, "git", "compose");
const RUNTIME = join(base, "vessels");
const LINK = join(WS, "packages");
const g = (cwd: string, ...a: string[]) => execFileSync("git", ["-C", cwd, "-c", "user.name=t", "-c", "user.email=t@t", ...a], { stdio: "pipe" });

const ENV_KEYS = ["MITOSIS_PUSH_CLONE_DIR", "COMPOSE_WS_DIR", "MITOSIS_RUNTIME_DIR"] as const;
const savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
let acquire: (vessels: string[], id: string) => Promise<{ rootFor(v: string): string | undefined; release(): Promise<void> }>;
beforeAll(async () => {
  // origin + push clone of a vessel that names the shared packages
  const origin = join(base, "origin", "iv");
  mkdirSync(origin, { recursive: true });
  writeFileSync(join(origin, "package.json"), JSON.stringify({ name: "iv", dependencies: { "@x/vdc": "file:../../packages/vdc" } }));
  execFileSync("git", ["init", "-q", "-b", "dev", origin]);
  g(origin, "add", "-A"); g(origin, "commit", "-qm", "base");
  mkdirSync(CLONES, { recursive: true });
  execFileSync("git", ["clone", "-q", "-b", "dev", origin, join(CLONES, "iv")]);
  process.env["MITOSIS_PUSH_CLONE_DIR"] = CLONES;
  process.env["COMPOSE_WS_DIR"] = WS;
  ({ acquireComposeWorkspace: acquire } = await import("../../src/resolvers/compose-workspace"));
});
afterAll(() => {
  // this file sets process-wide env; restore it so later files in the same bun process see theirs
  for (const k of ENV_KEYS) { if (savedEnv[k] === undefined) delete process.env[k]; else process.env[k] = savedEnv[k]; }
  rmSync(base, { recursive: true, force: true });
});

const runtimePkg = () => {
  const p = join(RUNTIME, "packages", "vdc");
  mkdirSync(join(p, "dist"), { recursive: true });
  writeFileSync(join(p, "package.json"), JSON.stringify({ name: "@x/vdc", version: "1.0.0", main: "./dist/index.js" }));
  writeFileSync(join(p, "dist", "index.js"), "exports.d = 1;\n");
};
const reset = () => { rmSync(LINK, { recursive: true, force: true }); rmSync(join(RUNTIME, "packages"), { recursive: true, force: true }); };

describe("compose workspace: the shared packages resolve from a worktree", () => {
  it("MUST-FAIL: the worktree's file:../../packages/<pkg> resolves (link to the runtime packages; real bun --dry-run exits 0)", async () => {
    reset(); runtimePkg(); process.env["MITOSIS_RUNTIME_DIR"] = RUNTIME;
    const ws = await acquire(["repos/iv"], "c1");
    const root = ws.rootFor("iv");
    expect(root).toBe(join(WS, "c1", "iv"));
    expect(lstatSync(LINK).isSymbolicLink()).toBe(true);
    expect(readlinkSync(LINK)).toBe(join(RUNTIME, "packages"));
    const dry = spawnSync("bun", ["install", "--dry-run"], { cwd: root!, encoding: "utf8", env: { PATH: process.env["PATH"] ?? "", HOME: process.env["HOME"] ?? "" } });
    expect(`${dry.status} ${dry.stderr ?? ""}`).toStartWith("0 ");
    await ws.release();
    expect(existsSync(LINK)).toBe(true); // release removes only its own workspace
  });

  it("MUST-FAIL (no write-through): real bun install + --dry-run in the worktree leave the runtime package byte-identical, its lifecycle scripts running only in the copy", async () => {
    reset(); runtimePkg(); process.env["MITOSIS_RUNTIME_DIR"] = RUNTIME;
    const rp = join(RUNTIME, "packages", "vdc");
    writeFileSync(join(rp, "package.json"), JSON.stringify({ name: "@x/vdc", version: "1.0.0", main: "./dist/index.js",
      scripts: { preinstall: "touch PRE_RAN", install: "touch INSTALL_RAN", postinstall: "touch POST_RAN", prepare: "touch PREPARE_RAN" } }));
    const tree = (dir: string): string => {
      const out: string[] = [];
      const walk = (d: string) => { for (const e of readdirSync(d).sort()) { const f = join(d, e); const st = statSync(f); out.push(`${f.slice(dir.length)} ${st.size} ${st.mtimeMs}`); if (st.isDirectory()) walk(f); } };
      walk(dir); return out.join("\n");
    };
    const before = tree(rp);
    const ws = await acquire(["iv"], "c6");
    const root = ws.rootFor("iv")!;
    // the candidate trusts the dependency, so bun runs its scripts (the worst case for a fresh-tree install)
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "iv", dependencies: { "@x/vdc": "file:../../packages/vdc" }, trustedDependencies: ["@x/vdc"] }));
    const env = { PATH: process.env["PATH"] ?? "", HOME: process.env["HOME"] ?? "" };
    const dry = spawnSync("bun", ["install", "--dry-run"], { cwd: root, encoding: "utf8", env });
    const inst = spawnSync("bun", ["install"], { cwd: root, encoding: "utf8", env });
    expect(`${dry.status} ${inst.status} ${inst.stderr ?? ""}`).toStartWith("0 0 ");
    expect(lstatSync(join(root, "node_modules", "@x", "vdc")).isSymbolicLink()).toBe(false); // a copy, not a link
    expect(existsSync(join(root, "node_modules", "@x", "vdc", "POST_RAN"))).toBe(true); // scripts ran in the copy
    expect(tree(rp)).toBe(before); // and never in the runtime package
    await ws.release();
  });

  it("an existing real packages directory is never replaced", async () => {
    reset(); runtimePkg(); process.env["MITOSIS_RUNTIME_DIR"] = RUNTIME;
    mkdirSync(join(LINK, "other"), { recursive: true });
    const ws = await acquire(["iv"], "c2");
    expect(lstatSync(LINK).isSymbolicLink()).toBe(false);
    expect(existsSync(join(LINK, "other"))).toBe(true);
    await ws.release();
  });

  it("no runtime packages directory: nothing is linked (the dependency stays unresolved, fail closed)", async () => {
    reset(); process.env["MITOSIS_RUNTIME_DIR"] = RUNTIME;
    const ws = await acquire(["iv"], "c3");
    expect(existsSync(LINK) || (() => { try { lstatSync(LINK); return true; } catch { return false; } })()).toBe(false);
    await ws.release();
  });

  it("the stale-workspace sweep never removes the packages link, however old its target", async () => {
    reset(); runtimePkg(); process.env["MITOSIS_RUNTIME_DIR"] = RUNTIME;
    const ws = await acquire(["iv"], "c4"); await ws.release();
    const old = new Date(Date.now() - 5 * 3600 * 1000);
    utimesSync(join(RUNTIME, "packages"), old, old);
    const before = lstatSync(LINK).ino;
    const ws2 = await acquire(["iv"], "c5");
    expect(lstatSync(LINK).ino).toBe(before);
    expect(existsSync(join(RUNTIME, "packages", "vdc", "dist", "index.js"))).toBe(true); // never written under the runtime
    await ws2.release();
  });
});
