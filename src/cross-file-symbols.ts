/**
 * Give the drafter the declaration of a symbol the goal names but the window
 * does not contain.
 *
 * THE OBSERVED CASE (2026-08-11). A goal asked for a guard using a predicate the
 * vessel already owned. The drafter routed correctly, found the file, found the
 * exact line, and wrote the right shape of change:
 *
 *   - if (reached) arm.alpha += 1; else arm.beta += 1;
 *   + if (reached) arm.alpha += 1; else if (!isFailoverError()) arm.beta += 1;
 *
 * Then it failed on two facts it was never shown: `isFailoverError` TAKES AN
 * ARGUMENT, and it is declared in a different file. It searched for them
 * (`code_find_import` -> found:false), invented `../error-types`, appended `.js`,
 * and finally commented out its own import. Every step was faithful work on the
 * only text available.
 *
 * The grounding window is built from the TARGET files, so a symbol declared
 * elsewhere is structurally invisible — no amount of model quality substitutes
 * for a fact that was never shown, because a better model guesses more plausibly
 * rather than more correctly. This is law 8: make the load-bearing fact available
 * at the moment of use.
 *
 * DELIBERATELY NARROW. Only symbols that (a) look like identifiers, (b) actually
 * appear in the spec, and (c) do NOT already appear in the window are looked up,
 * capped at a handful. A symbol already in the window needs nothing; a bare
 * English word is not a symbol. The block is advisory context, never an
 * instruction to use the symbol.
 */

/** Common prose words that survive the identifier shape test — never symbols. */
const NOT_SYMBOLS = new Set([
  "javascript", "typescript", "undefined", "function", "constant", "variable",
  "parameter", "argument", "increment", "predicate", "provider", "selection",
  "posterior", "reachable", "unreachable", "registry", "endpoint", "discovery",
  "capable", "outcome", "quality", "failure", "billing", "however", "because",
  "instead", "already", "currently", "genuine", "genuinely", "therefore",
]);

/**
 * Identifier-shaped tokens: camelCase, snake_case, or dotted member access.
 *
 * A bare lowercase word is excluded on purpose — it is far more likely to be
 * prose than a symbol, and a wrong lookup spends a search and adds noise to the
 * window. camelCase/snake_case are the shapes that reliably name real code.
 */
function looksLikeIdentifier(t: string): boolean {
  if (t.length < 5 || t.length > 60) return false;
  if (NOT_SYMBOLS.has(t.toLowerCase())) return false;
  const camel = /^[a-z][A-Za-z0-9]*[A-Z][A-Za-z0-9]*$/.test(t);
  const snake = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)+$/.test(t);
  return camel || snake;
}

/**
 * Which symbols named in the spec are missing from the grounding window?
 *
 * @param spec       the drafting instruction handed to the planner
 * @param grounding  the assembled window the planner will see
 * @param limit      max symbols to look up (each costs one search)
 */
export function symbolsNeedingDeclaration(
  spec: string,
  grounding: string,
  limit = 3,
): string[] {
  if (typeof spec !== "string" || spec.length === 0) return [];
  const g = typeof grounding === "string" ? grounding : "";
  const seen = new Set<string>();
  const out: string[] = [];
  // Strip fenced/inline code spans? No — a symbol in backticks is the STRONGEST
  // signal it is a symbol, and the observed case had it in backticks.
  for (const raw of spec.match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? []) {
    if (seen.has(raw)) continue;
    seen.add(raw);
    if (!looksLikeIdentifier(raw)) continue;
    // Already visible to the drafter — nothing to add.
    if (g.includes(raw)) continue;
    out.push(raw);
    if (out.length >= limit) break;
  }
  return out;
}

/** One resolved declaration: where a symbol lives and how to call it. */
export interface SymbolDeclaration {
  readonly symbol: string;
  /** repo-relative path, e.g. repos/llm-resolver-vessel/src/provider-errors.ts */
  readonly file: string;
  /** the declaration line, trimmed */
  readonly line: string;
}

/**
 * Render the declarations as a compact context block.
 *
 * Includes the import specifier explicitly, because the observed failure invented
 * a module path — knowing WHERE a symbol lives is exactly half the missing fact,
 * and the drafter cannot derive the specifier from a bare file path reliably.
 *
 * Returns "" for an empty list so the caller can concatenate unconditionally.
 */
export function renderSymbolDeclarations(
  decls: readonly SymbolDeclaration[],
  targetFile: string,
  budget = 1200,
): string {
  if (!decls || decls.length === 0) return "";
  const lines: string[] = [
    "",
    "## SYMBOLS THE REQUEST NAMES THAT ARE DECLARED IN OTHER FILES",
    "Use these EXACT signatures and import paths. Do not invent a module path.",
  ];
  for (const d of decls) {
    lines.push(`- ${d.symbol} — declared in ${d.file}`);
    lines.push(`    ${d.line}`);
    const spec = importSpecifier(targetFile, d.file);
    if (spec) lines.push(`    import { ${d.symbol} } from "${spec}";`);
  }
  const block = lines.join("\n");
  return block.length > budget ? block.slice(0, budget) + "\n    …(truncated)" : block;
}

/**
 * Relative ESM specifier from the target file to the declaring file.
 *
 * `.ts` becomes `.js` because this codebase compiles to ESM and imports carry the
 * emitted extension — the observed failure got this wrong in both directions
 * (first no extension, then `.js` on a path that did not exist).
 */
export function importSpecifier(fromFile: string, toFile: string): string {
  if (!fromFile || !toFile) return "";
  const fromParts = fromFile.split("/").slice(0, -1);
  const toParts = toFile.split("/");
  const toName = (toParts.pop() ?? "").replace(/\.tsx?$/, ".js");
  let i = 0;
  while (i < fromParts.length && i < toParts.length && fromParts[i] === toParts[i]) i++;
  const up = fromParts.length - i;
  const down = toParts.slice(i);
  const prefix = up === 0 ? "./" : "../".repeat(up);
  return `${prefix}${[...down, toName].join("/")}`;
}

/**
 * Type names mentioned in a declaration line, so they can be resolved one hop out.
 *
 * THE OBSERVED CASE (2026-08-11). Cross-file grounding gave the drafter the
 * helper's declaration:
 *
 *   export function pickSatisfierProducer(producers: SatisfierProducer[]): SatisfierProducer | undefined
 *
 * It then wrote the call correctly and failed to compile:
 *
 *   TS2345: '{ endpoint?: string }[] | undefined' is not assignable to 'SatisfierProducer[]'
 *
 * The signature told it WHAT to call and nothing about the type in that signature,
 * so it could not know the cast the existing call sites use. Handing over a
 * function without its parameter types is the same information gap one level up —
 * a name whose meaning lives in another file.
 *
 * Capitalised identifiers only, and built-ins excluded: a lowercase token in a
 * signature is a parameter name, not a type, and resolving `string` teaches
 * nothing. Depth ONE by construction — this is called on declaration lines, never
 * on its own output, so a chain of types cannot fan out.
 */
const BUILTIN_TYPES = new Set([
  "String", "Number", "Boolean", "Object", "Array", "Promise", "Record", "Partial",
  "Readonly", "ReadonlyArray", "Map", "Set", "Date", "RegExp", "Error", "JSON",
  "Function", "Symbol", "BigInt", "Uint8Array", "Buffer", "Request", "Response",
]);

export function typeNamesIn(declarationLine: string): string[] {
  if (typeof declarationLine !== "string" || declarationLine.length === 0) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const m of declarationLine.matchAll(/\b([A-Z][A-Za-z0-9_]{2,})\b/g)) {
    const t = m[1]!;
    if (seen.has(t) || BUILTIN_TYPES.has(t)) continue;
    seen.add(t);
    out.push(t);
  }
  return out;
}
