/**
 * seam-extraction.ts — deterministic proposer + mechanical applier for
 * parity-gated seam extraction (openspec 2026-07-15-vessel-maintenance-parity-
 * gate, Phase 2).
 *
 * propose: the DETERMINISTIC (no-LLM) loose-bag tier — cluster a file's
 * top-level declarations by their intra-file reference graph and emit ONE
 * `seamExtraction` proposal whose symbol set is closed over private
 * dependencies (so the move cannot force a new export out of the source file,
 * which would void surface parity by construction).
 *
 * apply: the mechanical move — copy the named top-level declarations verbatim
 * into a NEW sibling module (same directory, so relative import specifiers
 * copy unchanged), replicate exactly the imports the moved code needs, export
 * each moved declaration there, and leave behind a re-export shim for symbols
 * on the file's public surface plus a plain import for symbols still used
 * in-file. No body edits, no reformatting of untouched lines.
 *
 * Neither function is trusted: verify-parity (the gate) proves behavior
 * neutrality afterward, which is what lets this generator stay weak/simple.
 */

import { Node, Project, SourceFile, SyntaxKind } from "ts-morph";

export interface SeamExtraction {
  file: string;
  symbols: string[];
  targetModule: string;
  rationale: string;
}

// ---------------------------------------------------------------------------
// Deterministic proposer (loose-bag tier)
// ---------------------------------------------------------------------------

interface DeclInfo {
  name: string;
  node: Node;
  exported: boolean;
  lines: number;
  refs: Set<string>; // names of other top-level decls this one references
}

export function proposeSeamExtraction(
  project: Project,
  filePath: string,
  opts: { minLines?: number; maxShare?: number } = {},
): SeamExtraction | null {
  const sf = project.getSourceFile(filePath);
  if (!sf) return null;
  const minLines = opts.minLines ?? 40;
  const maxShare = opts.maxShare ?? 0.4;
  const fileLines = sf.getEndLineNumber();

  const decls = collectTopLevel(sf);
  const byName = new Map(decls.map((d) => [d.name, d]));

  // Union-find over the mutual-reference graph → cohesive clusters.
  const parent = new Map<string, string>();
  const find = (x: string): string => {
    let r = x;
    while (parent.get(r) !== r) r = parent.get(r)!;
    return r;
  };
  const union = (a: string, b: string): void => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  };
  for (const d of decls) parent.set(d.name, d.name);
  for (const d of decls) for (const r of d.refs) if (byName.has(r)) union(d.name, r);

  const clusters = new Map<string, DeclInfo[]>();
  for (const d of decls) {
    const root = find(d.name);
    const c = clusters.get(root);
    if (c) c.push(d);
    else clusters.set(root, [d]);
  }

  // Candidate clusters: big enough to matter, small enough to stay a MOVE
  // (not a rewrite of the whole file), and private-dependency-closed by
  // construction (a cluster contains every decl it references in-file).
  const candidates = [...clusters.values()]
    .map((c) => ({ c, lines: c.reduce((n, d) => n + d.lines, 0) }))
    .filter(({ c, lines }) => lines >= minLines && lines <= fileLines * maxShare && c.length >= 2)
    .sort((a, b) => b.lines - a.lines);
  const best = candidates[0];
  if (!best) return null;

  const symbols = best.c.map((d) => d.name).sort();
  const anchor = best.c.slice().sort((a, b) => b.lines - a.lines)[0]!.name;
  const targetModule = filePath.replace(/\.tsx?$/, `.${kebab(anchor)}.ts`);
  return {
    file: filePath,
    symbols,
    targetModule,
    rationale: `deterministic loose-bag cluster around ${anchor}: ${best.c.length} decls / ${best.lines} lines form a closed intra-file reference component`,
  };
}

// ---------------------------------------------------------------------------
// Mechanical applier
// ---------------------------------------------------------------------------

export function applySeamExtraction(project: Project, seam: SeamExtraction): void {
  const sf = project.getSourceFile(seam.file);
  if (!sf) throw new Error(`seam-extraction: file not in project: ${seam.file}`);
  if (dirOf(seam.file) !== dirOf(seam.targetModule)) {
    throw new Error("seam-extraction: targetModule must be a SIBLING of file (relative imports copy verbatim)");
  }
  const moved = new Set(seam.symbols);
  const decls = collectTopLevel(sf);
  const byName = new Map(decls.map((d) => [d.name, d]));
  for (const s of seam.symbols) {
    if (!byName.has(s)) throw new Error(`seam-extraction: symbol not found at top level: ${s}`);
  }

  // Which import specifiers do the moved decls need? Replicate them verbatim.
  const neededImports = new Map<string, Set<string>>(); // moduleSpecifier -> names
  for (const s of seam.symbols) {
    for (const id of byName.get(s)!.node.getDescendantsOfKind(SyntaxKind.Identifier)) {
      const sym = id.getSymbol();
      if (!sym) continue;
      for (const d of sym.getDeclarations()) {
        const imp = d.getFirstAncestorByKind(SyntaxKind.ImportDeclaration);
        if (imp && imp.getSourceFile() === sf) {
          const spec = imp.getModuleSpecifierValue();
          const names = neededImports.get(spec) ?? new Set<string>();
          names.add(sym.getName());
          neededImports.set(spec, names);
        }
      }
    }
  }

  // Moved symbols on the file's public surface → re-export shim (computed
  // BEFORE removal, while the export table still sees them).
  const exportedFromFile = new Set(
    [...sf.getExportedDeclarations().keys()].filter((n) => moved.has(n)),
  );

  // 1. Target module: imports + moved decls (each exported).
  const importLines = [...neededImports.entries()]
    .map(([spec, names]) => `import { ${[...names].sort().join(", ")} } from ${JSON.stringify(spec)};`)
    .join("\n");
  // getText(true) carries leading JSDoc with the declaration — a maintenance
  // move must not strand doc comments in the source file.
  const stmtText = (n: Node): string =>
    Node.isVariableDeclaration(n) ? n.getVariableStatementOrThrow().getText(true) : n.getText(true);
  const movedTexts = seam.symbols.map((s) => ensureExported(stmtText(byName.get(s)!.node)));
  project.createSourceFile(
    seam.targetModule,
    `${importLines ? importLines + "\n\n" : ""}${movedTexts.join("\n\n")}\n`,
  );

  // 2. Source file: delete moved decls, add shim edges.
  for (const s of seam.symbols) {
    const info = byName.get(s)!;
    const stmt = Node.isVariableDeclaration(info.node)
      ? info.node.getVariableStatementOrThrow()
      : info.node;
    (stmt as unknown as { remove(): void }).remove();
  }
  // Moved symbols referenced ANYWHERE in the remaining file → shim import.
  // Scanned post-removal over the WHOLE file (not just named top-level decls):
  // loose-bag fossils reference helpers from unnamed statements like
  // `app.get("/route", handler)`, which a decl-graph scan misses — the gate
  // caught exactly that on the first real dry-run (TS2304 → BLOCK).
  const usedByRemaining = new Set<string>();
  for (const id of sf.getDescendantsOfKind(SyntaxKind.Identifier)) {
    const t = id.getText();
    if (!moved.has(t)) continue;
    const par = id.getParent();
    if (par && Node.isPropertyAccessExpression(par) && par.getNameNode() === id) continue; // obj.prop, not a binding
    usedByRemaining.add(t);
  }
  const targetBase = "./" + baseNameNoExt(seam.targetModule);
  if (usedByRemaining.size > 0) {
    sf.insertStatements(0, `import { ${[...usedByRemaining].sort().join(", ")} } from ${JSON.stringify(targetBase)};`);
  }
  if (exportedFromFile.size > 0) {
    sf.addStatements(`export { ${[...exportedFromFile].sort().join(", ")} } from ${JSON.stringify(targetBase)};`);
  }
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function collectTopLevel(sf: SourceFile): DeclInfo[] {
  const out: DeclInfo[] = [];
  const names = new Set<string>();
  const collect = (name: string, node: Node, exported: boolean): void => {
    if (names.has(name)) return; // overloads/merges: treat first as canonical
    names.add(name);
    out.push({ name, node, exported, lines: node.getEndLineNumber() - node.getStartLineNumber() + 1, refs: new Set() });
  };
  for (const stmt of sf.getStatements()) {
    if (Node.isImportDeclaration(stmt) || Node.isExportDeclaration(stmt) || Node.isExportAssignment(stmt)) continue;
    if (Node.isVariableStatement(stmt)) {
      for (const d of stmt.getDeclarations()) collect(d.getName(), d, stmt.isExported());
      continue;
    }
    if (
      Node.isFunctionDeclaration(stmt) ||
      Node.isClassDeclaration(stmt) ||
      Node.isInterfaceDeclaration(stmt) ||
      Node.isTypeAliasDeclaration(stmt) ||
      Node.isEnumDeclaration(stmt)
    ) {
      const n = stmt.getName();
      if (n) collect(n, stmt, stmt.isExported());
    }
  }
  const nameSet = new Set(out.map((d) => d.name));
  for (const d of out) {
    for (const id of d.node.getDescendantsOfKind(SyntaxKind.Identifier)) {
      const t = id.getText();
      if (t !== d.name && nameSet.has(t)) d.refs.add(t);
    }
  }
  return out;
}

function ensureExported(text: string): string {
  const t = text.trimStart();
  if (/^export\s/.test(t)) return text;
  return `export ${text}`;
}

function dirOf(p: string): string {
  return p.slice(0, p.lastIndexOf("/"));
}

function baseNameNoExt(p: string): string {
  const base = p.slice(p.lastIndexOf("/") + 1);
  return base.replace(/\.tsx?$/, "");
}

function kebab(name: string): string {
  return name.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase().replace(/[^a-z0-9-]/g, "-");
}
