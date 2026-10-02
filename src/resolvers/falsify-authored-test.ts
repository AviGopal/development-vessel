// falsify-authored-test — gap_falsify rule `authored_test`, the FIX-FIRST piece: the static checker and the
// contained, unprivileged runner for an LLM-drafted test file.
//
// WHY THIS EXISTS. gap_falsify can only point a gap at an EXISTING failing test, and for most defects none
// exists; the step that produced every fast landing was a hand-written red test plus controls. Slice S makes
// gap_falsify draft that test. A drafted test is model-written code, and the lane's run_suite runs as root
// with the fleet's env, next to the live stores. The qa ruling: drafted code NEVER runs as root. This module
// is the only place an authored test runs until run_suite itself is unprivileged.
//
// It lives OUTSIDE gap-lifecycle-scan.ts / gap-to-feature.ts (both autonomy-scope excluded) so the lane can
// repair it; gap_falsify calls it (operator bootstrap: one call-site line).
//
// TWO LAYERS, and only one of them is the boundary:
//  - checkDraftStatic is DEFENCE IN DEPTH. It parses the draft with the TypeScript parser and refuses the
//    escape classes it can see (child processes, eval, dynamic import, network, fs writes, process.env,
//    /proc, leaked intervals, port binding, global aliasing) plus RELEVANCE: the red must reference the
//    gap's defect signature. Its known bypasses are listed at the bottom of this header — it is not a
//    sandbox and nothing may rely on it as one.
//  - runContained IS THE BOUNDARY. Measured in substrate-live (rootless podman, --privileged) 2026-10-02:
//      unshare --net --mount --pid --fork --mount-proc   works  (fetch → FailedToOpenSocket; uncontained
//                                                                the same loopback fetch → ConnectionRefused)
//      bind vessel → /mnt/v, remount ro                    works  (write → EROFS) — the vessel dir must be a
//                                                                mount point first: a plain dir cannot be
//                                                                remounted ro (mount exits 32)
//      tmpfs on /tmp and /dev/shm                           works  (private tmp)
//      setpriv --reuid/--regid 65534 --clear-groups
//        --no-new-privs --inh-caps=-all --bounding-set=-all works  (uid=65534; root-owned 755 dir → EACCES;
//                                                                /etc/substrate/env is 600 root → unreadable)
//    bun lives under /root (700), so nobody cannot exec it in place: the binary is bind-mounted read-only to
//    /mnt/bin/bun inside the namespace. The env is an allowlist (PATH, HOME, TMPDIR, WORKSPACE_ROOT,
//    NO_COLOR) — not a denylist, for the reason agent-shell-env.ts (local-tools) gives: the env file's set of
//    names is open. Every path reaches the in-namespace script as a POSITIONAL argument, never interpolated.
//    Anything missing (not root, no setpriv/unshare, no /mnt, a mount failing) FAILS CLOSED: the draft does
//    not run at all and the result says why.
//
// THE GUARANTEE IS CHECKED INSIDE THE SANDBOX, NOT ASSUMED. In the SAME sandbox instance, as the same uid
// with the same env, a probe program runs first and checks every layer (uid 65534, no interface but lo,
// /mnt/v mounted ro, /tmp a private tmpfs that hides the host /tmp, env on the allowlist) and that every
// live store is unwritable (access W_OK → EROFS/EACCES/ENOENT). The draft runs only if ALL are green;
// `contained: true` is returned only then, with the probe results attached. A sandbox missing any single
// layer is refused by that layer's probe and the draft never executes (containmentSelfCheck proves this
// per layer, with a marker the fixture prints at import). There is no mtime heuristic: whether a store can
// be written is answered from inside, deterministically.
//
// AFTER THE RUN: tree_clean — `git status --porcelain` of the worktree is UNCHANGED from before the run
// ("unchanged", not "empty": the drafted test is itself uncommitted in the scratch worktree).
//
// RED IS A NAMED ASSERTION FAILURE. parseBunRun reports a test as `fail` with `assertion: true` only when
// bun printed an expect() failure for it. A thrown error, a timeout, a module-load error ("Unhandled error
// between tests") or a test that never ran is never red — f4ceb0f was a load failure read as red.
//
// KNOWN STATIC-CHECKER BYPASSES (the containment, not the checker, answers these):
//  - the edit_site module itself: the draft may call anything the site exports or reaches transitively
//    (a site that spawns, fetches or writes does so with the draft's arguments);
//  - import-time side effects of the edit_site module (servers, timers, writes at load) are not inspected;
//  - prototype / module mutation through values the site returns (e.g. a returned object's methods);
//  - paths assembled at runtime ("/pr" + "oc") evade the sensitive-literal rule — reads are bounded by the
//    uid drop and the pid namespace's own /proc, not by the checker;
//  - setTimeout chains that re-arm themselves (only setInterval-without-clearInterval is refused);
//  - anything reachable through an allowed builtin's less obvious surface (node:os, node:crypto, node:util).
import { spawn, execFileSync } from "node:child_process";
import { chmodSync, chownSync, closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, isAbsolute, join, posix, relative, resolve } from "node:path";
import ts from "typescript";
import { parseOwnCheckFailures } from "./retry-evidence.js";

// ─── static checker ─────────────────────────────────────────────────────────────────────────────

export type StaticVerdict = { ok: true } | { ok: false; rule: string; detail: string };

export interface CheckDraftOptions {
  /** Where the draft will live, vessel-relative (e.g. test/resolvers/x.localize.test.ts). With it, a
   *  relative import is resolved exactly; without it, it is matched by its extensionless path suffix. */
  testFileRel?: string;
  /** The tests the caller will read as RED. Each must exist and reference the defect signature. Without
   *  them, at least one test must reference it. */
  redNames?: string[];
}

/** Node builtins a drafted test may import (bare or `node:`-prefixed). fs is further restricted to reads. */
const ALLOWED_BUILTINS = new Set(["assert", "assert/strict", "path", "url", "util", "os", "buffer", "events", "crypto", "string_decoder", "querystring", "fs", "fs/promises"]);
const NETWORK_MODULES = new Set(["net", "http", "https", "http2", "dgram", "tls", "dns", "dns/promises", "undici", "ws"]);
/** fs names a draft may import by name: reads only. Anything else from fs is a write or an escape. */
const FS_READ_NAMES = new Set(["readFileSync", "existsSync", "statSync", "lstatSync", "readdirSync", "realpathSync", "accessSync", "constants", "readFile", "stat", "lstat", "readdir", "access", "realpath"]);
/** Bun.* members with no process, fs, or network reach. */
const BUN_ALLOWED = new Set(["deepEquals", "inspect", "sleep", "nanoseconds", "version", "revision", "hash", "escapeHTML", "stringWidth", "peek", "CryptoHasher"]);
const IMPORT_META_ALLOWED = new Set(["dir", "dirname", "path", "url", "file", "filename"]);
const NETWORK_GLOBALS = new Set(["fetch", "WebSocket", "XMLHttpRequest", "EventSource", "navigator"]);
const GLOBAL_ALIASES = new Set(["globalThis", "global", "self", "window"]);
const PORT_MEMBERS = new Set(["listen", "createServer", "serve"]);
const SENSITIVE_PATHS: Array<[RegExp, string]> = [
  [/\/proc(\/|\b)/, "proc_read"],
  [/\/etc\/|\.substrate-secrets|^\/root(\/|$)|\/root\/\.|\/run\/secrets/, "sensitive_path"],
];

const stripExt = (p: string): string => p.replace(/\.(d\.)?[cm]?[jt]sx?$/, "");
/** "repos/<vessel>/src/x.ts" and "./src/x.ts" → "src/x.ts". */
const normSite = (p: string): string => stripExt(posix.normalize(p.replace(/\\/g, "/")).replace(/^\.\//, "").replace(/^repos\/[^/]+\//, ""));

const bareModule = (spec: string): string => spec.replace(/^node:/, "");

function isRelative(spec: string): boolean {
  return spec.startsWith("./") || spec.startsWith("../");
}

/** Where a relative specifier lands, vessel-relative and extensionless; null when it leaves the vessel. */
function resolveRelative(spec: string, testFileRel: string | undefined): { exact: string | null; suffix: string } {
  const suffix = stripExt(spec.replace(/^(\.\.?\/)+/, ""));
  if (!testFileRel) return { exact: null, suffix };
  const joined = posix.normalize(posix.join(posix.dirname(testFileRel.replace(/\\/g, "/")), spec));
  return { exact: joined.startsWith("../") ? null : stripExt(joined), suffix };
}

function isVesselEntry(p: string): boolean {
  return /(^|\/)src\/index$/.test(p) || p === "index";
}

/** Classify one module specifier. Returns a refusal or null (allowed). `fsBindings` collects fs imports. */
function checkSpecifier(spec: string, site: string, testFileRel: string | undefined): { rule: string; detail: string } | null {
  if (spec === "bun:test") return null;
  if (spec === "bun") return { rule: "bun_module", detail: `imports the "bun" module (spawn, $, write, serve live there)` };
  if (isRelative(spec)) {
    const r = resolveRelative(spec, testFileRel);
    const landing = r.exact ?? r.suffix;
    if (isVesselEntry(landing)) return { rule: "vessel_entry", detail: `imports the vessel entry (${spec}); it binds a port and starts timers at import` };
    if (r.exact !== null ? r.exact === site : site === r.suffix || site.endsWith("/" + r.suffix)) return null;
    return { rule: "import_not_allowed", detail: `relative import ${spec} is not the edit site ${site}` };
  }
  const bare = bareModule(spec);
  if (bare === "child_process") return { rule: "child_process", detail: `imports ${spec}` };
  if (NETWORK_MODULES.has(bare)) return { rule: "network", detail: `imports ${spec}` };
  if (bare === "worker_threads" || bare === "cluster") return { rule: "worker", detail: `imports ${spec}` };
  if (ALLOWED_BUILTINS.has(bare) && (spec.startsWith("node:") || !spec.includes("/") || bare.includes("/"))) return null;
  return { rule: "import_not_allowed", detail: `imports ${spec}: only the edit site, bun:test and allowlisted node builtins are allowed` };
}

interface TestCall { name: string; node: ts.Node }

function stringValue(n: ts.Node | undefined): string | null {
  if (!n) return null;
  if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) return n.text;
  return null;
}

/** Does this subtree reference the signature as code (identifier, property name, string/template text)?
 *  Comments are not nodes, so a comment-only mention never counts. */
function referencesSignature(node: ts.Node, sig: string): boolean {
  let hit = false;
  const visit = (n: ts.Node): void => {
    if (hit) return;
    if (ts.isIdentifier(n) && ts.idText(n) === sig) { hit = true; return; }
    if ((ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n) || ts.isTemplateHead(n) || ts.isTemplateMiddle(n) || ts.isTemplateTail(n)) && n.text.includes(sig)) { hit = true; return; }
    ts.forEachChild(n, visit);
  };
  visit(node);
  return hit;
}

/** The callee of a test registration: test/it, test.each(...), test.skip… — or null. */
function testCallee(call: ts.CallExpression): { base: string; member: string | null } | null {
  let e: ts.Expression = call.expression;
  if (ts.isCallExpression(e)) e = e.expression;                 // test.each(table)("name", fn)
  if (ts.isIdentifier(e) && (e.text === "test" || e.text === "it")) return { base: e.text, member: null };
  if (ts.isPropertyAccessExpression(e) && ts.isIdentifier(e.expression) && (e.expression.text === "test" || e.expression.text === "it")) {
    return { base: e.expression.text, member: ts.idText(e.name) };
  }
  return null;
}

/**
 * Refuse a drafted test file that reaches past its edit site. Defence in depth — runContained is the
 * boundary. `editSiteRel` is vessel-relative (a `repos/<vessel>/` prefix is stripped); `defectSignature` is
 * the identifier or literal step 1 found in the site.
 */
export function checkDraftStatic(source: string, editSiteRel: string, defectSignature: string, opts: CheckDraftOptions = {}): StaticVerdict {
  const refuse = (rule: string, detail: string): StaticVerdict => ({ ok: false, rule, detail });
  const site = normSite(editSiteRel);
  if (isVesselEntry(site)) return refuse("vessel_entry", `the edit site ${editSiteRel} is the vessel entry`);
  const sig = String(defectSignature ?? "").trim();
  if (sig.length < 3) return refuse("signature_too_weak", `defect signature ${JSON.stringify(sig)} is too short to tie a red to the defect`);

  const sf = ts.createSourceFile(opts.testFileRel ?? "draft.test.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const diags = (sf as unknown as { parseDiagnostics?: readonly ts.Diagnostic[] }).parseDiagnostics ?? [];
  if (diags.length > 0) return refuse("parse_error", ts.flattenDiagnosticMessageText(diags[0]!.messageText, " "));

  let refusal: StaticVerdict | null = null;
  let usesSetInterval = false;
  let usesClearInterval = false;
  const tests: TestCall[] = [];
  const fail = (rule: string, detail: string): void => { if (!refusal) refusal = refuse(rule, detail); };

  const checkImportClause = (spec: string, clause: ts.ImportClause | undefined, exportClause: ts.NamedExportBindings | undefined): void => {
    const r = checkSpecifier(spec, site, opts.testFileRel);
    if (r) return fail(r.rule, r.detail);
    const bare = bareModule(spec);
    if (bare !== "fs" && bare !== "fs/promises") return;
    if (exportClause && !ts.isNamedExports(exportClause)) return fail("fs_namespace", `re-exports ${spec} as a namespace`);
    if (clause?.name) return fail("fs_namespace", `default-imports ${spec}; only named read functions are allowed`);
    const named = clause?.namedBindings ?? exportClause;
    if (named && !ts.isNamedImports(named) && !ts.isNamedExports(named)) return fail("fs_namespace", `namespace-imports ${spec}; only named read functions are allowed`);
    const elements = named ? (named as ts.NamedImports | ts.NamedExports).elements : [];
    for (const el of elements) {
      const n = el.propertyName ?? el.name;
      const imported = ts.isIdentifier(n) ? ts.idText(n) : n.text;   // `import { "x" as y }` names a string
      if (!FS_READ_NAMES.has(imported)) return fail("fs_write", `imports ${imported} from ${spec}`);
    }
  };

  const visit = (n: ts.Node): void => {
    if (refusal) return;
    if (ts.isImportDeclaration(n)) {
      const spec = stringValue(n.moduleSpecifier);
      if (spec === null) return fail("import_not_allowed", "non-literal module specifier");
      checkImportClause(spec, n.importClause, undefined);
      return;                                                     // bindings are names, not uses
    }
    if (ts.isExportDeclaration(n) && n.moduleSpecifier) {
      const spec = stringValue(n.moduleSpecifier);
      if (spec === null) return fail("import_not_allowed", "non-literal module specifier");
      checkImportClause(spec, undefined, n.exportClause);
      return;
    }
    if (ts.isImportEqualsDeclaration(n)) return fail("require", "import = require(...)");
    if (ts.isCallExpression(n) && n.expression.kind === ts.SyntaxKind.ImportKeyword) return fail("dynamic_import", "dynamic import()");
    if (ts.isMetaProperty(n) && n.keywordToken === ts.SyntaxKind.ImportKeyword) {
      const p = n.parent;
      if (!(ts.isPropertyAccessExpression(p) && p.expression === n && IMPORT_META_ALLOWED.has(ts.idText(p.name)))) {
        return fail("import_meta", `import.meta${ts.isPropertyAccessExpression(p) ? "." + ts.idText(p.name) : ""}`);
      }
    }
    if (ts.isCallExpression(n)) {
      const callee = testCallee(n);
      if (callee) {
        if (callee.member === "only") return fail("test_only", `${callee.base}.only changes which tests run`);
        const name = stringValue(n.arguments[0]);
        if (name !== null) tests.push({ name, node: n });
      }
    }
    if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n) || ts.isTemplateHead(n) || ts.isTemplateMiddle(n) || ts.isTemplateTail(n)) {
      for (const [re, rule] of SENSITIVE_PATHS) if (re.test(n.text)) return fail(rule, `path literal ${JSON.stringify(n.text.slice(0, 80))}`);
    }
    if (ts.isElementAccessExpression(n)) {
      const key = stringValue(n.argumentExpression);
      if (key === "constructor") return fail("function_constructor", `["constructor"] access`);
    }
    if (ts.isPropertyAccessExpression(n)) {
      const member = ts.idText(n.name);
      if (member === "constructor") return fail("function_constructor", ".constructor access");
      if (PORT_MEMBERS.has(member) && !(ts.isIdentifier(n.expression) && n.expression.text === "Bun")) return fail("binds_port", `.${member}`);
    }
    if (ts.isIdentifier(n) && isValuePosition(n)) {
      const id = ts.idText(n);
      if (id === "setInterval") usesSetInterval = true;
      if (id === "clearInterval") usesClearInterval = true;
      if (id === "eval") return fail("eval", "eval");
      if (id === "Function") return fail("function_constructor", "Function");
      if (id === "require" || id === "module") return fail("require", id);
      if (id === "Worker" || id === "SharedWorker") return fail("worker", id);
      if (NETWORK_GLOBALS.has(id)) return fail("network", id);
      if (GLOBAL_ALIASES.has(id)) return fail("global_alias", `${id} reaches every global by computed name`);
      if (PORT_MEMBERS.has(id)) return fail("binds_port", id);
      if (id === "process") {
        const p = n.parent;
        const member = ts.isPropertyAccessExpression(p) && p.expression === n ? ts.idText(p.name) : null;
        if (member === "env") return fail("process_env", "process.env");
        return fail("process", `process${member ? "." + member : ""}`);
      }
      if (id === "Bun") {
        const p = n.parent;
        const member = ts.isPropertyAccessExpression(p) && p.expression === n ? ts.idText(p.name) : null;
        if (member !== null && BUN_ALLOWED.has(member)) { /* allowed */ }
        else if (member === "spawn" || member === "spawnSync") return fail("bun_spawn", `Bun.${member}`);
        else if (member === "$") return fail("bun_shell", "Bun.$");
        else if (member === "write" || member === "file") return fail("fs_write", `Bun.${member}`);
        else if (member === "serve" || member === "listen") return fail("binds_port", `Bun.${member}`);
        else if (member === "connect" || member === "udpSocket") return fail("network", `Bun.${member}`);
        else return fail("bun_global", member ? `Bun.${member}` : "Bun used as a value");
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  if (refusal) return refusal;
  if (usesSetInterval && !usesClearInterval) return refuse("timer_leak", "setInterval with no clearInterval outlives the test");

  if (tests.length === 0) return refuse("relevance", "no test(...) / it(...) with a literal name");
  const refs = (t: TestCall): boolean => t.name.includes(sig) || referencesSignature(t.node, sig);
  if (opts.redNames && opts.redNames.length > 0) {
    for (const red of opts.redNames) {
      const t = tests.find((x) => x.name === red);
      if (!t) return refuse("relevance", `named red ${JSON.stringify(red)} is not a test in the draft`);
      if (!refs(t)) return refuse("relevance", `red ${JSON.stringify(red)} never references the defect signature ${JSON.stringify(sig)}`);
    }
  } else if (!tests.some(refs)) {
    return refuse("relevance", `no test references the defect signature ${JSON.stringify(sig)}`);
  }
  return { ok: true };
}

/** An identifier that names a value being USED — not a property name after a dot, an object-literal key,
 *  or a declaration/import name. `obj.fetch` is not `fetch`; `{ fetch }` (shorthand) is. */
function isValuePosition(n: ts.Identifier): boolean {
  const p = n.parent;
  if (!p) return true;
  if (ts.isPropertyAccessExpression(p) && p.name === n) return false;
  if ((ts.isPropertyAssignment(p) || ts.isPropertyDeclaration(p) || ts.isMethodDeclaration(p) || ts.isPropertySignature(p) || ts.isMethodSignature(p) || ts.isGetAccessor(p) || ts.isSetAccessor(p) || ts.isEnumMember(p)) && p.name === n) return false;
  if (ts.isImportSpecifier(p) || ts.isExportSpecifier(p) || ts.isImportClause(p) || ts.isNamespaceImport(p)) return false;
  if (ts.isQualifiedName(p) && p.right === n) return false;
  if (ts.isLabeledStatement(p) || ts.isBreakOrContinueStatement(p)) return false;
  return true;
}

// ─── bun output ─────────────────────────────────────────────────────────────────────────────────

export type TestStatus = "pass" | "fail" | "notrun";
export interface TestResult { name: string; status: TestStatus; assertion: boolean }
export interface ParsedRun { loaded: boolean; unnamed_failures: number; results: TestResult[] }

const RESULT_LINE = /^\s*\((pass|fail)\)\s*(.*?)\s*(?:\[[\d.]+m?s\])?\s*$/;

/**
 * Read one `bun test` run of ONE file (output written to a file, so bun prints (pass)/(fail) lines).
 * `loaded`: bun printed its summary and no file-level error. `unnamed_failures`: the `N error(s)` summary,
 * or the count of "Unhandled error between tests" markers when larger. A test is `fail` with
 * `assertion: true` only when bun printed an expect() failure for it; a requested name bun never printed is
 * `notrun`. With `onlyTests` empty, every printed test is reported under its full name.
 */
export function parseBunRun(raw: string, onlyTests: string[]): ParsedRun {
  const text = String(raw ?? "");
  let summaryErrors: number | null = null;
  let markers = 0;
  let sawPass = false;
  let sawFail = false;
  const printed: Array<{ full: string; status: "pass" | "fail" }> = [];
  for (const line of text.split("\n")) {
    const e = line.match(/^\s*(\d+)\s+errors?\s*$/);
    if (e && e[1]) summaryErrors = parseInt(e[1], 10);
    if (/^\s*\d+\s+pass\s*$/.test(line)) sawPass = true;
    if (/^\s*\d+\s+fail\s*$/.test(line)) sawFail = true;
    if (line.includes("Unhandled error between tests")) markers++;
    const m = RESULT_LINE.exec(line);
    if (m) printed.push({ status: m[1] as "pass" | "fail", full: m[2] ?? "" });
  }
  const unnamed = Math.max(summaryErrors ?? 0, markers);
  const loaded = sawPass && sawFail && unnamed === 0;
  const failures = parseOwnCheckFailures(text);
  const isAssertion = (full: string): boolean => {
    const f = failures.find((x) => x.name === full);
    if (!f) return false;
    return Boolean(f.expected || f.received || f.diff) || /^error:\s*expect\(/.test(f.error ?? "");
  };
  const matches = (full: string, want: string): boolean => full === want || full.endsWith(` > ${want}`);
  if (onlyTests.length === 0) {
    return { loaded, unnamed_failures: unnamed, results: printed.map((p) => ({ name: p.full, status: p.status, assertion: p.status === "fail" && isAssertion(p.full) })) };
  }
  const results = onlyTests.map((want): TestResult => {
    const hits = printed.filter((p) => matches(p.full, want));
    if (hits.length === 0) return { name: want, status: "notrun", assertion: false };
    const failed = hits.find((h) => h.status === "fail");
    if (failed) return { name: want, status: "fail", assertion: hits.filter((h) => h.status === "fail").every((h) => isAssertion(h.full)) };
    return { name: want, status: "pass", assertion: false };
  });
  return { loaded, unnamed_failures: unnamed, results };
}

// ─── instruments ────────────────────────────────────────────────────────────────────────────────

/** `git status --porcelain` of a worktree, or null when it is not one / git fails. */
export function worktreeStatus(dir: string): string | null {
  try {
    if (!existsSync(dir)) return null;
    return execFileSync("git", ["-C", dir, "status", "--porcelain=v1", "--untracked-files=all"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 30_000 });
  } catch {
    return null;
  }
}

/**
 * The live stores a draft must not be able to write, as seen from INSIDE the sandbox (the stores probe
 * checks each with access(W_OK) as uid 65534 and requires EROFS / EACCES / ENOENT). Paths at origin/dev:
 * the gap store (WORKSPACE_ROOT/gaps/gaps.json, and the super-repo clone's gaps/), the memory store
 * (WORKSPACE_ROOT/memory/notes.json), the pool (WORKSPACE_ROOT/pool/standing.json), policies
 * (WORKSPACE_ROOT/policies), the workspace and its git clones, the vessel runtime (/vessels), the
 * database files (/var/lib/surrealdb, the surrealdb unit's file: path) and the secrets dir.
 */
export function defaultStorePaths(workspaceRoot: string | undefined = process.env["WORKSPACE_ROOT"]): string[] {
  const roots = [...new Set([workspaceRoot, "/workspace", "/workspace/git/super-repo"].filter((r): r is string => typeof r === "string" && r.length > 0))];
  const out = roots.flatMap((r) => [
    r, join(r, "gaps"), join(r, "gaps", "gaps.json"), join(r, "memory"), join(r, "memory", "notes.json"),
    join(r, "pool"), join(r, "pool", "standing.json"), join(r, "policies"),
  ]);
  return [...new Set([...out, "/workspace/git", "/vessels", "/var/lib/surrealdb", "/etc/substrate"])];
}

// ─── the in-sandbox self-probes ─────────────────────────────────────────────────────────────────

/** The layers the sandbox is made of. Each has a probe that runs INSIDE the same sandbox instance, as the
 *  same uid, with the same env, immediately before the draft — and the draft runs only if all are green. */
export type ContainmentLayer = "uid" | "net" | "ro" | "tmp" | "env";
export const CONTAINMENT_LAYERS: readonly ContainmentLayer[] = ["uid", "net", "ro", "tmp", "env"];

export interface ProbeResult { name: string; ok: boolean; detail: string }

/** The env names the sandbox passes. Everything else is dropped (allowlist, never a denylist). PWD is not
 *  passed in: the in-sandbox /bin/sh exports it (the cwd, /mnt/v) — measured, it is the only name sh adds. */
export const SANDBOX_ENV_ALLOWLIST: readonly string[] = ["PATH", "HOME", "TMPDIR", "WORKSPACE_ROOT", "NO_COLOR", "PWD"];

const PROBE_PREFIX = "[falsify-authored-test] probe ";

/**
 * The probe program (plain JS, run by bun as the sandboxed uid). Its input is a JSON file the runner wrote
 * (store paths, the host-/tmp canary); it never reads a store's contents — access(W_OK) only — and reads no
 * /proc file but its own mountinfo. It prints ONE line `PROBE_PREFIX{json}` and exits 0 only if every probe
 * is green. Every check is deterministic (no packets are sent):
 *   uid    uid and gid are 65534 and no other group is held
 *   net    no network interface but lo exists (a fresh netns has none up; the host's eth0 shows otherwise)
 *   ro     the topmost mount at /mnt/v is read-only (from /proc/self/mountinfo)
 *   tmp    /tmp is a tmpfs, is writable, and the runner's canary in the HOST /tmp is invisible
 *   env    every env name is on the allowlist
 *   stores every listed live store is unwritable: access(W_OK) fails with EROFS, EACCES, ENOENT or ENOTDIR
 */
export const PROBE_PROGRAM = `
import { accessSync, constants, existsSync, readFileSync } from "node:fs";
import { networkInterfaces } from "node:os";
const input = JSON.parse(readFileSync(process.argv[2], "utf8"));
const out = [];
const add = (name, ok, detail) => out.push({ name, ok: Boolean(ok), detail: String(detail) });
const uid = process.getuid(), gid = process.getgid(), groups = process.getgroups();
add("uid", uid === 65534 && gid === 65534 && groups.every((g) => g === 65534), "uid=" + uid + " gid=" + gid + " groups=" + groups.join(","));
const ifs = Object.keys(networkInterfaces()).filter((n) => n !== "lo");
add("net", ifs.length === 0, ifs.length ? "interfaces present: " + ifs.join(",") : "no interface but lo");
let mounts = [];
try {
  mounts = readFileSync("/proc/self/mountinfo", "utf8").split("\\n").filter(Boolean).map((l) => {
    const [pre, post = ""] = l.split(" - ");
    const f = pre.split(" ");
    return { point: f[4], opts: f[5] || "", fstype: post.split(" ")[0] || "" };
  });
} catch (e) { /* every mount probe then fails */ }
const top = (p) => mounts.filter((m) => m.point === p).pop();
const v = top("/mnt/v");
add("ro", v && v.opts.split(",").includes("ro"), v ? "/mnt/v " + v.opts : "/mnt/v is not a mount");
const t = top("/tmp");
let tmpW = false; try { accessSync("/tmp", constants.W_OK); tmpW = true; } catch {}
const canarySeen = existsSync(input.hostTmpCanary);
add("tmp", t && t.fstype === "tmpfs" && tmpW && !canarySeen, "/tmp " + (t ? t.fstype : "not a mount") + (tmpW ? " writable" : " NOT writable") + (canarySeen ? ", host canary VISIBLE" : ", host canary invisible"));
const extra = Object.keys(process.env).filter((k) => !input.envAllow.includes(k));
add("env", extra.length === 0, extra.length ? "extra names: " + extra.join(",") : "allowlist only");
const writable = [];
for (const p of input.storePaths) {
  try { accessSync(p, constants.W_OK); writable.push(p + " (writable)"); }
  catch (e) { if (!["EROFS", "EACCES", "ENOENT", "ENOTDIR"].includes(e && e.code)) writable.push(p + " (" + (e && e.code) + ")"); }
}
add("stores", writable.length === 0, writable.length ? writable.join("; ") : input.storePaths.length + " store paths unwritable");
console.log(${JSON.stringify(PROBE_PREFIX)} + JSON.stringify(out));
process.exit(out.every((p) => p.ok) ? 0 : 3);
`;

/** The FIRST probe line of a run (the draft runs after it, so it cannot forge an earlier line). */
export function parseProbeLine(raw: string): ProbeResult[] | null {
  const line = String(raw ?? "").split("\n").find((l) => l.startsWith(PROBE_PREFIX));
  if (!line) return null;
  try {
    const v = JSON.parse(line.slice(PROBE_PREFIX.length)) as unknown;
    if (!Array.isArray(v)) return null;
    return v.map((p) => ({ name: String((p as ProbeResult).name), ok: (p as ProbeResult).ok === true, detail: String((p as ProbeResult).detail ?? "") }));
  } catch {
    return null;
  }
}

/** All six probes present and green. */
export function probesGreen(probes: ProbeResult[] | null): boolean {
  if (!probes) return false;
  return [...CONTAINMENT_LAYERS, "stores"].every((n) => probes.some((p) => p.name === n && p.ok));
}

// ─── the contained runner ───────────────────────────────────────────────────────────────────────

const NOBODY = 65534;
const MOUNT_ROOT = "/mnt";

function onPath(bin: string): string | null {
  for (const d of (process.env["PATH"] ?? "/usr/bin:/bin").split(delimiter).concat(["/usr/bin", "/bin", "/usr/sbin", "/sbin"])) {
    const p = join(d, bin);
    try { if (statSync(p).isFile()) return p; } catch { /* next */ }
  }
  return null;
}

function bunBinary(): string | null {
  try {
    if (process.versions["bun"]) return realpathSync(process.execPath);
  } catch { /* fall through */ }
  const b = onPath("bun");
  return b ? realpathSync(b) : null;
}

/** Why the contained runner cannot run here, or null when it can. Fails closed: the caller never runs a
 *  draft uncontained because containment is unavailable. */
export function containmentUnavailableReason(): string | null {
  if (process.platform !== "linux") return `platform ${process.platform} has no namespaces`;
  if (typeof process.getuid !== "function" || process.getuid() !== 0) return `not root (uid ${typeof process.getuid === "function" ? process.getuid() : "?"}); setpriv/unshare need root to drop to uid ${NOBODY}`;
  for (const b of ["setpriv", "unshare", "timeout", "mount"]) if (!onPath(b)) return `${b} not found`;
  if (!existsSync(MOUNT_ROOT)) return `${MOUNT_ROOT} absent (the namespace binds the run there)`;
  if (!bunBinary()) return "bun binary not found";
  // Binaries present is not containment available: a default-caps container has unshare on PATH and the
  // kernel refuses it. Attempt the same namespaces the runner uses, running nothing but `true`.
  try {
    execFileSync("unshare", ["--net", "--mount", "--pid", "--fork", "--mount-proc", "--", "true"], { stdio: "ignore", timeout: 10_000, env: { PATH: "/usr/sbin:/usr/bin:/sbin:/bin" } });
  } catch (e) {
    return `unshare refused here (${(e as Error).message.split("\n")[0]}); namespaces need CAP_SYS_ADMIN`;
  }
  return null;
}

export interface RunContainedInput {
  /** A git worktree holding the drafted test (uncommitted is fine). Bound read-only into the namespace. */
  vesselDir: string;
  /** The drafted test, vessel-relative. Must stay inside vesselDir. */
  testFileRel: string;
  /** Test names to run (bun -t) and report; empty → the whole file. */
  onlyTests: string[];
  /** Hard limit for the draft's run (SIGKILL inside the namespace; the namespace is killed at +30s). */
  timeoutMs: number;
  /** Live stores the stores probe requires to be unwritable from inside. Default: defaultStorePaths(). */
  storePaths?: string[];
  /** Where the raw output is kept (it outlives the scratch). Default: <tmpdir>/falsify-authored-test-out. */
  outDir?: string;
  /**
   * SELF-TEST ONLY: build the sandbox WITHOUT this one layer. It exists so containmentSelfCheck (and the
   * tests) can prove each probe catches its layer's absence. It cannot yield `contained: true`: the probe
   * for the missing layer fails and the draft is never executed.
   */
  weakenLayerForSelfTest?: ContainmentLayer;
}

export interface ContainedRunResult extends ParsedRun {
  /** True ONLY when every in-sandbox probe was green, in the same sandbox instance, before the draft ran.
   *  When false the draft was NEVER executed. */
  contained: boolean;
  containment_error?: string;
  /** The in-sandbox probe results (null when the sandbox never got as far as probing). */
  probes: ProbeResult[] | null;
  timed_out: boolean;
  exit_code: number | null;
  /** Worktree porcelain unchanged from before the run (the draft itself is uncommitted, so not "empty"). */
  tree_clean: boolean;
  raw_output_path: string;
}

/** Exit code of the in-sandbox shell when the probes refused to let the draft run. */
const PROBE_REFUSED_EXIT = 97;

/** The in-namespace setup (root), built from fixed fragments only: the layer to weaken is an enum, and every
 *  path arrives as a POSITIONAL argument — nothing from the caller is interpolated into this text. */
function nsScript(weaken: ContainmentLayer | undefined): string {
  const env = weaken === "env"
    ? "env FAT_SELFTEST_LEAK=1 PATH=/mnt/bin:/usr/bin:/bin HOME=/mnt/home TMPDIR=/tmp WORKSPACE_ROOT=/mnt/ws NO_COLOR=1"
    : "env -i PATH=/mnt/bin:/usr/bin:/bin HOME=/mnt/home TMPDIR=/tmp WORKSPACE_ROOT=/mnt/ws NO_COLOR=1";
  const drop = weaken === "uid" ? "" : `setpriv --reuid=${NOBODY} --regid=${NOBODY} --clear-groups --no-new-privs --inh-caps=-all --bounding-set=-all `;
  // Runs as the sandboxed uid: probes first, the draft only if they all pass. Same namespaces, same env.
  const inner = [
    'F="$1"; P="$2"; T="$3"',
    `timeout -s KILL 30 bun /mnt/probe/probe.mjs /mnt/probe/input.json || exit ${PROBE_REFUSED_EXIT}`,
    'if [ -n "$P" ]; then exec timeout -s KILL "$T" bun test "./$F" -t "$P"; else exec timeout -s KILL "$T" bun test "./$F"; fi',
  ].join("\n");
  return [
    "set -eu",
    'S="$1"; V="$2"; B="$3"; F="$4"; P="$5"; T="$6"',
    'mount --bind "$S" /mnt',
    'mount --bind "$V" /mnt/v',
    'mount --bind "$B" /mnt/bin/bun',
    weaken === "ro" ? ":" : "mount -o remount,bind,ro /mnt/v",
    "mount -o remount,bind,ro /mnt/bin/bun",
    "mount --bind /mnt/probe /mnt/probe",
    "mount -o remount,bind,ro /mnt/probe",
    weaken === "tmp" ? ":" : "mount -t tmpfs -o mode=1777,size=256m,nosuid,nodev tmpfs /tmp",
    weaken === "tmp" ? ":" : "if [ -d /dev/shm ]; then mount -t tmpfs -o mode=1777,size=16m,nosuid,nodev tmpfs /dev/shm; fi",
    "cd /mnt/v",
    `exec ${drop}${env} /bin/sh -c ${shQuote(inner)} sh "$F" "$P" "$T"`,
  ].join("\n");
}

const shQuote = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;
const escapeRegex = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Run a drafted test file UNPRIVILEGED and CONTAINED. In ONE sandbox instance: self-probes first (uid,
 * net, ro vessel, private tmp, env allowlist, unwritable live stores), and the draft only if every probe is
 * green. Never throws for a draft's behaviour; any setup or probe failure returns `contained: false` with
 * the reason, and in that case the draft did not execute.
 */
export async function runContained(input: RunContainedInput): Promise<ContainedRunResult> {
  const outDir = input.outDir ?? join(tmpdir(), "falsify-authored-test-out");
  const empty = (why: string, rawPath = "", probes: ProbeResult[] | null = null): ContainedRunResult => ({
    contained: false, containment_error: why, probes, loaded: false, unnamed_failures: 0, results: [], timed_out: false,
    exit_code: null, tree_clean: false, raw_output_path: rawPath,
  });

  const vesselDir = resolve(input.vesselDir);
  const rel = String(input.testFileRel ?? "").replace(/\\/g, "/");
  const abs = resolve(vesselDir, rel);
  const within = relative(vesselDir, abs);
  if (!rel || isAbsolute(rel) || within.startsWith("..") || isAbsolute(within) || rel.split("/").includes("..") || !/\.[cm]?[jt]sx?$/.test(rel)) {
    return empty(`test path ${JSON.stringify(input.testFileRel)} must be a relative .ts/.js file inside the vessel dir`);
  }
  const unavailable = containmentUnavailableReason();
  if (unavailable) return empty(`containment unavailable: ${unavailable}`);
  if (!existsSync(abs)) return empty(`test file ${rel} does not exist in ${vesselDir}`);
  const treeBefore = worktreeStatus(vesselDir);
  if (treeBefore === null) return empty(`${vesselDir} is not a git worktree`);
  const bun = bunBinary()!;

  mkdirSync(outDir, { recursive: true });
  const runOut = mkdtempSync(join(outDir, "run-"));
  const rawPath = join(runOut, "bun-test.txt");

  // Scratch: becomes /mnt inside the namespace. root-owned 755; home and ws owned by nobody. The canary
  // lives in the HOST /tmp (always /tmp, whatever tmpdir() says) so the tmp probe can prove it is hidden.
  const S = mkdtempSync(join(tmpdir(), "fat-scratch-"));
  const canary = mkdtempSync("/tmp/fat-canary-");
  let fd: number | null = null;
  try {
    chmodSync(S, 0o755);
    for (const d of ["v", "bin", "home", "ws", "probe"]) mkdirSync(join(S, d));
    writeFileSync(join(S, "bin", "bun"), "");
    chmodSync(join(S, "probe"), 0o755);
    writeFileSync(join(S, "probe", "probe.mjs"), PROBE_PROGRAM, { mode: 0o644 });
    writeFileSync(join(S, "probe", "input.json"), JSON.stringify({
      storePaths: input.storePaths ?? defaultStorePaths(), hostTmpCanary: canary, envAllow: SANDBOX_ENV_ALLOWLIST,
    }), { mode: 0o644 });
    chownSync(join(S, "home"), NOBODY, NOBODY);
    chownSync(join(S, "ws"), NOBODY, NOBODY);
    const pattern = input.onlyTests.length > 0 ? input.onlyTests.map(escapeRegex).join("|") : "";
    const secs = String(Math.max(1, Math.ceil(input.timeoutMs / 1000)));
    const ns = input.weakenLayerForSelfTest === "net"
      ? ["--mount", "--pid", "--fork", "--mount-proc", "--kill-child"]
      : ["--net", "--mount", "--pid", "--fork", "--mount-proc", "--kill-child"];
    fd = openSync(rawPath, "w");
    const outFd = fd;
    const { code, killed } = await new Promise<{ code: number | null; killed: boolean }>((done) => {
      const child = spawn("unshare", [...ns, "--", "/bin/sh", "-c", nsScript(input.weakenLayerForSelfTest), "sh", S, vesselDir, bun, rel, pattern, secs], {
        stdio: ["ignore", outFd, outFd],
        env: { PATH: "/usr/sbin:/usr/bin:/sbin:/bin" },
      });
      let outerKilled = false;
      const guard = setTimeout(() => { outerKilled = true; child.kill("SIGKILL"); }, input.timeoutMs + 30_000);
      child.on("error", () => { clearTimeout(guard); done({ code: null, killed: outerKilled }); });
      child.on("exit", (c, sig) => { clearTimeout(guard); done({ code: c ?? (sig ? 128 : null), killed: outerKilled }); });
    });
    closeSync(fd);
    fd = null;
    const raw = readFileSync(rawPath, "utf8");
    const probes = parseProbeLine(raw);
    const treeAfter = worktreeStatus(vesselDir);
    const treeClean = treeAfter !== null && treeAfter === treeBefore;
    if (!probesGreen(probes) || code === PROBE_REFUSED_EXIT) {
      const failed = probes ? probes.filter((p) => !p.ok).map((p) => `${p.name}: ${p.detail}`).join("; ") : "no probe result (sandbox setup failed before probing)";
      return { ...empty(`containment probes refused the run — the draft was NOT executed: ${failed}`, rawPath, probes), exit_code: code, tree_clean: treeClean };
    }
    const parsed = parseBunRun(raw, input.onlyTests);
    // `timeout -s KILL` exits 137 when it fires; the outer guard covers a namespace that never returns.
    const timedOut = killed || code === 137;
    return {
      ...parsed,
      ...(timedOut ? { loaded: false } : {}),
      contained: true,
      probes,
      timed_out: timedOut,
      exit_code: code,
      tree_clean: treeClean,
      raw_output_path: rawPath,
    };
  } catch (e) {
    return empty(`runner error: ${(e as Error).message}`, rawPath);
  } finally {
    if (fd !== null) try { closeSync(fd); } catch { /* already closed */ }
    rmSync(S, { recursive: true, force: true });
    rmSync(canary, { recursive: true, force: true });
  }
}

// ─── the containment self-check (one implementation; the tests and install acceptance both call it) ─

export interface SelfCheckResult { ok: boolean; skipped?: string; checks: ProbeResult[] }

/** Printed by the self-check's fixture at import time: present in the raw output iff the draft executed. */
export const SELF_CHECK_DRAFT_MARKER = "FAT-SELFCHECK-DRAFT-EXECUTED";

const SELF_CHECK_FIXTURE = `import { expect, test } from "bun:test";
console.log("${SELF_CHECK_DRAFT_MARKER}");
test("control: arithmetic", () => { expect(1 + 1).toBe(2); });
test("red: a named assertion", () => { expect("limit").toBe("parseLimit"); });
`;

/**
 * Prove the sandbox, here, with harmless fixture code only: (1) the full sandbox runs the fixture with all
 * probes green and a named red; (2) each single layer disabled → contained:false, that layer's probe red,
 * and the fixture never executed (its marker absent from the output); (3) a world-writable store path →
 * contained:false, the stores probe red, the fixture never executed. Skips (ok:false, `skipped` set) only
 * where containment is unavailable — a skip is never a pass.
 */
export async function containmentSelfCheck(opts: { outDir?: string } = {}): Promise<SelfCheckResult> {
  const unavailable = containmentUnavailableReason();
  if (unavailable) return { ok: false, skipped: unavailable, checks: [] };
  const checks: ProbeResult[] = [];
  const add = (name: string, ok: boolean, detail: string): void => { checks.push({ name, ok, detail }); };
  const vessel = mkdtempSync(join(tmpdir(), "fat-selfcheck-"));
  const writableStore = existsSync("/var/tmp") ? mkdtempSync("/var/tmp/fat-selfcheck-store-") : null;
  try {
    chmodSync(vessel, 0o755);
    execFileSync("git", ["init", "-q", vessel], { stdio: "ignore" });
    mkdirSync(join(vessel, "test"));
    writeFileSync(join(vessel, "test", "selfcheck.localize.test.ts"), SELF_CHECK_FIXTURE);
    const base = { vesselDir: vessel, testFileRel: "test/selfcheck.localize.test.ts", onlyTests: ["control: arithmetic", "red: a named assertion"], timeoutMs: 60_000, ...(opts.outDir ? { outDir: opts.outDir } : {}) };
    const ran = (r: ContainedRunResult): boolean => { try { return readFileSync(r.raw_output_path, "utf8").includes(SELF_CHECK_DRAFT_MARKER); } catch { return false; } };

    const full = await runContained(base);
    const red = full.results.find((x) => x.name === "red: a named assertion");
    const ctl = full.results.find((x) => x.name === "control: arithmetic");
    add("full sandbox: all probes green, the fixture ran, red is a named assertion",
      full.contained && probesGreen(full.probes) && ran(full) && full.loaded && red?.status === "fail" && red.assertion === true && ctl?.status === "pass" && full.tree_clean,
      `contained=${full.contained} ran=${ran(full)} loaded=${full.loaded} red=${red?.status}/${red?.assertion} control=${ctl?.status} tree_clean=${full.tree_clean}${full.containment_error ? " err=" + full.containment_error : ""}`);

    for (const layer of CONTAINMENT_LAYERS) {
      const r = await runContained({ ...base, weakenLayerForSelfTest: layer });
      const own = r.probes?.find((p) => p.name === layer);
      add(`without the ${layer} layer: refused, its own probe red, the fixture never executed`,
        !r.contained && own !== undefined && !own.ok && !ran(r) && r.results.length === 0,
        `contained=${r.contained} ${layer}-probe=${own ? (own.ok ? "green" : "red: " + own.detail) : "absent"} ran=${ran(r)}`);
    }

    if (!writableStore) {
      add("a writable store path: refused", false, "/var/tmp absent; cannot place a store path visible inside the sandbox");
    } else {
      chmodSync(writableStore, 0o1777);
      const r = await runContained({ ...base, storePaths: [...defaultStorePaths(), writableStore] });
      const st = r.probes?.find((p) => p.name === "stores");
      add("a writable store path: refused, the stores probe red, the fixture never executed",
        !r.contained && st !== undefined && !st.ok && st.detail.includes(writableStore) && !ran(r),
        `contained=${r.contained} stores-probe=${st ? (st.ok ? "green" : "red: " + st.detail) : "absent"} ran=${ran(r)}`);
    }
  } finally {
    rmSync(vessel, { recursive: true, force: true });
    if (writableStore) rmSync(writableStore, { recursive: true, force: true });
  }
  return { ok: checks.length === 7 && checks.every((c) => c.ok), checks };
}
