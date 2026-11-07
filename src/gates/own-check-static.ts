// The static reading of a check file: its relative import bindings and the call path of its failing tests through them. Lifted as-is from feature-compose.ts.
import { type CallPathEntry, findDeclarations, addCallPathEntry, CALL_PATH_MAX } from "../resolvers/retry-evidence.js";
import { existsSync as mountExistsSync } from "node:fs";
import { TEST_FILE_RE } from "./test-file-gates.js";

/** Local name -> relative module specifier, for a test file's static imports (and, with `dynamic`, its
 *  `const {a, b} = await import("./x")` / `const m = await import("./x")` bindings). Packages are skipped. */
export function relativeImportBindings(src: string, dynamic = false): Map<string, string> {
  const bindings = new Map<string, string>();
  for (const m of src.matchAll(/import\s+(?:type\s+)?([\s\S]*?)\s+from\s+["']([^"']+)["']/g)) {
    const clause = m[1] ?? "", spec = m[2] ?? "";
    if (!spec.startsWith(".")) continue;
    const named = /\{([\s\S]*?)\}/.exec(clause)?.[1] ?? "";
    for (const part of named.split(",")) { const local = part.trim().split(/\s+as\s+/).pop()?.replace(/^type\s+/, "").trim(); if (local) bindings.set(local, spec); }
    const ns = /\*\s+as\s+([A-Za-z_$][\w$]*)/.exec(clause)?.[1]; if (ns) bindings.set(ns, spec);
    const def = /^([A-Za-z_$][\w$]*)\s*(?:,|$)/.exec(clause.trim())?.[1]; if (def) bindings.set(def, spec);
  }
  if (dynamic) {
    for (const m of src.matchAll(/(?:const|let|var)\s+(\{[^}]*\}|[A-Za-z_$][\w$]*)\s*=\s*\(?\s*await\s+import\(\s*["']([^"']+)["']/g)) {
      const lhs = m[1] ?? "", spec = m[2] ?? "";
      if (!spec.startsWith(".")) continue;
      if (lhs.startsWith("{")) {
        for (const part of lhs.slice(1, -1).split(",")) { const local = part.trim().split(/\s*:\s*/).pop()?.trim(); if (local && /^[A-Za-z_$][\w$]*$/.test(local)) bindings.set(local, spec); }
      } else bindings.set(lhs, spec);
    }
  }
  return bindings;
}
/** The vessel-relative source file a relative specifier in `test_file` resolves to (ts/tsx/index), or null. */
export function resolveVesselImport(vesselRoot: string, testFile: string, spec: string): string | null {
  const testDir = testFile.includes("/") ? testFile.slice(0, testFile.lastIndexOf("/")) : "";
  const parts = [...testDir.split("/").filter(Boolean)];
  for (const seg of spec.split("/")) { if (seg === "." || seg === "") continue; if (seg === "..") parts.pop(); else parts.push(seg); }
  const base = parts.join("/");
  const cands = /\.[cm]?js$/.test(base) ? [base.replace(/\.([cm]?)js$/, ".$1ts"), base.replace(/\.([cm]?)js$/, ".$1tsx"), base] : /\.[cm]?tsx?$/.test(base) ? [base] : [`${base}.ts`, `${base}.tsx`, `${base}/index.ts`];
  return cands.find((c) => mountExistsSync(`${vesselRoot}/${c}`)) ?? null;
}
/** The source of the failing test `name` (its " > " leaf) up to the next it(/test( in `src`, or null when the leaf is not in it. */
export function failingTestBody(src: string, name: string): string | null {
  const leaf = name.split(" > ").pop()?.trim() ?? "";
  if (!leaf) return null;
  const at = src.indexOf(leaf);
  if (at < 0) return null;
  const rest = src.slice(at + leaf.length);
  const next = /\n\s*(?:it|test)(?:\.\w+)?\(/.exec(rest);
  return next ? rest.slice(0, next.index) : rest;
}
/**
 * (ii) THE CHECK'S CALL PATH WHEN NO SRC FRAME IS ON THE STACK (an expect() on a returned value): the src symbols the
 * failing tests' bodies call through the check's relative imports (a named import `fn(`, a namespace `ns.fn(`), at their
 * declaration in the module the import resolves to. Unlike the relocation hint it keeps the edit_site's own file: the
 * point is the FUNCTION the check reaches there. `read` gives a vessel-relative file's source (the check's too).
 */
export function staticCheckCallPath(input: { vessel_root: string; test_file: string; failing: ReadonlyArray<{ name?: unknown }>; prefix: string; read: (rel: string) => string | null; max?: number }): CallPathEntry[] {
  const out: CallPathEntry[] = [];
  const src = input.read(input.test_file);
  if (!src) return out;
  const bindings = relativeImportBindings(src, true);
  const sources = new Map<string, string | null>();
  const declare = (sym: string, spec: string): void => {
    const rel = resolveVesselImport(input.vessel_root, input.test_file, spec);
    if (!rel || !rel.startsWith("src/") || TEST_FILE_RE.test(rel)) return;
    if (!sources.has(rel)) sources.set(rel, input.read(rel));
    const content = sources.get(rel);
    const d = content ? findDeclarations(sym, [{ path: rel, content }])[0] : undefined;
    if (d) addCallPathEntry(out, { path: input.prefix + rel, fn: sym, line: d.line }, input.max ?? CALL_PATH_MAX);
  };
  for (const f of input.failing) {
    const body = failingTestBody(src, String(f?.name ?? ""));
    if (body === null) continue;
    // In call order: each call site of an imported binding in the body.
    for (const m of body.matchAll(/(?<![\w$.])([A-Za-z_$][\w$]*)(?:\s*\.\s*([A-Za-z_$][\w$]*))?\s*\(/g)) {
      const spec = bindings.get(m[1]!);
      if (spec) declare(m[2] ?? m[1]!, spec);
    }
  }
  return out;
}
