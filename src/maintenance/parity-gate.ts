/**
 * parity-gate.ts — the deterministic behavior-neutrality gate for maintenance
 * transforms (seam extraction), per openspec 2026-07-15-vessel-maintenance-parity-gate.
 *
 * A maintenance transform's declared intent is "change nothing observable", which
 * is machine-decidable — so unlike the semantic cutover gate (LLM judge), this gate
 * is a deterministic proof. All correctness lives HERE; the generator of the cut
 * (deterministic grouper or an arbitrarily weak LLM) is never trusted.
 *
 * Four checks, cheapest-first, all hard (each short-circuits the rest):
 *   1. surfaceParity — the edited file's resolved export signature is unchanged.
 *   2. typeParity    — no NEW compiler diagnostics vs the pre-change baseline
 *                      (subset-or-equal; pre-existing benign diagnostics allowed).
 *   3. testParity    — test files byte-identical (an edited/added/deleted test is a
 *                      behavior signal → reject) and, when a runner is provided,
 *                      the existing suite passes.
 *   4. astEquivalent — the proof: N(file_before) equals
 *                      N(file_after) ⊎ N(targetModule_after) as an unordered
 *                      multiset of normalized top-level declarations, and every
 *                      identifier reference binds to the same target (bind-
 *                      preserving). Any body rewrite, rename, or rebinding fails.
 *
 * The gate can only ever BLOCK: an unprovable transform stays unlanded (fail-safe).
 * No I/O beyond the ts-morph Project it is handed — callers own process/git side
 * effects (rollback, commit, gap writes), keeping this module trivially unit-provable.
 */

import { Node, Project, SourceFile, SyntaxKind, ts } from "ts-morph";
import { createHash } from "node:crypto";

// ---------------------------------------------------------------------------
// Shapes (mirrors the spec's parityVerdict / baseline vocabulary)
// ---------------------------------------------------------------------------

export interface ParityBaseline {
  /** Path (project-relative) of the file under maintenance. */
  filePath: string;
  /** Full pre-change text of that file — the AST-equivalence reference. */
  fileText: string;
  /** Sorted resolved export signature entries: `${name} :: ${type}`. */
  exportSignature: string[];
  /** Sorted normalized diagnostic keys for the whole project. */
  diagnostics: string[];
  /** sha256 per test file path — byte-identity check, catches add/edit/delete. */
  testFileHashes: Record<string, string>;
}

export interface TestRunResult {
  passed: boolean;
  detail?: string;
}

/** Injectable suite runner (spawning `bun test` is the caller's business). */
export type TestRunner = () => Promise<TestRunResult>;

export interface ParityVerdict {
  surfaceParity: boolean;
  typeParity: boolean;
  testParity: boolean;
  astEquivalent: boolean;
  verdict: boolean;
  /** First failing check, human- and machine-readable. */
  failReason?: string;
}

const TEST_FILE_RE = /\.(test|spec)\.tsx?$/;

// ---------------------------------------------------------------------------
// Baseline capture (run BEFORE the transform mutates the project)
// ---------------------------------------------------------------------------

export function captureBaseline(project: Project, filePath: string): ParityBaseline {
  const sf = mustGetSourceFile(project, filePath);
  return {
    filePath,
    fileText: sf.getFullText(),
    exportSignature: exportSignature(sf),
    diagnostics: diagnosticKeys(project),
    testFileHashes: testFileHashes(project),
  };
}

// ---------------------------------------------------------------------------
// The gate
// ---------------------------------------------------------------------------

export async function verifyParity(
  project: Project,
  baseline: ParityBaseline,
  targetModulePath: string,
  opts: { runTests?: TestRunner } = {},
): Promise<ParityVerdict> {
  const verdict: ParityVerdict = {
    surfaceParity: false,
    typeParity: false,
    testParity: false,
    astEquivalent: false,
    verdict: false,
  };

  // --- 1. Public-surface parity (cheapest) --------------------------------
  const fileAfter = project.getSourceFile(baseline.filePath);
  if (!fileAfter) {
    verdict.failReason = `surfaceParity: file ${baseline.filePath} no longer exists`;
    return verdict;
  }
  const sigAfter = exportSignature(fileAfter);
  const sigDiff = symmetricDiff(baseline.exportSignature, sigAfter);
  if (sigDiff.length > 0) {
    verdict.failReason = `surfaceParity: export signature changed: ${sigDiff.slice(0, 5).join(" | ")}`;
    return verdict;
  }
  verdict.surfaceParity = true;

  // --- 2. Type parity (no NEW diagnostics) --------------------------------
  const before = new Set(baseline.diagnostics);
  const fresh = diagnosticKeys(project).filter((k) => !before.has(k));
  if (fresh.length > 0) {
    verdict.failReason = `typeParity: ${fresh.length} new diagnostic(s): ${fresh.slice(0, 3).join(" | ")}`;
    return verdict;
  }
  verdict.typeParity = true;

  // --- 3. Test parity (byte-identity, then suite) -------------------------
  const hashesAfter = testFileHashes(project);
  const testDrift = mapDrift(baseline.testFileHashes, hashesAfter);
  if (testDrift) {
    verdict.failReason = `testParity: ${testDrift}`;
    return verdict;
  }
  if (opts.runTests) {
    const run = await opts.runTests();
    if (!run.passed) {
      verdict.failReason = `testParity: suite failed${run.detail ? `: ${run.detail}` : ""}`;
      return verdict;
    }
  }
  verdict.testParity = true;

  // --- 4. Normalized-AST equivalence (the proof) ---------------------------
  const target = project.getSourceFile(targetModulePath);
  if (!target) {
    verdict.failReason = `astEquivalent: target module ${targetModulePath} not found`;
    return verdict;
  }
  const astFail = astEquivalence(project, baseline, fileAfter, target);
  if (astFail) {
    verdict.failReason = `astEquivalent: ${astFail}`;
    return verdict;
  }
  verdict.astEquivalent = true;

  verdict.verdict = true;
  return verdict;
}

// ---------------------------------------------------------------------------
// Check 1 — export signature, resolved through re-export shims
// ---------------------------------------------------------------------------

function exportSignature(sf: SourceFile): string[] {
  const entries: string[] = [];
  for (const [name, decls] of sf.getExportedDeclarations()) {
    for (const decl of decls) {
      // Type text is position-independent; using the declaration as the
      // resolution site keeps aliases stable across the move.
      let typeText: string;
      try {
        typeText = decl.getType().getText(decl);
      } catch {
        typeText = decl.getKindName();
      }
      entries.push(`${name} :: ${typeText}`);
    }
  }
  return entries.sort();
}

// ---------------------------------------------------------------------------
// Check 2 — normalized diagnostic keys
// ---------------------------------------------------------------------------

function diagnosticKeys(project: Project): string[] {
  return project
    .getPreEmitDiagnostics()
    .map((d) => {
      const file = d.getSourceFile()?.getFilePath() ?? "<project>";
      const msg = ts.flattenDiagnosticMessageText(d.compilerObject.messageText, " ");
      return `${d.getCode()}|${file}|${msg}`;
    })
    .sort();
}

// ---------------------------------------------------------------------------
// Check 3 — test byte-identity
// ---------------------------------------------------------------------------

function testFileHashes(project: Project): Record<string, string> {
  const out: Record<string, string> = {};
  for (const sf of project.getSourceFiles()) {
    const p = sf.getFilePath();
    if (TEST_FILE_RE.test(p)) {
      out[p] = createHash("sha256").update(sf.getFullText()).digest("hex");
    }
  }
  return out;
}

function mapDrift(before: Record<string, string>, after: Record<string, string>): string | null {
  for (const [p, h] of Object.entries(before)) {
    if (!(p in after)) return `test file deleted: ${p}`;
    if (after[p] !== h) return `test file edited: ${p}`;
  }
  for (const p of Object.keys(after)) {
    if (!(p in before)) return `test file added: ${p}`;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Check 4 — normalized-AST multiset equivalence + bind preservation
// ---------------------------------------------------------------------------

/**
 * Returns null when equivalent, else a human-readable reason.
 *
 * Normalization N(·): strip trivia (printer with comments removed), erase
 * module-boundary artifacts (import declarations, `export`/`default` modifiers,
 * re-export statements), then compare the union of the after-modules' top-level
 * declarations against the before-file's as an unordered multiset keyed by
 * declared name. Bodies are compared as normalized text — any rewrite differs.
 *
 * Bind preservation: within each declaration, every identifier reference's
 * resolution target is fingerprinted as
 *   local  → `local:${name}#${sha256(normalized decl text)}`   (unit-internal)
 *   import → `ext:${moduleSpecifier}:${name}`                  (external edge)
 * and the per-declaration multiset of fingerprints must be identical across
 * worlds. A move that captures a different binding (same name, different decl)
 * changes the fingerprint via the decl-text hash and fails.
 */
function astEquivalence(
  project: Project,
  baseline: ParityBaseline,
  fileAfter: SourceFile,
  targetAfter: SourceFile,
): string | null {
  // The before-world is reconstructed from the baseline snapshot in a scratch
  // file so both worlds normalize through identical machinery.
  // Scratch lives NEXT TO the file so its relative imports resolve identically.
  const scratchPath = baseline.filePath.replace(/[^/\\]+$/, "__parity_before__.ts");
  const beforeSf = project.createSourceFile(scratchPath, baseline.fileText, { overwrite: true });
  try {
    const beforeDecls = normalizedTopLevel(beforeSf);
    const afterDecls = mergeMultisets(normalizedTopLevel(fileAfter), normalizedTopLevel(targetAfter));

    // Multiset equality keyed by name.
    for (const [key, bodies] of beforeDecls) {
      const after = afterDecls.get(key);
      if (!after) return `declaration lost in move: ${key}`;
      if (!multisetEqual(bodies.map((b) => b.text), after.map((b) => b.text))) {
        return `declaration body changed: ${key}`;
      }
    }
    for (const key of afterDecls.keys()) {
      if (!beforeDecls.has(key)) return `declaration appeared that was not in the original: ${key}`;
    }

    // Bind preservation, per declaration.
    const beforeUnit = new Set([beforeSf]);
    const afterUnit = new Set([fileAfter, targetAfter]);
    const beforeBindings = bindingFingerprints(beforeUnit, beforeDecls);
    const afterBindings = mergeBindingMaps(
      bindingFingerprints(afterUnit, normalizedTopLevel(fileAfter)),
      bindingFingerprints(afterUnit, normalizedTopLevel(targetAfter)),
    );
    for (const [key, prints] of beforeBindings) {
      const after = afterBindings.get(key) ?? [];
      if (!multisetEqual(prints, after)) {
        return `reference binding changed inside: ${key}`;
      }
    }
    return null;
  } finally {
    beforeSf.delete();
  }
}

interface NormalizedDecl {
  text: string;
  node: Node;
}

/** Top-level declarations, normalized; imports and re-export shims erased. */
function normalizedTopLevel(sf: SourceFile): Map<string, NormalizedDecl[]> {
  const out = new Map<string, NormalizedDecl[]>();
  for (const stmt of sf.getStatements()) {
    if (Node.isImportDeclaration(stmt)) continue; // module-boundary artifact
    if (Node.isExportDeclaration(stmt)) continue; // re-export shim edge
    if (Node.isExportAssignment(stmt)) {
      push(out, "default", { text: normalizeText(stmt.getExpression().getText()), node: stmt });
      continue;
    }
    if (Node.isVariableStatement(stmt)) {
      for (const decl of stmt.getDeclarations()) {
        push(out, decl.getName(), { text: normalizeText(stripExport(stmt.getText())), node: decl });
      }
      continue;
    }
    const named =
      Node.isFunctionDeclaration(stmt) ||
      Node.isClassDeclaration(stmt) ||
      Node.isInterfaceDeclaration(stmt) ||
      Node.isTypeAliasDeclaration(stmt) ||
      Node.isEnumDeclaration(stmt) ||
      Node.isModuleDeclaration(stmt)
        ? stmt.getName()
        : undefined;
    push(out, named ?? `<stmt:${hash(normalizeText(stmt.getText()))}>`, {
      text: normalizeText(stripExport(stmt.getText())),
      node: stmt,
    });
  }
  return out;
}

/** Strip leading `export` / `export default` modifiers before normalizing. */
function stripExport(text: string): string {
  return text.replace(/^\s*export\s+(default\s+)?/, "");
}

/**
 * Canonical text: parse + reprint through the TS printer with comments removed.
 * The printer's deterministic formatting erases whitespace/ASI variation; any
 * token-level change (rename, literal edit, reordering inside a declaration)
 * survives normalization and shows up as a difference.
 */
const printer = ts.createPrinter({ removeComments: true, newLine: ts.NewLineKind.LineFeed });
function normalizeText(text: string): string {
  const scratch = ts.createSourceFile("s.ts", text, ts.ScriptTarget.Latest, false, ts.ScriptKind.TS);
  return printer.printFile(scratch).trim();
}

/**
 * Per-declaration multiset of resolution fingerprints for identifier references.
 *
 * Import aliases are resolved to their final declaration first, so a symbol
 * reached through the applier's shim import fingerprints identically to the
 * same symbol referenced in-file pre-move: `local` iff the final declaration
 * lives inside the compared unit ({file} before; {file, targetModule} after),
 * fingerprinted by name + normalized content of its declaration — a move that
 * captures a DIFFERENT same-named binding changes the content hash and fails.
 */
const TYPE_MEMBER_KINDS = new Set<SyntaxKind>([
  SyntaxKind.PropertySignature,
  SyntaxKind.PropertyAssignment,
  SyntaxKind.ShorthandPropertyAssignment,
  SyntaxKind.MethodSignature,
  SyntaxKind.MethodDeclaration,
  SyntaxKind.PropertyDeclaration,
  SyntaxKind.GetAccessor,
  SyntaxKind.SetAccessor,
  SyntaxKind.EnumMember,
]);

function bindingFingerprints(unit: Set<SourceFile>, decls: Map<string, NormalizedDecl[]>): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const [key, list] of decls) {
    const prints: string[] = [];
    for (const { node } of list) {
      for (const id of node.getDescendantsOfKind(SyntaxKind.Identifier)) {
        // JSDoc identifiers (@param names etc.) are comment trivia — the
        // normalization strips comments, so fingerprints must too, or a doc
        // comment moving (or not) with its declaration breaks equivalence.
        if (id.getFirstAncestorByKind(SyntaxKind.JSDoc)) continue;
        const sym = id.getSymbol();
        if (!sym) continue;
        const resolved = sym.getAliasedSymbol() ?? sym;
        // Only LEXICAL bindings can be captured/rebound by moving code between
        // modules — type members (interface/object properties, methods, enum
        // members) resolve through the TYPE, which typeParity + the declaration
        // multiset already pin, and their resolution multiplicity differs
        // benignly across worlds (observed on the first real-fossil dry-run).
        const ds = resolved.getDeclarations().filter((d) => !TYPE_MEMBER_KINDS.has(d.getKind()));
        if (ds.length === 0) continue;
        for (const d of ds) {
          const declSf = d.getSourceFile();
          if (unit.has(declSf)) {
            const container = topLevelContainer(d);
            prints.push(`local:${resolved.getName()}#${hash(normalizeText(stripExport(container.getText())))}`);
          } else {
            prints.push(`file:${declSf.getFilePath()}:${resolved.getName()}`);
          }
        }
      }
    }
    out.set(key, prints.sort());
  }
  return out;
}

function topLevelContainer(node: Node): Node {
  let cur: Node = node;
  while (cur.getParent() && !Node.isSourceFile(cur.getParent()!)) cur = cur.getParent()!;
  return cur;
}

// ---------------------------------------------------------------------------
// Small pure helpers
// ---------------------------------------------------------------------------

function mustGetSourceFile(project: Project, path: string): SourceFile {
  const sf = project.getSourceFile(path);
  if (!sf) throw new Error(`parity-gate: source file not in project: ${path}`);
  return sf;
}

function push<K, V>(m: Map<K, V[]>, k: K, v: V): void {
  const list = m.get(k);
  if (list) list.push(v);
  else m.set(k, [v]);
}

function mergeMultisets(
  a: Map<string, NormalizedDecl[]>,
  b: Map<string, NormalizedDecl[]>,
): Map<string, NormalizedDecl[]> {
  const out = new Map<string, NormalizedDecl[]>();
  for (const [k, v] of a) out.set(k, [...v]);
  for (const [k, v] of b) {
    const cur = out.get(k);
    out.set(k, cur ? [...cur, ...v] : [...v]);
  }
  return out;
}

function mergeBindingMaps(a: Map<string, string[]>, b: Map<string, string[]>): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const [k, v] of a) out.set(k, [...v]);
  for (const [k, v] of b) {
    const cur = out.get(k);
    out.set(k, cur ? [...cur, ...v].sort() : [...v]);
  }
  return out;
}

function multisetEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const sa = [...a].sort();
  const sb = [...b].sort();
  return sa.every((v, i) => v === sb[i]);
}

function symmetricDiff(a: string[], b: string[]): string[] {
  const sa = new Set(a);
  const sb = new Set(b);
  const out: string[] = [];
  for (const v of a) if (!sb.has(v)) out.push(`-${v}`);
  for (const v of b) if (!sa.has(v)) out.push(`+${v}`);
  return out;
}

function hash(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}
