// EVERY VALUE IN A FEATURE_COMPOSE SHELL COMMAND IS ONE SINGLE-QUOTED WORD (security, check-first).
//
// feature_compose sends its shell commands to the tools shell (bash -c). They quoted paths with
// JSON.stringify, which makes a DOUBLE-quoted string, inside which bash still expands `$(…)`, backticks and
// `$VAR`; a few values were interpolated with no quoting at all (the worktree dirs, the reachability grep
// symbols). The semantic gate's diff spliced the file path raw into a single-quoted sed program, so a `'`
// in it ends the quote. The reachability greps took "symbols" from drafted file content: a route string's
// last segment is any text, so a drafted `app.get('/$(…)')` became a command substitution.
//
// Expected:
//   - shq makes one literal word for bash (checked with a real bash -c inside this file's mkdtemp sandbox);
//   - the diff builder hands sed one quoted program, so a path with a `'` cannot leave it;
//   - the grep builders take a symbol only when it is a plain identifier (no `$`), drop anything else, and
//     match exactly what the double-quoted form matched for a benign symbol;
//   - CLASS DETECTOR: no shell-command template literal in feature-compose.ts or super-repo-checkout.ts
//     interpolates anything but a shq(...) word: no JSON.stringify, no bare value.
//
// Hostile payloads run only inside this file's own mkdtemp sandbox, and only through the quoting under test.
import { describe, it, expect, afterAll } from "bun:test";
import { mkdtempSync, existsSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

const fc = (await import("../../src/resolvers/feature-compose.js")) as Record<string, any>;
const src = (await import("../../src/resolvers/super-repo-checkout.js")) as Record<string, any>;

const BOX = mkdtempSync(join(tmpdir(), "fc-shell-quoting-"));
afterAll(() => rmSync(BOX, { recursive: true, force: true }));
const bash = (cmd: string, cwd = BOX) => spawnSync("bash", ["-c", cmd], { cwd, encoding: "utf8", env: { PATH: process.env["PATH"] ?? "/usr/bin:/bin", HOME: BOX } });
const fresh = (name: string) => { const d = join(BOX, `${name}-${Math.random().toString(36).slice(2, 8)}`); mkdirSync(d, { recursive: true }); return d; };

const HOSTILE = (dir: string) => [`$(touch ${dir}/M)`, `\`touch ${dir}/M\``, `'; touch ${dir}/M; '`, "$HOME", "line\nbreak", `a"b$(touch ${dir}/M)"c`];

describe("shq: one literal shell word", () => {
  it("MUST-FAIL: bash reads every hostile value back literally and runs none of it", () => {
    expect(typeof fc.shq).toBe("function");
    const d = fresh("shq");
    for (const v of HOSTILE(d)) {
      const r = bash(`printf %s ${fc.shq(v)}`);
      expect(r.stdout).toBe(v);
      expect(existsSync(join(d, "M"))).toBe(false);
    }
  });
});

describe("the semantic gate's diff command", () => {
  it("MUST-FAIL: a path with a single quote or a substitution cannot leave the sed program or the diff arguments", () => {
    expect(typeof fc.semanticGateDiffCommand).toBe("function");
    const d = fresh("diff");
    const repo = join(d, "repos", "v", "src");
    mkdirSync(repo, { recursive: true });
    const tmp = join(d, "orig");
    writeFileSync(tmp, "a\n");
    for (const name of ["x';touch M;'.ts", "y$(touch M).ts", "z`touch M`.ts", "plain.ts"]) {
      const abs = join(repo, name);
      writeFileSync(abs, "b\n");
      writeFileSync(tmp, "a\n");
      const r = bash(fc.semanticGateDiffCommand(tmp, abs), d);
      expect(existsSync(join(d, "M"))).toBe(false);
      expect(r.stdout.split("\n").slice(0, 2)).toEqual([`--- a/v/src/${name}`, `--- a/v/src/${name}`]);
      expect(r.stdout).toContain("-a\n+b");
      expect(existsSync(tmp)).toBe(false); // the builder still removes its temp copy
    }
  });
});

describe("the reachability grep builders", () => {
  const OLD_CALLERS_FULL = (symbol: string, vAbs: string) => `grep -rEn --exclude-dir=node_modules --exclude-dir=.git --exclude-dir=dist "\\b${symbol}\\b" ${JSON.stringify(vAbs)} 2>/dev/null | grep -vE "(function|const|let|var)[[:space:]]+${symbol}\\b" | grep -vE "^[^:]+:[0-9]+:[[:space:]]*${symbol}[[:space:]]*\\([^)]*\\)[[:space:]]*(:[^={]+)?\\{" | grep -vE ":[0-9]+:[[:space:]]*(import|export)[[:space:]{]" || true`;
  const OLD_ENTRY_FULL = (symbol: string, vAbs: string) => `grep -rEn "(export[[:space:]]+(async[[:space:]]+)?(function|const|let)[[:space:]]+${symbol}\\b|export[[:space:]]+default[[:space:]]+(async[[:space:]]+)?(function[[:space:]]+)?${symbol}\\b|export[[:space:]]*\\{[^}]*${symbol}\\b|case[[:space:]]+[\\"']${symbol}[\\"']|['\\"]${symbol}['\\"][[:space:]]*[:,)]|\\.(on|get|post|put|delete|use)\\([^)]*${symbol}|router\\.[a-z]+\\([^)]*${symbol})" ${JSON.stringify(vAbs)} 2>/dev/null || true`;
  const OLD_CALLERS_SRC = (symbol: string, vAbs: string) => `grep -rEn "\\b${symbol}\\b" ${JSON.stringify(vAbs)} 2>/dev/null | grep -vE "(function|const|let|var)[[:space:]]+${symbol}\\b" | grep -vE "^[^:]+:[0-9]+:[[:space:]]*${symbol}[[:space:]]*\\([^)]*\\)[[:space:]]*(:[^={]+)?\\{" || true`;
  const OLD_ENTRY_SRC = (symbol: string, vAbs: string) => `grep -rEn "(export[[:space:]]+(async[[:space:]]+)?(function|const|let)[[:space:]]+${symbol}\\b|case[[:space:]]+[\\"']${symbol}[\\"']|['\\"]${symbol}['\\"][[:space:]]*[:,)]|\\.(on|get|post|put|delete|use)\\([^)]*${symbol}|router\\.[a-z]+\\([^)]*${symbol})" ${JSON.stringify(vAbs)} 2>/dev/null || true`;
  const OLD_MENTIONS = (name: string, vAbs: string) => `grep -rEn "\\b${name}\\b" ${JSON.stringify(vAbs)} 2>/dev/null | head -8 || true`;
  const SOURCE = [
    "import { pickProducer } from \"./a\";",
    "export function pickProducer(xs: string[]): string { return xs[0]; }",
    "const chosen = pickProducer([\"a\"]);",
    "switch (k) { case \"pickProducer\": break; }",
    "const table = { 'pickProducer': 1 };",
    "app.get(\"/x\", pickProducer);",
    "router.post(\"/y\", pickProducer);",
    "export default pickProducer;",
    "export { pickProducer as other };",
    "  pickProducer(a) {",
  ].join("\n");

  it("CONTROL: for a benign symbol each builder matches exactly what the double-quoted form matched", () => {
    for (const k of ["reachabilityCallersCommand", "reachabilityEntrypointCommand", "symbolMentionsCommand"]) expect(typeof fc[k]).toBe("function");
    const d = fresh("grep");
    const root = join(d, "v", "src");
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, "f.ts"), SOURCE + "\n");
    const pairs: Array<[string, string]> = [
      [OLD_CALLERS_FULL("pickProducer", root), fc.reachabilityCallersCommand("pickProducer", root, true)],
      [OLD_ENTRY_FULL("pickProducer", root), fc.reachabilityEntrypointCommand("pickProducer", root, true)],
      [OLD_CALLERS_SRC("pickProducer", root), fc.reachabilityCallersCommand("pickProducer", root, false)],
      [OLD_ENTRY_SRC("pickProducer", root), fc.reachabilityEntrypointCommand("pickProducer", root, false)],
      [OLD_MENTIONS("pickProducer", root), fc.symbolMentionsCommand("pickProducer", root)],
    ];
    for (const [oldCmd, newCmd] of pairs) {
      expect(typeof newCmd).toBe("string");
      const before = bash(oldCmd).stdout;
      expect(before.length).toBeGreaterThan(0);
      expect(bash(newCmd).stdout).toBe(before);
    }
  });

  it("MUST-FAIL: a symbol that is not a plain identifier builds no command (dropped), so nothing reaches the shell", () => {
    for (const k of ["reachabilityCallersCommand", "reachabilityEntrypointCommand", "symbolMentionsCommand", "grepSymbol"]) expect(typeof fc[k]).toBe("function");
    const d = fresh("grep-hostile");
    for (const s of [...HOSTILE(d), "$PATH", "a$b", "a-b", "1abc", ""]) {
      expect(fc.grepSymbol(s)).toBeNull();
      expect(fc.reachabilityCallersCommand(s, d, true)).toBeNull();
      expect(fc.reachabilityEntrypointCommand(s, d, false)).toBeNull();
      expect(fc.symbolMentionsCommand(s, d)).toBeNull();
    }
    expect(fc.grepSymbol("pick_Producer2")).toBe("pick_Producer2");
  });

  it("MUST-FAIL: a drafted route string whose last segment is a substitution yields no grep symbol", () => {
    expect(typeof fc.grepSymbol).toBe("function");
    const d = fresh("route");
    const content = ["import x from \"y\";", "app.get('/api/$(touch M)', (req) => {", "  return 1;", "});"].join("\n");
    const diff = ["### /v/src/r.ts", "+  return 1;"].join("\n");
    const encl = fc.enclosingSymbolsForHunks(diff, new Map([["/v/src/r.ts", content]])) as Map<string, string[]>;
    const raw = [...encl.values()].flat();
    expect(raw.length).toBeGreaterThan(0); // the extractor still yields the route segment ...
    expect(raw.map((s) => fc.grepSymbol(s)).filter((s) => s !== null)).toEqual([]); // ... and none of it is usable
    expect(existsSync(join(d, "M"))).toBe(false);
  });
});

/**
 * The template literals in `text`, each with the offset it starts at and its `${…}` expressions (outermost level
 * only). Strings, comments, regex-free enough for this source: quotes, line and block comments, escaped `\${`.
 */
function templates(text: string): Array<{ start: number; exprs: string[]; raw: string }> {
  const out: Array<{ start: number; exprs: string[]; raw: string }> = [];
  let i = 0;
  const n = text.length;
  const skipString = (q: string) => { i++; while (i < n && text[i] !== q) { if (text[i] === "\\") i++; i++; } i++; };
  // Reads a template starting at text[i] === "`"; returns its exprs and leaves i after the closing backtick.
  const readTemplate = (): { exprs: string[]; raw: string } => {
    const begin = i;
    i++;
    const exprs: string[] = [];
    while (i < n && text[i] !== "`") {
      if (text[i] === "\\") { i += 2; continue; }
      if (text[i] === "$" && text[i + 1] === "{") {
        i += 2;
        const e0 = i;
        let depth = 1;
        while (i < n && depth > 0) {
          const c = text[i]!;
          if (c === "'" || c === '"') { skipString(c); continue; }
          if (c === "`") { readTemplate(); continue; }
          if (c === "{") depth++;
          else if (c === "}") depth--;
          if (depth > 0) i++;
        }
        exprs.push(text.slice(e0, i));
        i++;
        continue;
      }
      i++;
    }
    i++;
    return { exprs, raw: text.slice(begin, i) };
  };
  while (i < n) {
    const c = text[i]!;
    if (c === "/" && text[i + 1] === "/") { while (i < n && text[i] !== "\n") i++; continue; }
    if (c === "/" && text[i + 1] === "*") { const e = text.indexOf("*/", i + 2); i = e < 0 ? n : e + 2; continue; }
    if (c === "'" || c === '"') { skipString(c); continue; }
    if (c === "`") { const start = i; const t = readTemplate(); out.push({ start, ...t }); continue; }
    // A regex literal after these tokens: skip it so a quote or backtick inside it is not read as a string.
    if (c === "/" && /[(,=:[!&|?{};]\s*$/.test(text.slice(Math.max(0, i - 20), i))) {
      i++;
      let cls = false;
      while (i < n && text[i] !== "\n") { const ch = text[i]!; if (ch === "\\") { i += 2; continue; } if (ch === "[") cls = true; else if (ch === "]") cls = false; else if (ch === "/" && !cls) break; i++; }
      i++;
      continue;
    }
    i++;
  }
  return out;
}
/** Is `expr` exactly one shq(...) call? */
// The ONE non-shq interpolation allowed: the scrubbed-env prefix (src/test-child-env.ts). It is shell SYNTAX built
// from constants (`env -i PATH="$PATH" ...`), never a value, and quoting it would break it. Exact call text only, no
// arguments: anything else interpolated bare is still an offender. Its content is pinned by
// vessel-mitosis-evaluate-child-env.test.ts.
const SHELL_SYNTAX_FRAGMENTS = new Set(["testChildEnvShellPrefix()"]);
const isShqWord = (expr: string): boolean => {
  const e = expr.trim();
  if (SHELL_SYNTAX_FRAGMENTS.has(e)) return true;
  if (!e.startsWith("shq(") || !e.endsWith(")")) return false;
  let depth = 0;
  for (let k = 3; k < e.length; k++) { if (e[k] === "(") depth++; else if (e[k] === ")") { depth--; if (depth === 0 && k !== e.length - 1) return false; } }
  return depth === 0;
};
/** Shell-command templates: assigned to `command:` / `cmd =`, or returned by a *Command builder. */
function shellTemplates(text: string) {
  return templates(text).filter((t) => {
    const before = text.slice(Math.max(0, t.start - 60), t.start);
    if (/\b(command|cmd)\s*[:=]\s*$/.test(before)) return true;
    if (/\breturn\s*$/.test(before)) {
      const fn = [...text.slice(0, t.start).matchAll(/function\s+([A-Za-z_$][\w$]*)\s*\(/g)].pop()?.[1] ?? "";
      return /Command$/.test(fn);
    }
    return false;
  });
}
const FC_SRC = readFileSync(join(import.meta.dir, "..", "..", "src", "resolvers", "feature-compose.ts"), "utf8");
const SRC_SRC = readFileSync(join(import.meta.dir, "..", "..", "src", "resolvers", "super-repo-checkout.ts"), "utf8");

describe("CLASS DETECTOR: every value in a shell-command template is a shq word", () => {
  for (const [file, text] of [["feature-compose.ts", FC_SRC], ["super-repo-checkout.ts", SRC_SRC]] as const) {
    it(`MUST-FAIL: ${file} has no shell-command template interpolating JSON.stringify or a bare value`, () => {
      const shells = shellTemplates(text);
      expect(shells.length).toBeGreaterThan(file === "feature-compose.ts" ? 35 : 0);
      const offenders = shells.flatMap((t) => t.exprs.filter((e) => !isShqWord(e)).map((e) => `${text.slice(0, t.start).split("\n").length}: \${${e}}`));
      expect(offenders).toEqual([]);
    });
  }
  it("CONTROL: the detector sees through nesting and ignores JSON bodies and escaped \\${…}", () => {
    const sample = [
      "const a = { command: `cd ${shq(`${ROOT}/${v}`)} && echo \\${PIPESTATUS[0]}` };",
      "const b = JSON.stringify({ x: `${JSON.stringify(y)}` });",
      "const c = { command: `rm -f ${JSON.stringify(f)}` };",
      "const cmd = `rg x ${v} | sort`;",
      "function buildCommand(p) { return `ls ${shq(p)} ${p}`; }",
    ].join("\n");
    const offenders = shellTemplates(sample).flatMap((t) => t.exprs.filter((e) => !isShqWord(e)));
    expect(offenders).toEqual(["JSON.stringify(f)", "v", "p"]);
  });
});

describe("per-site pins: the listed sites build their commands with shq", () => {
  const pins: Array<[string, number]> = [
    ["cd ${shq(vAbs)} 2>/dev/null && { find src", 1],
    ["grep -rnE -A3 ${shq(pattern)} src", 1],
    ["grep -rnE ${shq(pattern)} src", 1],
    ["status --porcelain -- ${shq(`repos/${vesselName}`)}", 1],
    ["ln -sfn ${shq(inTreePath)} ${shq(runtimePath)}", 1],
    ["rm -rf ${shq(runtimePath)}", 1],
    ["ln -sfn ${shq(clonePath)} ${shq(runtimePath)}", 1],
    ["mkdir -p ${shq(dir)}", 3],
    ["cat ${shq(abs)}", 3],
    ["worktree add -q --detach ${shq(bwO)} HEAD", 1],
    ["worktree add -q --detach ${shq(bw)} HEAD", 1],
    ["show ${shq(\"HEAD:\" + own.test_file)}", 1],
    ["command: semanticGateDiffCommand(tmp, abs)", 1],
    ["rm -f ${shq(f)}", 1],
    ["test -d ${shq(`/workspace/git/vessels/${vessel}`)}", 1],
    ["test -f ${shq(liveAbs)} && cat ${shq(liveAbs)}", 1],
    ["show ${shq(`HEAD:${changedRel[0]}`)}", 1],
    ["rm -rf ${shq(mitosisRoot)}", 1],
    ["rm -f ${shq(abs)}", 1],
  ];
  it("MUST-FAIL: each pinned site carries its shq form", () => {
    const missing = pins.filter(([snippet, min]) => FC_SRC.split(snippet).length - 1 < min).map(([s]) => s);
    expect(missing).toEqual([]);
    expect(SRC_SRC).toContain("checkout origin/dev -- ${shq(`repos/${vesselName}`)}");
  });
  it("CONTROL: the materialization still goes through its granted builder", () => {
    expect(typeof src.superRepoCheckoutCall).toBe("function");
    expect(FC_SRC).toContain("superRepoCheckoutCall(SUPER_REPO_ROOT, vesselName, METABOB_API_KEY)");
  });
});
