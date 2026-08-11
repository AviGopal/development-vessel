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
    // PRESENCE OF THE NAME IS NOT PRESENCE OF THE DECLARATION.
    //
    // This originally skipped any symbol whose name appeared anywhere in the
    // window. Measured 2026-08-11, and it disabled the fix for the exact case it
    // was written for: the window was index.ts, which contains
    // `pickSatisfierProducer` three times — an import and two call sites — while
    // its DECLARATION lives in satisfier-pick.ts. The symbol read as "already
    // visible", nothing was resolved, and the drafter still had no signature and
    // no parameter type. It then wrote a call that failed TS2345.
    //
    // A call site tells the drafter the name exists; only a declaration tells it
    // what to pass. Skip only when the window actually shows the declaration.
    if (declarationVisible(g, raw)) continue;
    out.push(raw);
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * Does the window already show this symbol's DECLARATION (not merely a mention)?
 *
 * Call sites and imports name a symbol without saying anything about its shape,
 * so they must not suppress a lookup. Matches the declaration forms this codebase
 * uses, anchored to a line start so an import cannot satisfy it.
 */
function declarationVisible(grounding: string, name: string): boolean {
  if (!grounding || !name) return false;
  const n = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(
    `^[\\t ]*(?:export[\\t ]+)?(?:async[\\t ]+)?(?:function|const|let|var|class|interface|type)[\\t ]+${n}\\b`,
    "m",
  ).test(grounding);
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

/**
 * Lines that occur EXACTLY ONCE in a file — anchors an edit can safely bind to.
 *
 * THE OBSERVED CASE (2026-08-11). The compose prompt already says an `old_string`
 * "must be copied VERBATIM and be UNIQUE in the target file. Keep it SHORT (the
 * fewest lines, ideally one, that are still unique)". A drafter optimised for
 * SHORT and lost UNIQUE: it anchored on `verdict = String(body.verdict ?? "");`,
 * which occurs twice, and apply refused —
 *
 *   no_unique_anchor: planned anchor is non-unique and re-derivation found no
 *   unique substring (would mislocalize to first occurrence)
 *
 * The refusal is correct; editing the wrong occurrence is worse. But the
 * instruction asks the model to VERIFY a property of a file it is seeing in
 * excerpt, which it cannot do reliably — uniqueness is a whole-file fact and the
 * window is a fragment. That is law 8: the fix is not a firmer instruction, it is
 * making the fact available at the moment of use.
 *
 * So compute it and hand it over. Deterministic, cheap, and it removes the need
 * for the model to check anything.
 *
 * Trimmed lines are compared, because that is what an anchor match uses; blank
 * lines, bare braces and comment-only lines are skipped since none of them is a
 * useful anchor even when unique.
 */
export function uniqueAnchorLines(fileText: string, limit = 40): string[] {
  if (typeof fileText !== "string" || fileText.length === 0) return [];
  const counts = new Map<string, number>();
  const order: string[] = [];
  for (const raw of fileText.split("\n")) {
    const t = raw.trim();
    if (t.length < 12 || t.length > 160) continue;
    if (t.startsWith("//") || t.startsWith("*") || t.startsWith("/*")) continue;
    if (/^[{}()\[\];,]+$/.test(t)) continue;
    if (!counts.has(t)) order.push(t);
    counts.set(t, (counts.get(t) ?? 0) + 1);
  }
  const out: string[] = [];
  for (const t of order) {
    if (counts.get(t) === 1) out.push(t);
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * Is this anchor safe to bind an edit to?
 *
 * Returns the occurrence count so a caller can say WHY it refused. Exact
 * substring counting, matching how apply binds.
 */
export function anchorOccurrences(fileText: string, anchor: string): number {
  if (!fileText || !anchor) return 0;
  let n = 0;
  let i = fileText.indexOf(anchor);
  while (i !== -1) {
    n++;
    i = fileText.indexOf(anchor, i + Math.max(1, anchor.length));
  }
  return n;
}

/**
 * Render verified-unique anchors near the region as a compact block.
 *
 * Scoped to the region's vicinity rather than the whole file: a 13,000-line file
 * has thousands of unique lines and listing them would drown the window. The
 * drafter needs a handful of anchors it can trust AT the place it is editing.
 */
export function renderSafeAnchors(
  fileText: string,
  region: string,
  path: string,
  maxAnchors = 12,
  window = 80,
): string {
  if (!fileText || !path) return "";
  const lines = fileText.split("\n");
  let center = region ? lines.findIndex((l) => l.includes(region)) : -1;
  if (center < 0) center = Math.floor(lines.length / 2);
  const lo = Math.max(0, center - window);
  const hi = Math.min(lines.length, center + window);
  const near = lines.slice(lo, hi).join("\n");
  const unique = uniqueAnchorLines(near, maxAnchors * 3)
    .filter((l) => anchorOccurrences(fileText, l) === 1)
    .slice(0, maxAnchors);
  if (unique.length === 0) return "";
  return [
    "",
    `## VERIFIED-UNIQUE ANCHORS in ${path} (near the region)`,
    "Each line below occurs EXACTLY ONCE in the file — copying one verbatim as",
    "`old_string` cannot mislocalize. Uniqueness is a whole-file property you",
    "cannot check from an excerpt, so it has been checked for you. If the line you",
    "need is not listed, include enough adjacent lines to make your anchor unique.",
    ...unique.map((l) => `    ${l}`),
  ].join("\n");
}
