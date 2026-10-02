// fs_grep as the floor's repo-wide code search (user ruling 10-02: "restore the floor's code search;
// this should be a shape that web search outputs"). The result carries the webSearchResult form
// (`results: [{title, url, snippet}]`) with url a vessel-qualified `repos/<vessel>/...` path the
// citation oracle (goal-host verifyCodeInvestigationCitation) re-reads; it is read-only and no shell.
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { resolveFsGrep } from "../../src/resolvers/fs-grep.js";

const SYM = "resolveUniqueSymbolXyz";
// goal-host index.ts verifyCodeInvestigationCitation: the cited-path regex and the super-repo roots it re-reads under.
const CITED_PATH_RE = /[\w./-]*[\w-]+\.(?:ts|tsx|js|jsx|mjs|cjs|json|md)\b/g;

let base: string;
let runtime: string;
let superRepo: string;
const saved: Record<string, string | undefined> = {};
type Body = { results: Array<{ title: string; url: string; snippet: string }>; matches: Array<{ path: string; url: string; line: number }>; truncated: boolean };

async function snapshot(dir: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (d: string): Promise<void> => {
    for (const e of await readdir(d, { withFileTypes: true })) {
      const f = join(d, e.name);
      if (e.isDirectory()) await walk(f);
      else out.push(`${f}:${(await stat(f)).mtimeMs}:${(await readFile(f, "utf8")).length}`);
    }
  };
  await walk(dir);
  return out.sort();
}

beforeAll(async () => {
  base = await mkdtemp(join(tmpdir(), "fsgrep-code-"));
  runtime = join(base, "vessels");
  superRepo = join(base, "super-repo");
  for (const k of ["WORKSPACE_ROOT", "MITOSIS_RUNTIME_DIR", "EXTRA_WORKSPACE_ROOTS"]) saved[k] = process.env[k];
  process.env["WORKSPACE_ROOT"] = join(base, "workspace");
  process.env["MITOSIS_RUNTIME_DIR"] = runtime;
  delete process.env["EXTRA_WORKSPACE_ROOTS"];
  const src = `export function ${SYM}() {\n  return 1;\n}\n`;
  const files: Record<string, string> = {
    "alpha-vessel/src/resolvers/alpha.ts": src,
    "alpha-vessel/node_modules/dep/index.ts": `${SYM} noise`,
    "alpha-vessel/dist/alpha.js": `${SYM} build output`,
    "alpha-vessel/.env": `SECRET=${SYM}`,
    "alpha-vessel-mitosis-2026-09-30T00-00-00/src/resolvers/alpha.ts": src,
    "beta-vessel/src/index.ts": `import { ${SYM} } from "x";\n`,
  };
  for (const [rel, body] of Object.entries(files)) {
    await mkdir(join(runtime, rel, ".."), { recursive: true });
    await writeFile(join(runtime, rel), body);
  }
  await mkdir(join(base, "workspace"), { recursive: true });
  // The super-repo checkout the citation oracle re-reads (same source as the runtime tree).
  await mkdir(join(superRepo, "repos", "alpha-vessel", "src", "resolvers"), { recursive: true });
  await writeFile(join(superRepo, "repos", "alpha-vessel", "src", "resolvers", "alpha.ts"), src);
});

afterAll(async () => {
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  await rm(base, { recursive: true, force: true });
});

describe("fs_grep — repo-wide code search in the webSearchResult form", () => {
  it("with no path, searches every vessel and returns results [{title, url, snippet}] with vessel-qualified urls", async () => {
    const body = (await resolveFsGrep({ type: "fs_grep", pattern: SYM })).body as Body;
    const urls = body.results.map((r) => r.url).sort();
    expect(urls).toEqual(["repos/alpha-vessel/src/resolvers/alpha.ts", "repos/beta-vessel/src/index.ts"]);
    for (const r of body.results) {
      expect(typeof r.title).toBe("string");
      expect(r.snippet).toContain(SYM);
      expect(r.url).toMatch(/^repos\/[\w.-]+\//);
    }
  });

  it("never reads node_modules, dist, mitosis backups, or a .env file (even with includeHidden)", async () => {
    const body = (await resolveFsGrep({ type: "fs_grep", pattern: SYM, includeHidden: true })).body as Body;
    const urls = body.results.map((r) => r.url).join("\n");
    expect(urls).not.toMatch(/node_modules|dist|mitosis|\.env/);
    expect(JSON.stringify(body)).not.toContain("SECRET=");
  });

  it("a relative repos/<vessel> path resolves against the runtime tree, not process.cwd()", async () => {
    const body = (await resolveFsGrep({ type: "fs_grep", path: "repos/alpha-vessel", pattern: SYM })).body as Body;
    expect(body.results.map((r) => r.url)).toEqual(["repos/alpha-vessel/src/resolvers/alpha.ts"]);
  });

  it("a result url is a citation the oracle re-reads to the file holding the symbol", async () => {
    const body = (await resolveFsGrep({ type: "fs_grep", path: "repos/alpha-vessel", pattern: SYM })).body as Body;
    const r = body.results[0]!;
    const cited = `The symbol is defined at ${r.title}.`.match(CITED_PATH_RE) ?? [];
    expect(cited).toContain(r.url);
    const reread = await readFile(join(superRepo, r.url), "utf8");
    expect(reread).toContain(SYM);
  });

  it("refuses roots outside the read roots and the never-searched locations", async () => {
    await expect(resolveFsGrep({ type: "fs_grep", path: "/etc", pattern: "x" })).rejects.toThrow(/outside workspace root/);
    await expect(resolveFsGrep({ type: "fs_grep", path: "repos/../../..", pattern: "x" })).rejects.toThrow(/outside workspace root/);
  });

  it("is read-only: a search changes nothing on disk, and the resolver has no write or process API", async () => {
    const before = await snapshot(runtime);
    await resolveFsGrep({ type: "fs_grep", pattern: SYM, includeHidden: true });
    expect(await snapshot(runtime)).toEqual(before);
    const src = await readFile(join(import.meta.dir, "../../src/resolvers/fs-grep.ts"), "utf8");
    expect(src).not.toMatch(/\b(writeFile|appendFile|unlink|rmdir|rename|mkdir|copyFile|Bun\.write|Bun\.spawn|spawn|execSync|exec)\s*\(/);
    expect(src).not.toMatch(/from\s+["'](node:)?child_process["']/);
  });
});

describe("fs_grep — the workspace root itself stays searchable", () => {
  it("a root that CONTAINS a never-searched location is not refused; the secret file inside it is skipped", async () => {
    const ws = process.env["WORKSPACE_ROOT"]!;
    await writeFile(join(ws, "notes.md"), `${SYM} in notes\n`);
    await writeFile(join(ws, ".substrate-secrets"), `${SYM}=secret\n`);
    const body = (await resolveFsGrep({ type: "fs_grep", path: ws, pattern: SYM, includeHidden: true })).body as Body;
    expect(JSON.stringify(body)).toContain("notes.md");
    expect(JSON.stringify(body)).not.toContain("=secret");
  });
});

describe("fs_grep — qa10 hardening", () => {
  it("serializes results[] before matches, so a 4000-char observation cut keeps the search results", async () => {
    const body = (await resolveFsGrep({ type: "fs_grep", pattern: SYM })).body as Record<string, unknown>;
    const json = JSON.stringify(body);
    expect(json.indexOf('"results"')).toBeGreaterThanOrEqual(0);
    expect(json.indexOf('"results"')).toBeLessThan(json.indexOf('"matches"'));
    expect(json.slice(0, 4000)).toContain("repos/alpha-vessel/src/resolvers/alpha.ts");
  });

  it("never reads credential-shaped files: .substrate-secrets*, *.pem, *.key, id_*", async () => {
    const dir = join(runtime, "gamma-vessel");
    await mkdir(dir, { recursive: true });
    for (const n of [".substrate-secrets.bak", "server.pem", "tls.key", "id_ed25519", "id_rsa.pub"]) await writeFile(join(dir, n), `${SYM}=leak\n`);
    await writeFile(join(dir, "ok.md"), `${SYM} fine\n`);
    const body = (await resolveFsGrep({ type: "fs_grep", path: "repos/gamma-vessel", pattern: SYM, includeHidden: true })).body as Body;
    expect(body.results.map((r) => r.url)).toEqual(["repos/gamma-vessel/ok.md"]);
    expect(JSON.stringify(body)).not.toContain("=leak");
  });

  it("runs the regex over at most 2000 chars of a line", async () => {
    const dir = join(runtime, "delta-vessel");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "bundle.js"), "x".repeat(5000) + SYM + "\n");
    const body = (await resolveFsGrep({ type: "fs_grep", path: "repos/delta-vessel", pattern: SYM })).body as Body;
    expect(body.results).toEqual([]);
  });

  it("clamps caller-supplied maxDepth and maxFilesScanned", async () => {
    const dir = join(runtime, "epsilon-vessel");
    let d = dir;
    for (let i = 0; i < 15; i++) d = join(d, `d${i}`);
    await mkdir(d, { recursive: true });
    await writeFile(join(d, "deep.ts"), `${SYM}\n`);
    for (let i = 0; i < 3; i++) await writeFile(join(dir, `f${i}.ts`), `${SYM}\n`);
    const deep = (await resolveFsGrep({ type: "fs_grep", path: "repos/epsilon-vessel", pattern: SYM, maxDepth: 1e9 })).body as Body;
    expect(deep.results.some((r) => r.url.endsWith("deep.ts"))).toBe(false);
    const few = (await resolveFsGrep({ type: "fs_grep", path: "repos/epsilon-vessel", pattern: SYM, maxFilesScanned: 0 })).body as Body & { filesScanned: number };
    expect(few.filesScanned).toBe(1);
    expect(few.truncated).toBe(true);
  });
});
